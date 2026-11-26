/**
 * 多目标灯点跟踪（原始坐标 GNN 版）：
 *
 * 夜间灯点稀疏、帧间船晃位移有限，直接在画面原始坐标做全局最近邻
 * 关联最稳健，避免运动补偿残余与速度预测叠加导致的轨迹漂移。
 * - 全局最近邻贪心匹配 + 代价门控；
 * - 未匹配 blob 远离存活轨迹才出生，防止闪烁重亮时碎裂；
 * - 断航保留预测位（速度 EMA），长暗后速度归零原位等待；
 * - 倒影 blob 不生轨迹；常亮干扰只标记不删除（常亮航标同形态）。
 * 全局船晃仍做估计并输出，供 UI 画抖动指示。
 */
import type { Blob, Frame, Track, TrackRejection } from './types';

export interface TrackerOptions {
  motionSearchPx?: number;
  /** 关联接受门限（原始像素） */
  gatePx?: number;
  /** 新轨迹出生门限：距任何存活轨迹的最小距离 */
  birthDistPx?: number;
  maxMissed?: number;
  confirmHits?: number;
  horizonRatio?: number;
  reflectionAspect?: number;
  steadyDuty?: number;
  steadyCv?: number;
}

interface InternalTrack extends Track {
  missed: number;
  velX: number;
  velY: number;
  reflectionFrames: number;
  observedFrames: number;
}

export class MultiTracker {
  readonly tracks: InternalTrack[] = [];
  readonly globalShifts: { dx: number; dy: number }[] = [];
  private nextId = 1;
  private prevBlobs: Blob[] = [];
  private opts: Required<TrackerOptions>;

  constructor(opts: TrackerOptions = {}) {
    this.opts = {
      motionSearchPx: opts.motionSearchPx ?? 40,
      gatePx: opts.gatePx ?? 38,
      birthDistPx: opts.birthDistPx ?? 30,
      // 覆盖最长暗段（12s 周期长闪约 10s 暗），10fps 下保留 120 帧
      maxMissed: opts.maxMissed ?? 120,
      confirmHits: opts.confirmHits ?? 4,
      horizonRatio: opts.horizonRatio ?? 0.62,
      reflectionAspect: opts.reflectionAspect ?? 2.0,
      steadyDuty: opts.steadyDuty ?? 0.985,
      steadyCv: opts.steadyCv ?? 0.08,
    };
  }

  private isReflection(b: Blob, height: number): boolean {
    const belowHorizon = b.cy > height * this.opts.horizonRatio;
    return belowHorizon && (b.aspect > this.opts.reflectionAspect || (b.extent < 0.45 && b.aspect > 1.4));
  }

