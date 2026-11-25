/**
 * 灯质分析器：Track 亮度/颜色曲线 -> 明暗区间 -> 灯质分类与参数估计。
 *
 * 流水线：
 *   1. 中值滤波去单帧毛刺 -> Otsu 自适应阈值 -> 二值化 -> 游程编码出明暗区间
 *   2. 自相关估计基础周期，按闪光频率与区间结构分流七种灯质
 *   3. 莫尔斯：以单位时长归一化区间序列，匹配标准码表反查字母
 *   4. 灭灯时段做环境色校正后判定灯色；互光检测双色交替
 *   5. 干扰识别：稳态常亮（路灯/船灯/坏灯）、倒影（纵向抖动+弱光+高抖动）
 */
import { classifyColor, coefficientOfVariation, median, type ColorTriple } from './imageUtils';
import { MORSE_CODE, morseLetter } from './lightModel';
import type {
  AnalyzerConfig, LightCharacteristics, LightColor, LightKind,
  OnOffInterval, Track, TrackAnalysis,
} from './types';

/** 可序列化的区间实现（types 里用 getter 仅描述结构） */
class Interval implements OnOffInterval {
  constructor(
    public on: boolean,
    public startSec: number,
    public endSec: number,
  ) {}
  get durationSec(): number {
    return this.endSec - this.startSec;
  }
}

export function smoothMedian(xs: number[], halfWidth = 1): number[] {
  const out = new Array<number>(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(xs.length, i + halfWidth + 1);
    out[i] = median(xs.slice(lo, hi));
  }
  return out;
}

/** 自相关周期估计：返回周期秒数（取最强非零滞后峰） */
export function autocorrPeriod(signal: number[], dt: number, minLag = 2): number | null {
  const n = signal.length;
  if (n < minLag * 3) return null;
  let mean = 0;
  for (const v of signal) mean += v;
  mean /= n;
  const centered = signal.map((v) => v - mean);
  let c0 = 0;
  for (const v of centered) c0 += v * v;
  if (c0 < 1e-9) return null;
  const maxLag = Math.min(n - 1, Math.floor(n / 2));
  // 先算全部滞后的自相关，找显著峰值（局部极大且 >0.3），而非全局最大，
  // 避免暗期长的灯把最小滞后当成周期
  const corr: number[] = new Array(maxLag + 1).fill(0);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centered[i]! * centered[i + lag]!;
    corr[lag] = s / c0;
  }
  let bestLag = -1;
  let bestVal = 0.3;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag]! > corr[lag - 1]! && corr[lag]! >= corr[lag + 1]! && corr[lag]! > bestVal) {
      bestVal = corr[lag]!;
      bestLag = lag;
    }
  }
  return bestLag > 0 ? bestLag * dt : null;
}

/**
 * 周期估计（首选）：相邻"明段起点"间隔的中位数。
 * 对单闪/长闪/快闪即真实周期；对联闪会得到组内闪光间隔，需在联闪分支另行用组间距。
 */
function periodFromOnsets(intervals: Interval[]): number | null {
  const onsets = intervals.filter((i) => i.on).map((i) => i.startSec);
  if (onsets.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < onsets.length; i++) gaps.push(onsets[i]! - onsets[i - 1]!);
  return median(gaps);
}

/** 分位数阈值：闪烁信号里暗帧占多数，取暗峰与亮峰之间的分界 */
function adaptiveThreshold(brightness: number[]): number {
  const active = brightness.filter((v) => v > 0);
  if (active.length === 0) return 0;
  const sorted = [...brightness].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]!;
  const darkLevel = q(0.5);
  const brightLevel = median(active);
  let t: number;
  if (darkLevel <= 1) {
    // 暗态为真 0：阈值取亮态的 15%，给弱亮帧留余量
    t = brightLevel * 0.15;
  } else {
    // 暗态有底噪：在底噪与亮态之间取 30% 分位，偏向暗态一侧
    t = darkLevel + (brightLevel - darkLevel) * 0.3;
  }
  return Math.max(6, t);
}

