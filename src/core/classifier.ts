/**
 * 灯质分类器：从单条轨迹的亮度/颜色时间序列判读灯质。
 *
 * 流程：插值补洞 → 自适应滞回二值化 → 亮/暗游程（脉冲）
 *      → 自相关测周期（抛物插值）→ 决策树分类 → 颜色投票。
 * 纯函数，Worker 与 Node 评估共用。
 */
import { detectAlternation, voteColors } from './color';
import { morseCode } from './schedule';
import type { Classification, LightCharacteristic, Track } from './types';

export interface ClassifyOptions {
  fps: number;
  /** 二值化高阈值（相对亮度幅值比例） */
  highRatio?: number;
  /** 二值化低阈值 */
  lowRatio?: number;
  /** 快闪判定：每分钟闪次下限 */
  quickFpm?: number;
  /** 长闪判定：单次亮时下限（秒） */
  longOnSec?: number;
  /** 周期紊乱变异系数阈值 */
  rhythmCv?: number;
}

interface Pulse {
  /** 起始帧（含） */
  start: number;
  /** 结束帧（不含） */
  end: number;
  onFrames: number;
  offFrames: number; // 到下一脉冲的暗段长度（末脉冲为尾暗）
}

const MORSE: Record<string, string> = {
  '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F',
  '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L',
  '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R',
  '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X',
  '-.--': 'Y', '--..': 'Z',
};

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function mean(a: number[]): number {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function coeffVar(a: number[]): number {
  if (a.length < 2) return 0;
  const m = mean(a);
  if (m < 1e-9) return 0;
  const sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length);
  return sd / m;
}

/**
 * 稀疏亮度序列规整：灭灯/断航帧（null）填 0（与检测阈值口径一致：
 * 没过阈值即视为灭），仅序列两端之前/之后的空帧裁剪掉，避免边效。
 */
function fillSeries(values: (number | null)[]): number[] {
  let first = 0;
  let last = values.length - 1;
  while (first <= last && values[first] === null) first++;
  while (last >= first && values[last] === null) last--;
  const out = new Array<number>(Math.max(0, last - first + 1));
  for (let i = 0; i < out.length; i++) {
    out[i] = values[first + i] ?? 0;
  }
  return out.length ? out : values.map(() => 0);
}

/** 分位数阈值：用亮度序列的低/高分位估计灭档与亮档的代表水平 */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[idx]!;
}

/** 自适应滞回二值化：分位数定亮灭两档，中间设滞回带 */
function hysteresisBinarize(series: number[], highRatio: number, lowRatio: number): boolean[] {
  const sorted = [...series].sort((a, b) => a - b);
  const darkLevel = quantile(sorted, 0.2);
  const brightLevel = quantile(sorted, 0.85);
  const amp = brightLevel - darkLevel;
  if (amp < 25) {
    return series.map((v) => v > 60);
  }
  // 滞回带落在两档之间的 35%~65% 位置
  const tHi = darkLevel + amp * Math.max(highRatio, 0.6);
  const tLo = darkLevel + amp * Math.min(lowRatio, 0.4);
  const out: boolean[] = new Array(series.length);
  let on = series[0]! >= tHi;
  for (let i = 0; i < series.length; i++) {
    const v = series[i]!;
    if (on) {
      if (v < tLo) on = false;
    } else if (v > tHi) {
      on = true;
    }
    out[i] = on;
  }
  // 形态学闭运算：填补 ≤2 帧的短暂灭洞（浪/雾导致的单帧漏检）
  for (let i = 1; i < out.length - 1; i++) {
    if (!out[i] && out[i - 1] && out[i + 1]) out[i] = true;
  }
  return out;
}

/** 时域中值滤波：窗口内取中位，平滑单帧噪声而保留多帧节律 */
function temporalMedian(series: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out = new Array<number>(series.length);
  for (let i = 0; i < series.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(series.length - 1, i + half);
    const win = series.slice(lo, hi + 1).sort((a, b) => a - b);
    out[i] = win[Math.floor(win.length / 2)]!;
  }
  return out;
}

