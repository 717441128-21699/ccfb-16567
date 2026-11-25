/**
 * 多灯点跟踪：全局稳像 + 稳像坐标在线聚类。
 *
 * 为什么不用普通逐帧关联：航标灯暗期可能长达近一个周期（如周期 10s、明 0.5s），
 * 灭灯时连续上百帧没有任何观测，帧间 track 无法续接。
 * 船的摇晃对全画面是近似一致的平移，先用相邻帧亮斑的中位位移估计全局平移，
 * 把所有检测映射到稳像坐标；同一盏灯各次闪光在稳像坐标里聚到一起，即为一条轨迹。
 */
import { median } from './imageUtils';
import type { DetectedBlob, Track } from './types';

export interface TrackerOptions {
  /** 相邻帧全局位移估计的匹配门限（像素） */
  frameMatchDistance: number;
  /** 稳像坐标下亮斑归入已有聚簇的最大距离（像素） */
  clusterDistance: number;
  /** 一条轨迹至少命中多少帧才保留 */
  minHits: number;
}

interface Cluster {
  id: number;
  points: { x: number; y: number }[]; // 稳像坐标
  cx: number;
  cy: number;
  firstFrame: number;
  lastFrame: number;
}

export class MultiTracker {
  private readonly opts: TrackerOptions;
  private clusters: Cluster[] = [];
  private nextId = 1;
  /** 累计全局平移（原坐标 -> 稳像坐标：减 shift） */
  private shiftX = 0;
  private shiftY = 0;
  private prevBlobs: DetectedBlob[] = [];
  private frameCount = 0;

  // 每条轨迹的逐帧记录，按 cluster id 索引
  private positions: Map<number, ({ x: number; y: number } | null)[]> = new Map();
  private brightness: Map<number, number[]> = new Map();
  private colors: Map<number, { r: number; g: number; b: number }[]> = new Map();
  private times: number[] = [];
  readonly frameShifts: { x: number; y: number }[] = [];

  constructor(opts: TrackerOptions) {
    this.opts = opts;
  }

  /** 估计相邻帧全局平移：贪心最近邻匹配后取位移中位数 */
  private estimateShift(blobs: DetectedBlob[]): { x: number; y: number } {
    if (this.prevBlobs.length === 0 || blobs.length === 0) return { x: 0, y: 0 };
    const used = new Set<number>();
    const dxs: number[] = [];
    const dys: number[] = [];
    const candidates = blobs
      .map((b, i) => ({ b, i }))
      .sort((a, c) => a.b.intensity - c.b.intensity);
    for (const prev of this.prevBlobs) {
      let best = -1;
      let bestD = this.opts.frameMatchDistance;
      for (const { b, i } of candidates) {
        if (used.has(i)) continue;
        const d = Math.hypot(b.x - prev.x, b.y - prev.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        used.add(best);
        const b = blobs[best]!;
        dxs.push(b.x - prev.x);
        dys.push(b.y - prev.y);
      }
    }
    if (dxs.length < 2) return { x: 0, y: 0 };
    return { x: median(dxs), y: median(dys) };
  }

  /** 喂入一帧检测结果，t 为视频时间轴秒数 */
  update(blobs: DetectedBlob[], t: number): void {
    const shift = this.estimateShift(blobs);
    this.shiftX += shift.x;
    this.shiftY += shift.y;
    this.frameShifts.push({ x: this.shiftX, y: this.shiftY });
    this.times.push(t);

    const assigned = new Set<number>();
    // 本帧每个聚簇匹配到的最强亮斑（先算好，避免一个亮斑被多个聚簇重复吸收）
    const clusterMatch = new Map<number, { blob: DetectedBlob; d: number }>();
    const usedBlob = new Set<number>();
    for (const c of this.clusters) {
      let bestIdx = -1;
      let bestD = this.opts.clusterDistance;
      for (let bi = 0; bi < blobs.length; bi++) {
        if (usedBlob.has(bi)) continue;
        const b = blobs[bi]!;
        const d = Math.hypot(b.x - this.shiftX - c.cx, b.y - this.shiftY - c.cy);
        if (d < bestD) {
          bestD = d;
          bestIdx = bi;
        }
      }
      if (bestIdx >= 0) {
        usedBlob.add(bestIdx);
        clusterMatch.set(c.id, { blob: blobs[bestIdx]!, d: bestD });
        // 增量更新稳像质心
        const sx = blobs[bestIdx]!.x - this.shiftX;
        const sy = blobs[bestIdx]!.y - this.shiftY;
        c.points.push({ x: sx, y: sy });
        c.cx += (sx - c.cx) / c.points.length;
        c.cy += (sy - c.cy) / c.points.length;
        c.lastFrame = this.frameCount;
      }
    }

    for (let bi = 0; bi < blobs.length; bi++) {
      if (usedBlob.has(bi)) continue;
      const blob = blobs[bi]!;
      const sx = blob.x - this.shiftX;
      const sy = blob.y - this.shiftY;
      const cluster: Cluster = {
        id: this.nextId++,
        points: [{ x: sx, y: sy }],
        cx: sx,
        cy: sy,
        firstFrame: this.frameCount,
        lastFrame: this.frameCount,
      };
      this.clusters.push(cluster);
      this.positions.set(cluster.id, []);
      this.brightness.set(cluster.id, []);
      this.colors.set(cluster.id, []);
      clusterMatch.set(cluster.id, { blob, d: 0 });
    }
    for (const id of clusterMatch.keys()) assigned.add(id);

    for (const c of this.clusters) {
      const pos = this.positions.get(c.id)!;
      const bri = this.brightness.get(c.id)!;
      const col = this.colors.get(c.id)!;
      const match = clusterMatch.get(c.id);
      if (match) {
        pos.push({ x: match.blob.x, y: match.blob.y });
        bri.push(match.blob.intensity);
        col.push({ r: match.blob.r, g: match.blob.g, b: match.blob.b });
      } else {
        // 本帧该灯无检测（灭灯）：严格置零，保留时间槽
        pos.push(null);
        bri.push(0);
        col.push({ r: 0, g: 0, b: 0 });
      }
    }

    this.prevBlobs = blobs;
    this.frameCount++;
  }

  /** 输出达到最小命中数的轨迹 */
  buildTracks(): Track[] {
    const tracks: Track[] = [];
    for (const c of this.clusters) {
      const positions = this.positions.get(c.id)!;
      const brightness = this.brightness.get(c.id)!;
      const colors = this.colors.get(c.id)!;
      const hits = positions.reduce((n, p) => n + (p ? 1 : 0), 0);
      if (hits < this.opts.minHits) continue;
      let firstFrame = -1;
      let lastFrame = -1;
      let sx = 0;
      let sy = 0;
      positions.forEach((p, i) => {
        if (p) {
          if (firstFrame < 0) firstFrame = i;
          lastFrame = i;
          sx += p.x;
          sy += p.y;
        }
      });
      tracks.push({
        id: c.id,
        positions,
        brightness,
        colors,
        times: [...this.times],
        firstFrame,
        lastFrame,
        hits,
        cx: sx / hits,
        cy: sy / hits,
      });
    }
    return tracks.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  }

  get frameCount_(): number {
    return this.frameCount;
  }
}