/** 从亮度曲线提取明暗区间（自适应阈值 + 游程编码，合并短于 minRun 的毛刺） */
export function extractIntervals(
  brightness: number[],
  times: number[],
  minRunFrames = 2,
): { intervals: Interval[]; threshold: number } {
  if (brightness.length === 0) return { intervals: [], threshold: 0 };
  const smoothed = smoothMedian(brightness, 1);
  const threshold = adaptiveThreshold(smoothed);
  const binary = smoothed.map((v) => v >= threshold);
  const runs: { on: boolean; start: number; end: number }[] = [];
  for (let i = 0; i < binary.length; i++) {
    const last = runs[runs.length - 1];
    if (last && last.on === binary[i]) last.end = i;
    else runs.push({ on: binary[i]!, start: i, end: i });
  }
  // 合并短毛刺：长度不足 minRunFrames 的游程翻转并并入相邻段
  const merged: typeof runs = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (r.end - r.start + 1 < minRunFrames && prev) {
      prev.end = r.end;
    } else if (r.end - r.start + 1 < minRunFrames && merged.length > 1) {
      merged[merged.length - 2]!.end = r.end;
    } else {
      merged.push({ ...r });
    }
  }
  const intervals: Interval[] = merged.map((r) =>
    new Interval(r.on, times[r.start]!, times[Math.min(r.end + 1, times.length - 1)]!));
  return { intervals, threshold };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 取亮段/暗段（跳过首尾不完整段） */
function splitIntervals(intervals: Interval[]): { on: Interval[]; off: Interval[] } {
  const inner = intervals.slice(1, intervals.length - 1);
  const pool = inner.length >= 2 ? inner : intervals;
  return {
    on: pool.filter((i) => i.on),
    off: pool.filter((i) => !i.on),
  };
}

/**
 * 莫尔斯解码：把明段按单位时长归一化为点(1)/划(3)，暗段归一化为码元间隔(1)/字母间隔(7)。
 * unit 取最短明段与最短暗段的较小者。
 */
