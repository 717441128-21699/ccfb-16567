/**
 * 轨迹后处理合并：大浪/浓雾下同一盏灯可能被数据关联分裂成多条
 * 时间重叠、位置重合的轨迹。按质心距离聚类，把同簇轨迹的观测
 * 拼回一条完整轨迹（亮度/颜色按帧归并，位置取均值）。
 */
import type { Track } from './types';

export interface MergeOptions {
  /** 质心距离阈值（像素），小于该值视为同一灯 */
  distPx?: number;
  /** 最小观测帧数，低于此值的碎轨迹优先被吸收 */
  minObs?: number;
}

function centroid(t: Track): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of t.positions) {
    if (p) {
      sx += p.x;
      sy += p.y;
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : null;
}

/** 并查集 */
class Dsu {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]!]!;
      x = this.parent[x]!;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function timeOverlap(a: Track, b: Track): number {
  const aFirst = a.positions.findIndex((p) => p !== null);
  const aLast = a.positions.length - 1 - [...a.positions].reverse().findIndex((p) => p !== null);
  const bFirst = b.positions.findIndex((p) => p !== null);
  const bLast = b.positions.length - 1 - [...b.positions].reverse().findIndex((p) => p !== null);
  return Math.max(0, Math.min(aLast, bLast) - Math.max(aFirst, bFirst) + 1);
}

export function mergeTracks(tracks: Track[], opts: MergeOptions = {}): Track[] {
  const distPx = opts.distPx ?? 24;
  const centroids = tracks.map(centroid);
  const dsu = new Dsu(tracks.length);

  // 质心接近且时间显著重叠的轨迹才归为一簇（避免合并相邻的不同灯）
  for (let i = 0; i < tracks.length; i++) {
    if (!centroids[i]) continue;
    for (let j = i + 1; j < tracks.length; j++) {
      if (!centroids[j]) continue;
      const d = Math.hypot(centroids[i]!.x - centroids[j]!.x, centroids[i]!.y - centroids[j]!.y);
      if (d > distPx) continue;
      const overlap = timeOverlap(tracks[i]!, tracks[j]!);
      const shorter = Math.min(
        tracks[i]!.positions.filter((p) => p !== null).length,
        tracks[j]!.positions.filter((p) => p !== null).length,
      );
      // 重叠帧占较短轨迹的一半以上才认为是同一灯的分裂轨迹
      if (shorter > 0 && overlap / shorter >= 0.5) dsu.union(i, j);
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < tracks.length; i++) {
    const root = dsu.find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }

  const merged: Track[] = [];
  for (const idxs of clusters.values()) {
    if (idxs.length === 1) {
      merged.push(tracks[idxs[0]!]!);
      continue;
    }
    merged.push(combineTracks(idxs.map((i) => tracks[i]!)));
  }
  return merged;
}

/** 把同簇多条轨迹按帧拼回一条 */
function combineTracks(group: Track[]): Track {
  const len = Math.max(...group.map((t) => t.positions.length));
  const positions: Track['positions'] = new Array(len).fill(null);
  const brightness: Track['brightness'] = new Array(len).fill(null);
  const colors: Track['colors'] = new Array(len).fill(null);
  let hitCount = 0;
  let firstFrame = len;
  let lastSeenFrame = 0;

  for (const t of group) {
    for (let f = 0; f < t.positions.length; f++) {
      const p = t.positions[f];
      if (!p) continue;
      if (!positions[f]) {
        positions[f] = { x: p.x, y: p.y };
      } else {
        positions[f] = { x: (positions[f]!.x + p.x) / 2, y: (positions[f]!.y + p.y) / 2 };
      }
      if (t.brightness[f] !== null && t.brightness[f] !== undefined && brightness[f] === null) {
        brightness[f] = t.brightness[f]!;
        colors[f] = t.colors[f] ?? null;
      }
    }
    hitCount += t.hitCount;
    firstFrame = Math.min(firstFrame, t.firstFrame);
    lastSeenFrame = Math.max(lastSeenFrame, t.lastSeenFrame);
  }

  // 以簇内观测最完整的轨迹为模板保留确认/干扰状态
  const primary = [...group].sort((a, b) => b.hitCount - a.hitCount)[0]!;
  return {
    id: primary.id,
    positions,
    brightness,
    colors,
    firstFrame,
    lastSeenFrame,
    hitCount,
    confirmed: group.some((t) => t.confirmed),
    rejected: primary.rejected,
    steady: group.some((t) => t.steady),
  };
}