  /** 位移直方图投票估计全局抖动（仅作指示输出，不参与坐标换算） */
  private estimateGlobalMotion(blobs: Blob[]): { dx: number; dy: number } {
    if (this.prevBlobs.length === 0 || blobs.length === 0) return { dx: 0, dy: 0 };
    const r2 = this.opts.motionSearchPx ** 2;
    const dxs: number[] = [];
    const dys: number[] = [];
    for (const b of blobs) {
      let best: Blob | null = null;
      let bestD = r2;
      for (const p of this.prevBlobs) {
        const d = (b.cx - p.cx) ** 2 + (b.cy - p.cy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) {
        dxs.push(b.cx - best.cx);
        dys.push(b.cy - best.cy);
      }
    }
    if (dxs.length < 3) return { dx: 0, dy: 0 };
    const bin = 2;
    const votes = new Map<string, { sx: number; sy: number; n: number }>();
    let bestKey = '';
    let bestN = 0;
    for (let i = 0; i < dxs.length; i++) {
      const key = `${Math.round(dxs[i]! / bin)},${Math.round(dys[i]! / bin)}`;
      const e = votes.get(key) ?? { sx: 0, sy: 0, n: 0 };
      e.sx += dxs[i]!;
      e.sy += dys[i]!;
      e.n++;
      votes.set(key, e);
      if (e.n > bestN) {
        bestN = e.n;
        bestKey = key;
      }
    }
    const winner = votes.get(bestKey)!;
    return { dx: winner.sx / winner.n, dy: winner.sy / winner.n };
  }

  update(blobs: Blob[], frame: Frame): { dx: number; dy: number } {
    const shift = this.estimateGlobalMotion(blobs);
    this.globalShifts.push(shift);
    const frameIdx = frame.index;

    const usable = blobs.map((b) => ({
      blob: b,
      x: b.cx,
      y: b.cy,
      used: false,
      reflection: this.isReflection(b, frame.height),
    }));
    const candidates = usable.filter((c) => !c.reflection);

    for (const t of this.tracks) this.pushNull(t, frameIdx);

    const active = this.tracks.filter((t) => t.missed <= this.opts.maxMissed);
    const gate2 = this.opts.gatePx ** 2;
    // 两轮匹配：第一轮用速度预测，第二轮对仍未命中的轨迹放宽到上次实测位置+大门限
    const edges: { t: InternalTrack; ci: number; d: number; relaxed: boolean }[] = [];
    for (const t of active) {
      const last = this.lastPosition(t);
      const velScale = t.missed > 3 ? 0 : 1;
      const px = last.x + t.velX * velScale;
      const py = last.y + t.velY * velScale;
      for (let ci = 0; ci < candidates.length; ci++) {
        const c = candidates[ci]!;
        const d = (c.x - px) ** 2 + (c.y - py) ** 2;
        if (d <= gate2) edges.push({ t, ci, d, relaxed: false });
      }
    }
    edges.sort((a, b) => a.d - b.d);
    const matchedTracks = new Set<number>();
    for (const e of edges) {
      if (matchedTracks.has(e.t.id) || candidates[e.ci]!.used) continue;
      matchedTracks.add(e.t.id);
      const c = candidates[e.ci]!;
      c.used = true;
      // 航标为静止目标：命中即吸附实测坐标，速度仅保留弱 EMA 供断航期预测
      e.t.velX = 0.75 * e.t.velX + 0.25 * (c.x - this.lastPosition(e.t).x);
      e.t.velY = 0.75 * e.t.velY + 0.25 * (c.y - this.lastPosition(e.t).y);
      this.assign(e.t, c.x, c.y, c.blob, frameIdx, c.reflection);
    }

    // 第二轮：断航后重亮的灯可能偏离预测点，回到上次实测位置附近宽松搜索
    const relaxGate2 = (this.opts.gatePx * 1.8) ** 2;
    const relaxed: { t: InternalTrack; ci: number; d: number }[] = [];
    for (const t of active) {
      if (matchedTracks.has(t.id)) continue;
      const last = this.lastPosition(t);
      for (let ci = 0; ci < candidates.length; ci++) {
        const c = candidates[ci]!;
        if (c.used) continue;
        const d = (c.x - last.x) ** 2 + (c.y - last.y) ** 2;
        if (d <= relaxGate2) relaxed.push({ t, ci, d });
      }
    }
    relaxed.sort((a, b) => a.d - b.d);
    for (const e of relaxed) {
      if (matchedTracks.has(e.t.id) || candidates[e.ci]!.used) continue;
      matchedTracks.add(e.t.id);
      const c = candidates[e.ci]!;
      c.used = true;
      e.t.velX = 0;
      e.t.velY = 0;
      this.assign(e.t, c.x, c.y, c.blob, frameIdx, c.reflection);
    }

    for (const t of active) {
      if (!matchedTracks.has(t.id)) t.missed++;
    }

    // 出生：远离所有存活轨迹（含断航中的预测位）
    for (const c of candidates) {
      if (c.used) continue;
      let tooClose = false;
      for (const t of active) {
        const p = this.lastPosition(t);
        if ((c.x - p.x) ** 2 + (c.y - p.y) ** 2 < this.opts.birthDistPx ** 2) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      const t: InternalTrack = {
        id: this.nextId++,
        positions: new Array(frameIdx).fill(null),
        brightness: new Array(frameIdx).fill(null),
        colors: new Array(frameIdx).fill(null),
        lastSeenFrame: frameIdx,
        firstFrame: frameIdx,
        hitCount: 0,
        confirmed: false,
        rejected: null,
        missed: 0,
        velX: 0,
        velY: 0,
        reflectionFrames: 0,
        observedFrames: 0,
      };
      this.assign(t, c.x, c.y, c.blob, frameIdx, false);
      this.tracks.push(t);
    }

    for (let i = this.tracks.length - 1; i >= 0; i--) {
      if (this.tracks[i]!.missed > this.opts.maxMissed) this.tracks.splice(i, 1);
    }

    this.prevBlobs = blobs;
    this.tagTracks();
    return shift;
  }

  private lastPosition(t: InternalTrack): { x: number; y: number } {
    for (let i = t.positions.length - 1; i >= 0; i--) {
      const p = t.positions[i];
      if (p) return p;
    }
    return { x: 0, y: 0 };
  }

  private assign(
    t: InternalTrack,
    x: number,
    y: number,
    blob: Blob,
    frameIdx: number,
    reflection: boolean,
  ): void {
    t.positions[frameIdx] = { x, y };
    t.brightness[frameIdx] = blob.brightness;
    t.colors[frameIdx] = { r: blob.r, g: blob.g, b: blob.b };
    t.lastSeenFrame = frameIdx;
    t.hitCount++;
    t.missed = 0;
    t.observedFrames++;
    if (reflection) t.reflectionFrames++;
    if (t.hitCount >= this.opts.confirmHits) t.confirmed = true;
  }

  private pushNull(t: InternalTrack, frameIdx: number): void {
    while (t.positions.length <= frameIdx) {
      t.positions.push(null);
      t.brightness.push(null);
      t.colors.push(null);
    }
  }

  private tagTracks(): void {
    for (const t of this.tracks) {
      if (t.observedFrames >= 4 && t.reflectionFrames / t.observedFrames > 0.6) {
        t.rejected = 'reflection';
        continue;
      }
      const vals = t.brightness.filter((v): v is number => v !== null);
      t.steady = false;
      if (vals.length >= 20) {
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
        const cv = sd / Math.max(m, 1);
        const duty = vals.length / t.brightness.length;
        // 常亮形态：占空很高（≥0.85）且亮度稳定、颜色单一。
        // 闪烁灯即使轨迹合并，占空也难到 0.85（有真实暗段）。
        if (duty >= 0.85 && cv <= 0.3) {
          const colorVals = t.colors.filter((c): c is NonNullable<(typeof t.colors)[number]> => c !== null);
          let singleHue = true;
          if (colorVals.length >= 10) {
            const redish = colorVals.filter((c) => c.r / Math.max(c.g, 1) > 1.6 && c.r > c.b).length;
            const greenish = colorVals.filter((c) => c.g / Math.max(c.r, 1) > 1.4 && c.g > c.b).length;
            // 同时出现显著红/绿相和其它色相 → 互光，不是常亮
            if (redish >= 5 && colorVals.length - redish >= 5) singleHue = false;
            if (greenish >= 5 && colorVals.length - greenish >= 5) singleHue = false;
          }
          if (singleHue) t.steady = true;
        }
      }
      if (t.hitCount >= this.opts.confirmHits) {
        t.confirmed = true;
        if (t.rejected === 'too-short') t.rejected = null;
      } else if (!t.confirmed) {
        t.rejected = t.rejected ?? 'too-short';
      }
    }
  }
}

export type { TrackRejection };