export function decodeMorse(intervals: Interval[]): {
  letter: string; unitSec: number; score: number; measuredPeriod: number | null
} | null {
  const rawOn = intervals.filter((i) => i.on && i.durationSec > 0.05);
  const offSegs = intervals.filter((i) => !i.on && i.durationSec > 0.05);
  if (rawOn.length < 2 || offSegs.length < 1) return null;
  // 明段时长的下四分位作为点单位；据此过滤串轨产生的异常超长明段（>5 个点单位）
  const onSortedAll = rawOn.map((i) => i.durationSec).sort((a, b) => a - b);
  const dotUnitRaw = onSortedAll[Math.max(0, Math.floor(onSortedAll.length * 0.25))]!;
  const onSegs = rawOn.filter((i) => i.durationSec <= dotUnitRaw * 5);
  if (onSegs.length < 2) return null;
  const onSorted = onSegs.map((i) => i.durationSec).sort((a, b) => a - b);
  const dotUnit = onSorted[Math.max(0, Math.floor(onSorted.length * 0.25))]!;
  const shortOffs = offSegs
    .map((i) => i.durationSec)
    .filter((d) => d < dotUnit * 4);
  const offUnit = shortOffs.length ? median(shortOffs) : dotUnit;
  const unit = Math.min(dotUnit, offUnit);
  if (unit <= 0) return null;

  // 明段归一化为点(.)/划(-)，全局收集（跨周期，长暗只作周期分隔不终止解码）
  const allSymbols: string[] = [];
  let onFit = 0;
  for (const seg of onSegs) {
    const units = seg.durationSec / unit;
    const isDash = units >= 1.8;
    allSymbols.push(isDash ? '-' : '.');
    onFit += 1 - Math.min(1, Math.abs(units - (isDash ? 3 : 1)) / 2);
  }
  // 暗段拟合度：码元间隔应≈1单位（周期末长暗排除）
  let offFit = 0;
  let offCount = 0;
  for (const seg of offSegs) {
    const units = seg.durationSec / unit;
    if (units >= 5) continue; // 周期末长暗
    offFit += 1 - Math.min(1, Math.abs(units - 1));
    offCount++;
  }
  const total = onSegs.length + offCount;
  const score = total > 0 ? (onFit + offFit) / total : 0;

  // 反查码表：用长暗（>=5 单位，周期边界）把符号切成每周期一组。
  // 先过滤串轨超长明段，再切组；选符号数最多且能反查字母的组，
  // 同长度时用点/划时长拟合度裁决。
  const cycleGroups: { symbols: string[]; onDurs: number[]; firstStart: number; lastEnd: number }[] =
    [{ symbols: [], onDurs: [], firstStart: -1, lastEnd: -1 }];
  for (const seg of intervals) {
    if (seg.on && seg.durationSec > 0.05) {
      if (seg.durationSec > dotUnit * 5) continue; // 串轨噪声，跳过且不切组
      const units = seg.durationSec / unit;
      const g = cycleGroups[cycleGroups.length - 1]!;
      g.symbols.push(units >= 1.8 ? '-' : '.');
      g.onDurs.push(seg.durationSec);
      if (g.firstStart < 0) g.firstStart = seg.startSec;
      g.lastEnd = seg.endSec;
    } else if (!seg.on && seg.durationSec / unit >= 5) {
      cycleGroups.push({ symbols: [], onDurs: [], firstStart: -1, lastEnd: -1 });
    }
  }
  const groupFit = (g: { symbols: string[]; onDurs: number[] }): number => {
    let fit = 0;
    g.symbols.forEach((sym, i) => {
      const expected = sym === '-' ? 3 : 1;
      const err = Math.abs(g.onDurs[i]! / unit - expected) / expected;
      fit += 1 - Math.min(1, err);
    });
    return fit / g.symbols.length;
  };
  const validCycleGroups = cycleGroups.filter((g) => g.symbols.length > 0);
  const candidates = validCycleGroups
    .filter((g) => morseLetter(g.symbols.join('')))
    .sort((a, b) => (b.symbols.length - a.symbols.length) || (groupFit(b) - groupFit(a)));
  let bestLetter = candidates.length ? morseLetter(candidates[0]!.symbols.join(''))! : '';
  // 实测周期：只取"完整且码型正确"的码组（符号序列恰好等于所解字母）首明段起点。
  // 跟踪起止处的残组即便符号数碰巧相同、码型也不同，必须排除，否则会算出跨中断的假周期。
  const bestPattern = bestLetter ? MORSE_CODE[bestLetter]! : '';
  const completeStarts = validCycleGroups
    .filter((g) => g.firstStart >= 0 && g.symbols.join('') === bestPattern)
    .map((g) => g.firstStart);
  const rawGaps: number[] = [];
  for (let i = 1; i < completeStarts.length; i++) {
    rawGaps.push(completeStarts[i]! - completeStarts[i - 1]!);
  }
  // 跨跟踪中断的两个码组，起点间隔会异常大（中间夹着十几秒无信号）。
  // 用全部间隔的最小值作为正常周期的稳健估计，剔除超过最小间隔 1.5 倍的离群间隔。
  let cycleGaps = rawGaps;
  if (rawGaps.length >= 2) {
    const minGap = Math.min(...rawGaps);
    cycleGaps = rawGaps.filter((g) => g <= minGap * 1.5);
  }
  let measuredPeriod = cycleGaps.length >= 1 ? median(cycleGaps) : null;
  // 只有一个正确码组（观测被中断切碎）时无法直接测周期。
  // 莫尔斯灯活动（明+码元间隔）约占整个周期的 1/4（末暗很长），
  // 用活动跨度除以经验占比 0.24 估算，比"固定 7 单位末暗"更贴近真实周期。
  if (measuredPeriod === null) {
    const fullGroup = validCycleGroups.find((g) => g.symbols.join('') === bestPattern);
    if (fullGroup) {
      const activity = fullGroup.lastEnd - fullGroup.firstStart;
      measuredPeriod = activity / 0.24;
    }
  }
  // 兜底：全局序列直接反查
  if (!bestLetter) bestLetter = morseLetter(allSymbols.join('')) ?? '';
  if (!bestLetter) return null;
  return { letter: bestLetter, unitSec: unit, score, measuredPeriod };
}

/**
 * 判断明段时长是否形成点、划两个稳定簇。
 * 排序后找最大相邻间隔分群，要求两群都有足够样本、群中心时长比≥1.8，
 * 从而排除联闪（单簇，偶发毛刺不影响）与莫尔斯（点划双簇）的混淆。
 */
