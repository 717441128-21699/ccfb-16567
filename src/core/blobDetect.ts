/**
 * 亮斑检测：灰度阈值分割 + 连通域（两遍并查集），输出亮斑质心、半径、亮度与平均颜色。
 * 对夜拍画面：航标灯是小而亮的高对比区域，路灯/船灯同样会被检出，
 * 排除干扰在跟踪后的 distractor 判定阶段完成（单帧无法区分）。
 */
import { luminance, type RgbaImage } from './imageUtils';
import type { DetectedBlob } from './types';

interface UnionFind {
  parent: Int32Array;
}

function makeUF(n: number): UnionFind {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  return { parent };
}

function find(uf: UnionFind, x: number): number {
  let root = x;
  while (uf.parent[root] !== root) root = uf.parent[root]!;
  while (uf.parent[x] !== root) {
    const next = uf.parent[x]!;
    uf.parent[x] = root;
    x = next;
  }
  return root;
}

function union(uf: UnionFind, a: number, b: number): void {
  const ra = find(uf, a);
  const rb = find(uf, b);
  if (ra !== rb) uf.parent[Math.max(ra, rb)] = Math.min(ra, rb);
}

export interface DetectOptions {
  /** 亮度阈值 0-255；传 0 或负数时对当前帧做 Otsu 自适应（带 floor 下限） */
  threshold: number;
  /** 自适应阈值下限，避免暗帧把噪声当灯 */
  adaptiveFloor?: number;
  /** 亮斑最小像素数（缩放画面） */
  minPixels?: number;
  /** 亮斑最大像素数，超过视为大片光污染（如近景船灯） */
  maxPixels?: number;
}

export function detectBlobs(img: RgbaImage, opts: DetectOptions): DetectedBlob[] {
  const { width: w, height: h, data } = img;
  const minPixels = opts.minPixels ?? 2;
  const maxPixels = opts.maxPixels ?? Math.floor(w * h * 0.02);

  // 阈值决策（单通道亮度，统计自适应）：
  // 灯光是画面里极少数高亮像素。用灰度直方图算背景中位数与标准差，
  // 阈值 = 中位数 + 3σ，再与配置下限取大值。
  // 晴天背景暗且集中 -> 被下限钳住；浓雾背景整体抬升 -> 阈值随之上移，灯芯仍在其上。
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    // 必须取整：luminance 返回浮点，直接做数组索引会落空，直方图统计失效
    const L = Math.round(luminance(data[o]!, data[o + 1]!, data[o + 2]!));
    hist[L]!++;
  }
  const totalPx = w * h;
  let cum = 0;
  let medianLum = 0;
  let meanLum = 0;
  for (let g = 0; g < 256; g++) {
    meanLum += g * hist[g]!;
    cum += hist[g]!;
    if (medianLum === 0 && cum >= totalPx / 2) medianLum = g;
  }
  meanLum /= totalPx;
  let variance = 0;
  for (let g = 0; g < 256; g++) {
    variance += (g - meanLum) ** 2 * hist[g]!;
  }
  const stdLum = Math.sqrt(variance / totalPx);
  const lumThreshold = Math.max(opts.threshold, medianLum + 3 * stdLum);

  const labels = new Int32Array(w * h);
  const uf = makeUF(w * h);
  let nextLabel = 1;

  // 第一遍：8 邻域标记
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const o = idx * 4;
      const lum = luminance(data[o]!, data[o + 1]!, data[o + 2]!);
      if (lum < lumThreshold) continue;
      const neighbors: number[] = [];
      if (x > 0 && labels[idx - 1]) neighbors.push(labels[idx - 1]!);
      if (y > 0 && labels[idx - w]) neighbors.push(labels[idx - w]!);
      if (x > 0 && y > 0 && labels[idx - w - 1]) neighbors.push(labels[idx - w - 1]!);
      if (x < w - 1 && y > 0 && labels[idx - w + 1]) neighbors.push(labels[idx - w + 1]!);
      if (neighbors.length === 0) {
        labels[idx] = nextLabel++;
      } else {
        let min = Infinity;
        for (const lb of neighbors) if (lb < min) min = lb;
        labels[idx] = min;
        for (const lb of neighbors) union(uf, lb, min);
      }
    }
  }

  if (nextLabel === 1) return [];

  // 第二遍：聚合统计量
  const rootOf = new Map<number, number>();
  const stats = new Map<number, {
    sumX: number; sumY: number; sumW: number; pixels: number;
    sumR: number; sumG: number; sumB: number; minX: number; maxX: number; minY: number; maxY: number;
  }>();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const lb = labels[idx]!;
      if (!lb) continue;
      const root = find(uf, lb);
      let compId = rootOf.get(root);
      if (compId === undefined) {
        compId = rootOf.size;
        rootOf.set(root, compId);
        stats.set(compId, {
          sumX: 0, sumY: 0, sumW: 0, pixels: 0,
          sumR: 0, sumG: 0, sumB: 0,
          minX: x, maxX: x, minY: y, maxY: y,
        });
      }
      const s = stats.get(compId)!;
      const o = idx * 4;
      const lum = luminance(data[o]!, data[o + 1]!, data[o + 2]!);
      // 亮度加权质心，抑制光晕边缘像素的漂移
      const weight = lum;
      s.sumX += x * weight;
      s.sumY += y * weight;
      s.sumW += weight;
      s.pixels++;
      s.sumR += data[o]!;
      s.sumG += data[o + 1]!;
      s.sumB += data[o + 2]!;
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
    }
  }

  const blobs: DetectedBlob[] = [];
  for (const s of stats.values()) {
    if (s.pixels < minPixels || s.pixels > maxPixels) continue;
    const cx = s.sumX / s.sumW;
    const cy = s.sumY / s.sumW;
    const bboxW = s.maxX - s.minX + 1;
    const bboxH = s.maxY - s.minY + 1;
    blobs.push({
      x: cx,
      y: cy,
      intensity: s.sumW,
      radius: Math.max(bboxW, bboxH) / 2,
      r: s.sumR / s.pixels,
      g: s.sumG / s.pixels,
      b: s.sumB / s.pixels,
    });
  }
  // 按亮度从强到弱，方便跟踪器优先匹配强灯
  blobs.sort((a, b) => b.intensity - a.intensity);
  return blobs;
}