function toPulses(binary: boolean[]): Pulse[] {
  const pulses: Pulse[] = [];
  let i = 0;
  const n = binary.length;
  while (i < n && !binary[i]!) i++;
  while (i < n) {
    const start = i;
    while (i < n && binary[i]!) i++;
    const end = i;
    while (i < n && !binary[i]!) i++;
    pulses.push({ start, end, onFrames: end - start, offFrames: i - end });
  }
  return pulses;
}

/**
 * 自相关测周期：对亮度序列去均值后做无偏归一化自相关，
 * 在允许滞后范围内找最高峰，峰值位置做抛物插值（亚帧精度）。
 */
function autocorrelationPeriod(
  series: number[],
  fps: number,
  minLagFrames: number,
  maxLagFrames: number,
): { periodSec: number | null; peak: number } {
  const n = series.length;
  const m = mean(series);
  const centered = series.map((v) => v - m);
  const denom0 = centered.reduce((s, v) => s + v * v, 0);
  if (denom0 < 1e-6 || maxLagFrames >= n) return { periodSec: null, peak: 0 };

  let bestLag = -1;
  let bestVal = 0;
  for (let lag = minLagFrames; lag <= maxLagFrames; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centered[i]! * centered[i + lag]!;
    const norm = s / (denom0 * (1 - lag / n) + 1e-9);
    if (norm > bestVal) {
      bestVal = norm;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestVal < 0.25) return { periodSec: null, peak: Math.max(0, bestVal) };

  // 抛物插值
  const acf = (lag: number): number => {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += centered[i]! * centered[i + lag]!;
    return s / (denom0 * (1 - lag / n) + 1e-9);
  };
  const y0 = acf(bestLag - 1);
  const y1 = bestVal;
  const y2 = acf(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = Math.abs(denom) > 1e-9 ? (y0 - y2) / (2 * denom) : 0;
  const lagFrames = bestLag + Math.max(-0.5, Math.min(0.5, shift));
  return { periodSec: lagFrames / fps, peak: bestVal };
}

/** 按亮时把脉冲分成点/划，尝试莫尔斯解码。
 *  莫尔斯本质：一个字母组内有多个短促等亮点，组内暗短而均匀，
 *  组间暗（到下一字母）明显更长。先按暗间隔的两档聚类切段再解码。 */
function tryMorse(
  pulses: Pulse[],
  fps: number,
): { letter: string | null; dashRatio: number; groupHeadIdx: number[] } {
  const none = { letter: null, dashRatio: 0, groupHeadIdx: [] };
  if (pulses.length < 4) return none;
  // 异常长脉冲（浪况粘连，莫尔斯点都 <1s）记下标但不参与两档聚类
  const normalIdx = pulses.map((p, i) => (p.onFrames / fps < 1.0 ? i : -1)).filter((i) => i >= 0);
  if (normalIdx.length < 4) return none;
  const gaps = normalIdx.slice(1).map((idx, k) => pulses[idx]!.start - (pulses[normalIdx[k]!]!.start + pulses[normalIdx[k]!]!.onFrames));
  const sorted = [...gaps].sort((a, b) => a - b);
  // 码内暗与组间暗数量级悬殊：用下四分位估计码内暗典型值，
  // 组间暗定义为 ≥ 码内暗 4 倍（莫尔斯点 0.3s + 码内暗 0.3s，组间暗通常数秒）
  const innerTypical = sorted[Math.floor(sorted.length * 0.25)] ?? sorted[0]!;
  const innerMax = innerTypical * 4;
  const hasOuter = sorted.some((g) => g > innerMax);
  if (!hasOuter) {
    return none;
  }
  // 按组间暗在正常脉冲序列上切段，映射回原始 pulses 下标
  const groups: Pulse[][] = [];
  const headIdx: number[] = [normalIdx[0]!];
  let cur: Pulse[] = [pulses[normalIdx[0]!]!];
  for (let i = 0; i < gaps.length; i++) {
    const origIdx = normalIdx[i + 1]!;
    if (gaps[i]! > innerMax) {
      groups.push(cur);
      cur = [];
      headIdx.push(origIdx);
    }
    cur.push(pulses[origIdx]!);
  }
  if (cur.length) groups.push(cur);
  const letters: string[] = [];
  for (const g of groups) {
    if (g.length < 2 || g.length > 6) continue;
    const decoded = decodeMorseGroup(g, fps);
    if (decoded) letters.push(decoded);
  }
  // 多数组解码成同一字母即可（容忍个别组被噪声破坏）
  if (letters.length < 2) return none;
  const tally = new Map<string, number>();
  for (const l of letters) tally.set(l, (tally.get(l) ?? 0) + 1);
  const [winner, winnerN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (winnerN < letters.length * 0.6) return none;
  return { letter: winner, dashRatio: 0, groupHeadIdx: headIdx };
}

/** 解码单个莫尔斯字母组（2~6 个脉冲） */
function decodeMorseGroup(group: Pulse[], fps: number): string | null {
  const ons = group.map((p) => p.onFrames);
  const med = median(ons);
  const gaps = group.slice(0, -1).map((p) => p.offFrames);
  const medGap = gaps.length ? median(gaps) : 0;
  const uniformOn = coeffVar(ons) < 0.4;
  // 莫尔斯点时 ≤0.4s（联闪标称亮时 0.5s，被雾拖短也以此为硬边界）
  const ditShortEnough = med / fps <= 0.4;
  // 莫尔斯码内暗也短（<0.5s），联闪/快闪组内暗 ≥0.5s
  const innerGapShort = medGap / fps < 0.5;
  // 码内暗必须高度一致（莫尔斯节奏规整，CV<0.5），碎轨迹的混乱暗间隔被排除
  const gapRegular = gaps.length === 0 || coeffVar(gaps) < 0.5;
  // 纯点码
  if (uniformOn && ditShortEnough && innerGapShort && gapRegular) {
    return MORSE['.'.repeat(group.length)] ?? null;
  }
  // 码内暗过长或不规整的直接排除（联闪/快闪组内暗 ≥0.5s，碎轨迹节奏混乱）
  if (!innerGapShort || !gapRegular) return null;
  // 点划混合
  const symbols = group.map((p) => (p.onFrames > med * 1.2 ? '-' : '.')).join('');
  const letter = MORSE[symbols] ?? null;
  if (letter && morseCode(letter) === symbols) return letter;
  return null;
}

export function classifyTrack(track: Track, opts: ClassifyOptions): Classification {
  const fps = opts.fps;
  const highRatio = opts.highRatio ?? 0.65;
  const lowRatio = opts.lowRatio ?? 0.35;
  const longOnSec = opts.longOnSec ?? 1.5;
  const rhythmCv = opts.rhythmCv ?? 0.25;

  const filled = fillSeries(track.brightness);
  // 3 帧时域中值滤波：抑制雾/浪导致的单帧亮度抖动，不改变 ≥2 帧的真实亮灭节律
  const smoothed = temporalMedian(filled, 3);
  const binary = hysteresisBinarize(smoothed, highRatio, lowRatio);
  const pulses = toPulses(binary);
  const totalFrames = smoothed.length;
  const onFrames = binary.filter(Boolean).length;
  const dutyCycle = onFrames / Math.max(totalFrames, 1);

  const colorVote = voteColors(track.colors, track.brightness);
  const alternation = detectAlternation(track.colors, track.brightness);
  // 只有确认为互光时才输出双色；其它灯质（含过曝暖偏的白灯）只取主色
  const finalColors = alternation.isAlternating ? colorVote.colors : [colorVote.colors[0]!];

  const base: Classification = {
    characteristic: 'unknown',
    groupSize: null,
    periodSec: null,
    onDurationSec: null,
    offDurationSec: null,
    colors: finalColors,
    dutyCycle,
    flashesPerMinute: 0,
    morseLetter: null,
    periodVariation: null,
    confidence: 0,
  };

  if (pulses.length === 0) {
    return { ...base, characteristic: dutyCycle > 0.9 ? 'fixed' : 'unknown', confidence: dutyCycle };
  }

  const durationSec = totalFrames / fps;
  const fpm = (pulses.length / durationSec) * 60;
  const onSecs = pulses.map((p) => p.onFrames / fps);
  // 亮时取 75 分位：大浪/浓雾会把部分脉冲截短，高分位更接近真实亮时
  const sortedOn = [...onSecs].sort((a, b) => a - b);
  const medOn = sortedOn[Math.floor(sortedOn.length * 0.75)] ?? median(onSecs);

  // —— 常亮：跟踪器 steady 标记，或亮占比极高且无互光（航标 fixed 灯质/常亮故障） ——
  if ((track.steady === true || dutyCycle >= 0.95) && !alternation.isAlternating) {
    return {
      ...base,
      characteristic: 'fixed',
      onDurationSec: durationSec,
      offDurationSec: 0,
      flashesPerMinute: 0,
      confidence: 0.9,
    };
  }

  // —— 互光：两种色相成段交替（全程有光，靠换色而非亮灭区分，不依赖二值化占空） ——
  if (alternation.isAlternating) {
    const { periodSec, peak } = autocorrelationPeriod(filled, fps, Math.max(2, Math.round(fps * 0.4)), Math.min(totalFrames - 2, Math.round(fps * 12)));
    return {
      ...base,
      characteristic: 'alternating',
      colors: alternation.colors,
      periodSec,
      onDurationSec: (periodSec ?? 0) / 2,
      offDurationSec: 0,
      flashesPerMinute: fpm,
      confidence: Math.max(peak, 0.6),
    };
  }

  // —— 莫尔斯：点划两档且可解码（须在快闪判定前，莫尔斯点也很短） ——
  const morse = tryMorse(pulses, fps);
  if (morse.letter) {
    // 周期 = 相邻字母组首闪的起点间距
    const heads = morse.groupHeadIdx;
    const groupCycles = heads.slice(1).map((h, k) => (pulses[h]!.start - pulses[heads[k]!]!.start) / fps);
    const periodSec = groupCycles.length ? median(groupCycles) : null;
    return {
      ...base,
      characteristic: 'morse',
      periodSec,
      onDurationSec: medOn,
      offDurationSec: median(pulses.slice(0, -1).map((p) => p.offFrames / fps)),
      flashesPerMinute: fpm,
      morseLetter: morse.letter,
      periodVariation: coeffVar(groupCycles),
      confidence: 0.85,
    };
  }

  // —— 脉冲起点间距 —— //
  const starts = pulses.map((p) => p.start / fps);
  const startCycles = starts.slice(1).map((t, k) => t - starts[k]!);
  const periodCv = coeffVar(startCycles);

  const minLag = Math.max(2, Math.round(fps * 0.4));
  const maxLag = Math.min(totalFrames - 2, Math.round(fps * 15));
  const acf = autocorrelationPeriod(filled, fps, minLag, maxLag);

  // 联闪分组：对暗间隔做两档阈值聚类，组内暗短、组间暗长
  const gaps = pulses.slice(0, -1).map((p) => p.offFrames / fps);
  let groupSize: number | null = null;
  /** 每组首闪在 pulses 中的下标 */
  let groupHeadIdx: number[] = [];
  if (gaps.length >= 2) {
    const sorted = [...gaps].sort((a, b) => a - b);
    let split = 0;
    let maxJump = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const jump = sorted[i + 1]! - sorted[i]!;
      if (jump > maxJump) {
        maxJump = jump;
        split = i + 1;
      }
    }
    const innerMax = sorted[split - 1] ?? 0;
    const outerMin = sorted[split] ?? Infinity;
    // 两档分离度足够（组间暗 ≥ 组内暗的 1.5 倍）才判联闪
    if (split >= 1 && split < sorted.length && outerMin >= innerMax * 1.5) {
      const heads = [0];
      for (let i = 0; i < gaps.length; i++) {
        if (gaps[i]! > innerMax) heads.push(i + 1);
      }
      const sizes: number[] = [];
      for (let k = 0; k < heads.length; k++) {
        const end = k + 1 < heads.length ? heads[k + 1]! : pulses.length;
        sizes.push(end - heads[k]!);
      }
      const candidate = median(sizes);
      if (candidate >= 2) {
        groupSize = candidate;
        groupHeadIdx = heads;
      }
    }
  }

  // 周期：联闪取组首闪间距（组周期）；其余取全部脉冲起点间距中位
  let periodSec: number | null;
  if (groupSize && groupHeadIdx.length >= 2) {
    const groupCycles = groupHeadIdx.slice(1).map((h, k) => (pulses[h]!.start - pulses[groupHeadIdx[k]!]!.start) / fps);
    periodSec = median(groupCycles);
  } else {
    periodSec = startCycles.length ? median(startCycles) : acf.periodSec;
  }
  // 合理性约束：碎轨迹可能把多个周期误并成超大值，周期须在 [0.5, 视频时长/2]
  const maxReasonablePeriod = durationSec / 2;
  if (periodSec !== null && (periodSec < 0.5 || periodSec > maxReasonablePeriod)) {
    periodSec = acf.periodSec !== null && acf.periodSec <= maxReasonablePeriod ? acf.periodSec : null;
  }

  // 快闪节奏：亮时短且闪频高。浓雾会把普通闪的亮时拖短，因此除亮时/slot 外，
  // 还要求脉冲节奏高度规则（真实快闪起点间距 CV 小），雾致碎脉冲间隔紊乱会被排除。
  const innerGaps = gaps.length ? gaps.filter((g) => g <= median(gaps)) : [0.6];
  const slotSec = medOn + median(innerGaps);
  const instantFpm = medOn > 0 ? 60 / slotSec : 0;
  // 快闪需三重证据：亮时短、脉冲节奏快（slot≤1.3s）、观测到足够多规则脉冲（≥6）
  const isQuickRhythm = medOn <= 0.45 && slotSec <= 1.3 && pulses.length >= 6;

  // —— 长闪优先：亮时 ≥1.5s 是硬特征，联闪/单闪亮时仅 0.5s，不受分组影响 ——
  if (medOn >= longOnSec) {
    // 长闪脉冲数少，脉冲间距不稳，优先用自相关周期
    const longPeriod = acf.periodSec ?? periodSec;
    return {
      ...base,
      characteristic: 'long-flash',
      periodSec: longPeriod,
      onDurationSec: medOn,
      offDurationSec: median(gaps.length ? gaps : [0]),
      flashesPerMinute: fpm,
      periodVariation: periodCv,
      confidence: Math.max(acf.peak, 0.5),
    };
  }

  // —— 快闪（含联组快闪） ——
  if (isQuickRhythm) {
    return {
      ...base,
      characteristic: 'quick',
      groupSize: groupSize && groupSize > 1 ? groupSize : null,
      periodSec,
      onDurationSec: medOn,
      offDurationSec: median(gaps.length ? gaps : [0]),
      flashesPerMinute: instantFpm,
      periodVariation: periodCv,
      confidence: Math.max(acf.peak, 0.55),
    };
  }

  // —— 联闪 ——
  if (groupSize && groupSize >= 2) {
    return {
      ...base,
      characteristic: 'group-flash',
      groupSize,
      periodSec,
      onDurationSec: medOn,
      offDurationSec: median(gaps.length ? gaps : [0]),
      flashesPerMinute: fpm,
      periodVariation: periodCv,
      confidence: Math.max(acf.peak, 0.5),
    };
  }

  // —— 节奏紊乱判定 ——
  if (periodCv > rhythmCv && acf.peak < 0.4) {
    return {
      ...base,
      characteristic: 'unknown',
      periodSec: startCycles.length ? median(startCycles) : null,
      onDurationSec: medOn,
      offDurationSec: median(gaps.length ? gaps : [0]),
      flashesPerMinute: fpm,
      periodVariation: periodCv,
      confidence: acf.peak,
    };
  }

  // —— 兜底：单闪 ——
  return {
    ...base,
    characteristic: 'single-flash',
    periodSec,
    onDurationSec: medOn,
    offDurationSec: median(gaps.length ? gaps : [0]),
    flashesPerMinute: fpm,
    periodVariation: periodCv,
    confidence: Math.max(acf.peak, 0.45),
  };
}

export function classifyAll(tracks: Track[], fps: number): { trackId: number; result: Classification }[] {
  // 常亮航标本身也是 steady 形态，因此只排除倒影与过短轨迹
  return tracks
    .filter((t) => t.confirmed && t.rejected !== 'reflection' && t.rejected !== 'too-short')
    .map((t) => ({ trackId: t.id, result: classifyTrack(t, { fps }) }));
}

export const __testing = { fillSeries, hysteresisBinarize, toPulses, autocorrelationPeriod, median, coeffVar };
export type { LightCharacteristic };