function detectTwoDurationClusters(durs: number[]): boolean {
  if (durs.length < 4) return false;
  const sorted = [...durs].sort((a, b) => a - b);
  // 剔除极端离群（>5 倍中位的串轨段）
  const med = median(sorted);
  const valid = sorted.filter((d) => d <= med * 5);
  if (valid.length < 4) return false;
  let maxGap = -1;
  let splitIdx = -1;
  for (let i = 1; i < valid.length; i++) {
    const gap = valid[i]! - valid[i - 1]!;
    if (gap > maxGap) {
      maxGap = gap;
      splitIdx = i;
    }
  }
  const shortCluster = valid.slice(0, splitIdx);
  const longCluster = valid.slice(splitIdx);
  // 两簇都至少 2 个样本，且较小簇也要占一定比例，避免单毛刺成簇
  if (shortCluster.length < 2 || longCluster.length < 2) return false;
  const minClusterSize = Math.max(2, Math.floor(valid.length * 0.2));
  if (shortCluster.length < minClusterSize || longCluster.length < minClusterSize) return false;
  const shortCenter = median(shortCluster);
  const longCenter = median(longCluster);
  // 真实点划比约 3 倍；放宽到 2 倍以容纳测量误差，但排除 1.x 的抖动
  return longCenter / Math.max(0.05, shortCenter) >= 2;
}

