/**
 * 灯点检测：夜间画面自适应阈值 + 连通域分析 + 形态特征。
 * 纯函数、无 DOM，可在 Worker 与 Node 中运行。
 */
import type { Blob, Frame } from './types';

export interface DetectOptions {
  /** 最低绝对阈值（灰度） */
  minThreshold?: number;
  /** 相对均值的标准差倍数 */
  sigmaK?: number;
  /** 最小连通域面积（像素） */
  minArea?: number;
  /** 最大连通域面积占画面比例 */
  maxAreaRatio?: number;
}

interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  sumGray: number;
  sumR: number;
  sumG: number;
  sumB: number;
}

/** 计算灰度图与自适应阈值 */
export function grayscaleAndThreshold(frame: Frame, opts: DetectOptions = {}): { gray: Uint8Array; threshold: number } {
  const { width, height, data } = frame;
  const n = width * height;
  const gray = new Uint8Array(n);
  let sum = 0;
  let sumSq = 0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    // Rec.601 亮度
    const g = (data[p]! * 299 + data[p + 1]! * 587 + data[p + 2]! * 114) / 1000;
    gray[i] = g;
    sum += g;
    sumSq += g * g;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  const sd = Math.sqrt(variance);
  // 浓雾下整体对比度低，sigmaK 略降以捕获弱灯点；下限 45 避免背景噪声
  const threshold = Math.max(opts.minThreshold ?? 45, Math.min(225, mean + (opts.sigmaK ?? 4.0) * sd));
  return { gray, threshold };
}

/** 两趟连通域（4 邻接 + 并查集），输出灯点候选 */
export function detectBlobs(frame: Frame, opts: DetectOptions = {}): Blob[] {
  const { width, height } = frame;
  const n = width * height;
  const { gray, threshold } = grayscaleAndThreshold(frame, opts);
  const labels = new Int32Array(n); // 0 表示背景
  const parent: number[] = [0];
  const comps: Component[] = [];

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== x) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): number => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    if (ra < rb) {
      parent[rb] = ra;
      return ra;
    }
    parent[ra] = rb;
    return rb;
  };
  const newComponent = (x: number, y: number, g: number, idx: number): number => {
    const id = comps.length + 1;
    parent[id] = id;
    const d = frame.data;
    comps.push({
      minX: x, maxX: x, minY: y, maxY: y, area: 1,
      sumGray: g, sumR: d[idx]!, sumG: d[idx + 1]!, sumB: d[idx + 2]!,
    });
    return id;
  };

  // 第一趟：标号与合并
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      if (gray[i]! < threshold) continue;
      const up = y > 0 ? labels[i - width]! : 0;
      const left = x > 0 ? labels[i - 1]! : 0;
      let id: number;
      if (up === 0 && left === 0) {
        id = newComponent(x, y, gray[i]!, i * 4);
      } else if (up !== 0 && left === 0) {
        id = find(up);
      } else if (up === 0 && left !== 0) {
        id = find(left);
      } else {
        id = union(up, left);
      }
      labels[i] = id;
    }
  }

  // 第二趟：聚合计数
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const raw = labels[i]!;
      if (raw === 0) continue;
      const root = find(raw);
      labels[i] = root;
      const c = comps[root - 1]!;
      const g = gray[i]!;
      const p = i * 4;
      c.area++;
      c.sumGray += g;
      c.sumR += frame.data[p]!;
      c.sumG += frame.data[p + 1]!;
      c.sumB += frame.data[p + 2]!;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
    }
  }

  const minArea = opts.minArea ?? 3;
  const maxArea = n * (opts.maxAreaRatio ?? 0.02);
  const blobs: Blob[] = [];
  let blobId = 0;
  for (let k = 0; k < comps.length; k++) {
    const c = comps[k]!;
    if (c.area < minArea || c.area > maxArea) continue;
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const aspect = bh / bw;
    const extent = c.area / (bw * bh);
    blobs.push({
      id: blobId++,
      cx: (c.minX + c.maxX) / 2,
      cy: (c.minY + c.maxY) / 2,
      area: c.area,
      minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
      brightness: c.sumGray / c.area,
      r: c.sumR / c.area,
      g: c.sumG / c.area,
      b: c.sumB / c.area,
      aspect,
      extent,
    });
  }
  return blobs;
}
