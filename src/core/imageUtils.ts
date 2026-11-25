/**
 * 图像处理基础：灰度、缩放、Otsu 阈值、颜色判定
 * 全部为纯函数，Worker 与 Node 测试共用。
 */
import type { LightColor } from './types';

export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 双线性缩放到目标宽度（保持宽高比），输出 RGBA */
export function downscale(img: RgbaImage, targetWidth: number): RgbaImage {
  if (img.width === targetWidth) return img;
  const scale = targetWidth / img.width;
  const tw = targetWidth;
  const th = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < tw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = sx - x0;
      const o = (y * tw + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const p00 = img.data[(y0 * img.width + x0) * 4 + ch]!;
        const p01 = img.data[(y0 * img.width + x1) * 4 + ch]!;
        const p10 = img.data[(y1 * img.width + x0) * 4 + ch]!;
        const p11 = img.data[(y1 * img.width + x1) * 4 + ch]!;
        out[o + ch] = p00 * (1 - wx) * (1 - wy) + p01 * wx * (1 - wy)
          + p10 * (1 - wx) * wy + p11 * wx * wy;
      }
    }
  }
  return { data: out, width: tw, height: th };
}

/** 一维 Otsu 阈值，返回 0-255 */
export function otsuThreshold(values: ArrayLike<number>): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) {
    const v: number = values[i]!;
    const bin: number = Math.max(0, Math.min(255, v));
    hist[bin] = (hist[bin] ?? 0) + 1;
  }
  const total = values.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v]!;
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

export interface ColorTriple { r: number; g: number; b: number }

/**
 * 灯色判定：先用灭灯时段均值做雾/天光偏色校正，再按归一化 RGB 分类。
 * 返回颜色与置信度 0-1。
 */
export function classifyColor(onMean: ColorTriple, ambient: ColorTriple | null): {
  color: LightColor;
  confidence: number;
  corrected: ColorTriple;
} {
  const corrected = ambient
    ? {
      r: Math.max(0, onMean.r - ambient.r),
      g: Math.max(0, onMean.g - ambient.g),
      b: Math.max(0, onMean.b - ambient.b),
    }
    : { ...onMean };
  const { r, g, b } = corrected;
  const max = Math.max(r, g, b, 1);
  const nr = r / max;
  const ng = g / max;
  const nb = b / max;
  const sat = 1 - Math.min(nr, ng, nb);
  // 黄的本质：蓝通道显著弱于红、绿（r≈g >> b）。雾会压低整体饱和度，
  // 但蓝弱这一结构特征保留最久，因此把"蓝弱势"作为黄的首要判据。
  const blueWeak = nb < 0.93 && (nr - nb) > 0.06 && (ng - nb) > 0.06 && nb <= nr && nb <= ng;
  const redDominant = nr >= ng && nr > nb;
  const greenDominant = ng > nr && ng > nb;

  let color: LightColor;
  let confidence: number;
  if (blueWeak && Math.abs(nr - ng) < 0.22) {
    // 红绿接近（允许红略强）且都明显高于蓝（蓝是三通道最弱）-> 黄，
    // 雾压低饱和、黄灯红通道略占优时仍成立
    color = 'yellow';
    confidence = Math.min(1, (nr + ng) / 2 - nb + 0.3);
  } else if (sat < 0.1 || (nb >= nr && nb >= ng)) {
    // 近灰、或蓝通道最强（冷白）-> 白
    color = 'white';
    confidence = 0.8;
  } else if (redDominant) {
    color = 'red';
    confidence = Math.min(1, nr - Math.max(ng, nb) + 0.3);
  } else if (greenDominant) {
    color = 'green';
    confidence = Math.min(1, ng - Math.max(nr, nb) + 0.3);
  } else {
    // 兜底
    if (nr >= ng && nr >= nb) color = 'red';
    else if (ng >= nr && ng >= nb) color = 'green';
    else color = 'white';
    confidence = 0.4;
  }
  return { color, confidence, corrected };
}

/** 变异系数 CV = 标准差/均值 */
export function coefficientOfVariation(xs: ArrayLike<number>): number {
  if (xs.length === 0) return 0;
  let mean = 0;
  for (let i = 0; i < xs.length; i++) mean += xs[i]!;
  mean /= xs.length;
  if (mean < 1e-6) return 0;
  let varSum = 0;
  for (let i = 0; i < xs.length; i++) varSum += (xs[i]! - mean) ** 2;
  return Math.sqrt(varSum / xs.length) / mean;
}

/** 皮尔逊相关系数 */
export function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i]! - ma;
    const db = b[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom < 1e-9 ? 0 : cov / denom;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