function matchGroupFlashes(onSegs: Interval[], offSegs: Interval[]): {
  groupCount: number; periodSec: number; onSec: number
} | null {
  if (onSegs.length < 4) return null; // 至少要看到两组
  const onSec = median(onSegs.map((i) => i.durationSec));
  // 暗段应出现两类：组内短暗、组间长暗。用 Otsu 式找分界：
  // 组间长暗通常是组内短暗的数倍，取所有暗段的中位为界
  const offDurs = offSegs.map((i) => i.durationSec).sort((a, b) => a - b);
  const offMedian = median(offDurs);
  const longThreshold = offMedian * 1.6;
  const longOffs = offDurs.filter((d) => d > longThreshold);
  const shortOffs = offDurs.filter((d) => d <= longThreshold);
  if (longOffs.length === 0 || shortOffs.length === 0) return null;
  const shortOff = median(shortOffs);
  const longOff = median(longOffs);
  if (!(longOff > shortOff * 1.5)) return null;
  // 用长暗切段，每段内亮段数即每组次数
  const groups: Interval[][] = [];
  let cur: Interval[] = [];
  const onSet = new Set(onSegs);
  for (const iv of intervalsWithOffs(onSegs, offSegs)) {
    if (onSet.has(iv)) {
      cur.push(iv);
    } else if (iv.durationSec > longThreshold) {
      if (cur.length) groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  if (groups.length < 2) return null;
  const counts = groups.map((g) => g.length);
  const groupCount = median(counts.map(Number));
  // 允许个别组因漏检少 1 个闪光
  if (groupCount < 2 || counts.some((c) => c > groupCount + 1 || c < groupCount - 1)) return null;
  // 周期 = 相邻两组首个亮段起点之差的中位数
  const starts = groups.map((g) => g[0]!.startSec);
  const periodDiffs: number[] = [];
  for (let i = 1; i < starts.length; i++) periodDiffs.push(starts[i]! - starts[i - 1]!);
  return {
    groupCount: Math.round(groupCount),
    periodSec: median(periodDiffs),
    onSec,
  };
}

function intervalsWithOffs(onSegs: Interval[], offSegs: Interval[]): Interval[] {
  return [...onSegs, ...offSegs].sort((a, b) => a.startSec - b.startSec);
}

/**
 * 互光检测：互光灯全程常亮、两种颜色周期性交替，没有暗段。
 * 直接对亮帧的色温（r-b）时间序列做双峰聚类与交替性检验。
 */
function detectAlternating(track: Track): {
  colors: LightColor[]; periodSec: number
} | null {
  // 收集亮帧的色温与时间
  const samples: { t: number; temp: number; c: ColorTriple }[] = [];
  for (let i = 0; i < track.times.length; i++) {
    const c = track.colors[i];
    if (c && track.brightness[i]! > 0 && (c.r + c.g + c.b) > 0) {
      samples.push({ t: track.times[i]!, temp: c.r - c.b, c });
    }
  }
  if (samples.length < 20) return null;
  // 互光灯全程常亮、没有真正灭灯期；若亮帧占比偏低说明是闪烁灯（含莫尔斯），
  // 其明段内的色温波动不应被当成互光双色
  const litRatioAlt = samples.length / track.times.length;
  if (litRatioAlt < 0.7) return null;
  const temps = samples.map((s) => s.temp).sort((a, b) => a - b);
  const lo = temps[0]!;
  const hi = temps[temps.length - 1]!;
  // 色温跨度太小 -> 单色灯，不是互光
  if (hi - lo < 25) return null;
  const splitT = (lo + hi) / 2;
  // 每个相位只取该相位最亮的 30% 帧判色，弱化雾与光晕边缘的褪色
  const topColor = (frames: { t: number; temp: number; c: ColorTriple; b: number }[]): LightColor => {
    const sorted = [...frames].sort((a, x) => x.b - a.b);
    const top = sorted.slice(0, Math.max(3, Math.ceil(sorted.length * 0.3)));
    return classifyColor(meanOf(top.map((s) => s.c)), null).color;
  };
  const brightSamples = samples.map((s) => ({ ...s, b: s.c.r + s.c.g + s.c.b }));
  const classAFrames = brightSamples.filter((s) => s.temp >= splitT);
  const classBFrames = brightSamples.filter((s) => s.temp < splitT);
  if (classAFrames.length < 8 || classBFrames.length < 8) return null;
  const colorA = topColor(classAFrames);
  const colorB = topColor(classBFrames);
  if (colorA === colorB) return null;
  // 交替性：按时间顺序标号，统计相邻帧色温类别切换次数，
  // 真正互光周期性切换，切换次数应占相当比例
  const labels = samples.map((s) => (s.temp >= splitT ? 0 : 1));
  let switches = 0;
  for (let i = 1; i < labels.length; i++) if (labels[i] !== labels[i - 1]) switches++;
  // 至少 2 次完整交替（4 次切换）才算互光
  if (switches < 4) return null;
  // 周期：相邻同色相位起点的间隔。用切换点估半周期
  const switchTimes: number[] = [];
  for (let i = 1; i < labels.length; i++) {
    if (labels[i] !== labels[i - 1]) switchTimes.push(samples[i]!.t);
  }
  const halfGaps: number[] = [];
  for (let i = 1; i < switchTimes.length; i++) {
    halfGaps.push(switchTimes[i]! - switchTimes[i - 1]!);
  }
  const halfPeriod = median(halfGaps);
  // 主色取时间上第一个完整相位的颜色（与航标表"第一色"定义一致），
  // 而非按色温高低排序，避免红/白、绿/黄的主副顺序错位
  const firstLabel = labels[0]!;
  const primaryColor = firstLabel === 0 ? colorA : colorB;
  const alternateColor = firstLabel === 0 ? colorB : colorA;
  return { colors: [primaryColor, alternateColor], periodSec: halfPeriod * 2 };
}

function meanOf(cs: ColorTriple[]): ColorTriple {
  const valid = cs.filter((c): c is ColorTriple => !!c);
  if (valid.length === 0) return { r: 0, g: 0, b: 0 };
  return {
    r: mean(valid.map((c) => c.r)),
    g: mean(valid.map((c) => c.g)),
    b: mean(valid.map((c) => c.b)),
  };
}

/** 灭灯时段的环境色（雾/天光偏色校正基线） */
function ambientColor(track: Track, intervals: Interval[]): ColorTriple {
  const offFrames: ColorTriple[] = [];
  const offSet = new Set<number>();
  for (const seg of intervals.filter((i) => !i.on)) {
    for (let i = 0; i < track.times.length; i++) {
      const t = track.times[i]!;
      if (t >= seg.startSec && t <= seg.endSec && !offSet.has(i)) {
        offSet.add(i);
        const c = track.colors[i];
        if (c) offFrames.push(c);
      }
    }
  }
  return meanOf(offFrames);
}

/** 倒影识别：命中位置纵向抖动大、平均亮度弱且亮度变异高 */
function reflectionScore(track: Track): number {
  const ys = track.positions.filter((p): p is { x: number; y: number } => p !== null).map((p) => p.y);
  if (ys.length < 4) return 0;
  const yCv = coefficientOfVariation(ys.map((y) => y - mean(ys)));
  const brightCv = coefficientOfVariation(track.brightness.filter((v) => v > 0));
  const xs = track.positions.filter((p): p is { x: number; y: number } => p !== null).map((p) => p.x);
  const xSpread = Math.max(...xs) - Math.min(...xs);
  const ySpread = Math.max(...ys) - Math.min(...ys);
  const verticalRatio = ySpread / Math.max(1, xSpread);
  return Math.min(1, yCv * 2 + brightCv * 0.5 + verticalRatio * 0.2);
}

export interface AnalyzeResult {
  analysis: TrackAnalysis;
}

export function analyzeTrack(track: Track, config: AnalyzerConfig, dt: number): TrackAnalysis {
  const { intervals, threshold } = extractIntervals(track.brightness, track.times);
  const { on: onSegs, off: offSegs } = splitIntervals(intervals);
  const activeBrightness = track.brightness.filter((v) => v > 0);
  const onCv = coefficientOfVariation(activeBrightness);
  const distractorReasons: string[] = [];

  const autoPeriod = autocorrPeriod(track.brightness, dt);
  const onsetPeriod = periodFromOnsets(intervals);
  const flashCount = onSegs.length;
  const spanSec = track.times[track.times.length - 1]! - track.times[0]!;
  const ratePerMin = spanSec > 0 ? (flashCount / spanSec) * 60 : 0;
  const onSec = onSegs.length ? median(onSegs.map((i) => i.durationSec)) : 0;
  const totalOn = onSegs.reduce((s, i) => s + i.durationSec, 0);
  const dutyCycle = spanSec > 0 ? totalOn / spanSec : 0;
  const totalFrames = track.brightness.length;
  const litFrames = track.brightness.filter((v) => v > 0).length;
  const litRatio = totalFrames > 0 ? litFrames / totalFrames : 0;
  // 常亮判据（需同时满足，避免碎片轨迹误判）：
  // 1) 亮帧占比高（真正常亮几乎每帧有信号）；2) 没有显著长暗段。
  // 仅有 1 个明段但亮帧占比低的，是漏检严重的闪烁灯碎片，不能判常亮。
  const longestOff = offSegs.reduce((m, i) => Math.max(m, i.durationSec), 0);
  const isSteady = litRatio >= 0.75 && longestOff < Math.max(0.5, spanSec * 0.1);
  // 周期估计。优先明段起点中位间隔，自相关兜底。
  let period: number;
  if (onsetPeriod) {
    period = onsetPeriod;
  } else if (autoPeriod) {
    period = autoPeriod;
  } else if (flashCount > 1) {
    period = spanSec / flashCount;
  } else if (onSegs.length === 1 && offSegs.length >= 1) {
    // 只捕获到一个完整明段+随后暗段：周期 ≈ 明时长 + 相邻暗时长（一个完整循环）
    const onStart = onSegs[0]!.startSec;
    const followingOff = offSegs
      .filter((o) => o.startSec >= onStart)
      .sort((a, b) => a.startSec - b.startSec)[0];
    period = followingOff
      ? onSegs[0]!.durationSec + followingOff.durationSec
      : onSec / Math.max(0.02, dutyCycle);
  } else if (dutyCycle > 0.02 && onSec > 0) {
    period = onSec / dutyCycle;
  } else {
    period = spanSec;
  }

  let kind: LightKind;
  let measured: LightCharacteristics;
  let periodSec: number;
  let groupCount: number | undefined;

  // 莫尔斯预判：明段须形成"点群"和"划群"两个稳定时长簇（划≈3 倍点）。
  // 不能用单个最短/最长极值——浪雾下单个毛刺或截断段会造出假日。
  // 做法：明段按时长排序，找最大相邻间隔作为分群边界，要求两群各自成规模
  // 且群中心之比≥1.8（真实点划比约3）。
  const onDursAll = onSegs.map((i) => i.durationSec).filter((d) => d > 0.05);
  const hasTwoSymbols = detectTwoDurationClusters(onDursAll);
  const morsePreview = hasTwoSymbols ? decodeMorse(intervals) : null;
  const isMorse = !!morsePreview && morsePreview.score > 0.7;

  // ---- 分流判定 ----
  const alt = isMorse ? null : detectAlternating(track);
  if (alt) {
    kind = 'alternating';
    periodSec = alt.periodSec; // detectAlternating 已返回完整双色周期
    measured = {
      kind, periodSec, onSec: periodSec / 2,
      color: alt.colors[0]!, alternateColor: alt.colors[1],
    };
  } else if (isSteady && !isMorse) {
    // 常亮：亮帧占比极高（路灯/船灯/坏成常亮的航标灯）
    kind = 'fixed';
    periodSec = 1;
    measured = { kind, periodSec: 1, onSec: spanSec || 1, color: 'white' };
    distractorReasons.push(`亮帧占比 ${(litRatio * 100).toFixed(0)}% ≥ 75%，呈常亮态`);
  } else if (ratePerMin >= config.quickRatePerMin && !isMorse) {
    kind = 'quick';
    periodSec = period;
    measured = { kind, periodSec, onSec, color: 'white' };
  } else if (onSegs.length > 0 && onSec >= config.longFlashSec && !isMorse) {
    kind = 'longFlash';
    periodSec = period;
    measured = { kind, periodSec, onSec, color: 'white' };
  } else {
    const group = matchGroupFlashes(onSegs, offSegs);
    const morse = morsePreview;
    // 莫尔斯优先，但 hasTwoSymbols 已用中位数剔除毛刺，是稳健的点划硬门槛。
    // K(-.-) 这类 3 明段莫尔斯靠点划时长差异与联闪(3) 区分。
    if (morse && hasTwoSymbols) {
      kind = 'morse';
      // 莫尔斯真实周期 = 相邻码组首明段的起点间隔（末暗长度不固定，不能靠码元数推算）。
      // measuredPeriod 已在解码时按"剔除跨中断假周期"后的起点间隔中位数给出；
      // 仅在缺失时才退回单位×码元的估算。
      const expected = MORSE_CODE[morse.letter]!;
      const unitCount = expected.split('').reduce((s, ch) => s + (ch === '.' ? 1 : 3) + 1, 0) - 1 + 7;
      periodSec = morse.measuredPeriod ?? morse.unitSec * unitCount;
      measured = { kind, periodSec, onSec: morse.unitSec, morseLetter: morse.letter, color: 'white' };
    } else if (group) {
      kind = 'group';
      groupCount = group.groupCount;
      periodSec = group.periodSec;
      measured = { kind, groupCount, periodSec, onSec: group.onSec, color: 'white' };
    } else {
      kind = 'single';
      periodSec = period;
      measured = { kind, periodSec, onSec, color: 'white' };
    }
  }

  // ---- 颜色：亮帧按亮度排序后取中间分位段，灭灯帧不参与 ----
  const ambient = ambientColor(track, intervals);
  const onColorFrames: { c: ColorTriple; b: number }[] = [];
  for (let i = 0; i < track.times.length; i++) {
    if (track.brightness[i]! >= threshold) {
      const c = track.colors[i];
      if (c && (c.r + c.g + c.b) > 0) onColorFrames.push({ c, b: track.brightness[i]! });
    }
  }
  onColorFrames.sort((a, x) => x.b - a.b);
  // 默认取最亮 30% 帧（灯芯受雾衰减最小、颜色最纯）；
  // 莫尔斯灯例外——其点/划亮度差异大，最亮帧偏向近白灯芯，改用全部亮帧均值。
  const topN = Math.max(3, Math.ceil(onColorFrames.length * 0.3));
  const onMean = kind === 'morse'
    ? meanOf(onColorFrames.map((e) => e.c))
    : meanOf(onColorFrames.slice(0, topN).map((e) => e.c));
  // 仅当环境色明显暗于亮帧（说明是真雾/天光底噪）才校正；
  // 常亮灯灭灯帧几乎不存在，环境色会等于灯本身，相减反而丢色
  const ambBright = ambient.r + ambient.g + ambient.b;
  const onBright = onMean.r + onMean.g + onMean.b;
  const useAmbient = ambBright > 0 && onBright > ambBright * 1.4;
  const colorResult = classifyColor(onMean, useAmbient ? ambient : null);
  // 互光的主/副色已在 detectAlternating 内按两相位独立判定，不能被单色平均覆盖
  if (kind !== 'alternating') {
    measured.color = colorResult.color;
  }
  if (kind === 'alternating' && measured.alternateColor === undefined) {
    measured.alternateColor = 'white';
  }

  // ---- 干扰识别 ----
  const refl = reflectionScore(track);
  if (kind === 'fixed') {
    // 常亮源可能是路灯/船灯，也可能是坏灯；标记为疑似干扰，留给航标比对裁决
    if (refl > 0.55) distractorReasons.push(`倒影特征分 ${refl.toFixed(2)} 偏高（纵向抖动/弱光）`);
  } else if (refl > 0.65) {
    distractorReasons.push(`倒影特征分 ${refl.toFixed(2)} 偏高`);
  }
  if (onCv > 0.6 && refl > 0.4) {
    distractorReasons.push('亮段亮度波动大，符合海面碎倒影特征');
  }
  const isDistractor = kind === 'fixed' || distractorReasons.length > 0;

  return {
    trackId: track.id,
    measured,
    intervals,
    threshold,
    dutyCycle,
    isDistractor,
    distractorReasons,
  };
}
