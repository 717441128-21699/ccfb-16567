/**
 * 灯色判定：红绿白黄四类。
 * 夜间点光源在画面中通常过曝变白，因此综合「色度比 + 亮度」，
 * 并对整条轨迹做多数投票，单帧判定仅输出候选。
 */
import type { LightColor } from './types';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 单帧/单点颜色判定，返回颜色与置信度 0..1 */
export function classifyColor(rgb: Rgb): { color: LightColor; confidence: number } {
  const { r, g, b } = rgb;
  const max = Math.max(r, g, b);
  if (max < 1e-3) {
    return { color: 'white', confidence: 0 };
  }
  const rn = r / max;
  const gn = g / max;
  const bn = b / max;

  // 归一化通道差（不受整体过曝影响）
  const rgGap = rn - gn;

  // 强红：红绿归一化差距 >0.22 且蓝通道明显低（过曝红灯仍保持色相）
  if (rn > 0.8 && rgGap > 0.22 && bn < 0.5) {
    return { color: 'red', confidence: 0.95 };
  }
  if (gn > 0.8 && gn - rn > 0.22 && bn < 0.5) {
    return { color: 'green', confidence: 0.95 };
  }
  // 黄：红+绿都高且接近（归一化差距 <0.2），蓝低
  if (rn > 0.82 && gn > 0.75 && bn < 0.55 && Math.abs(rgGap) < 0.2) {
    return { color: 'yellow', confidence: 0.9 };
  }
  // 过曝白：三通道都高且接近
  if (rn > 0.85 && gn > 0.85 && bn > 0.8) {
    return { color: 'white', confidence: 0.7 };
  }
  // 弱饱和兜底：用归一化红绿差区分
  if (r >= g && r >= b) {
    return rgGap > 0.15 ? { color: 'red', confidence: 0.62 } : { color: 'yellow', confidence: 0.58 };
  }
  if (g >= r && g >= b) {
    return gn - rn < 0.1 ? { color: 'yellow', confidence: 0.5 } : { color: 'green', confidence: 0.62 };
  }
  return { color: 'white', confidence: 0.45 };
}

/**
 * 轨迹级颜色投票：只取高亮度帧（亮灯时颜色才可信），
 * 返回主色及（互光时的）次色。
 */
export function voteColors(
  samples: (Rgb | null)[],
  brightness?: (number | null)[],
): { colors: LightColor[]; perVote: Record<LightColor, number> } {
  const tally: Record<LightColor, number> = { red: 0, green: 0, white: 0, yellow: 0 };
  const pairs = samples.map((s, i) => ({ s, bright: brightness?.[i] ?? null }));
  const brights = pairs.map((p) => p.bright).filter((v): v is number => v !== null);
  // 只取亮度前 30% 的灯核帧投票：灯核颜色最饱和可信，
  // 中低亮度帧受雾/背景暖偏干扰严重，不参与判色
  const cutoff = brights.length
    ? [...brights].sort((a, b) => a - b)[Math.floor(brights.length * 0.7)]!
    : 0;
  let used = 0;
  for (const p of pairs) {
    if (!p.s) continue;
    if (p.bright !== null && p.bright < cutoff) continue;
    const { color } = classifyColor(p.s);
    tally[color]++;
    used++;
  }
  const total = used;
  if (total === 0) {
    return { colors: ['white'], perVote: tally };
  }
  const ordered = (Object.keys(tally) as LightColor[]).sort((a, b) => tally[b]! - tally[a]!);
  const primary = ordered[0]!;
  const secondary = ordered[1]!;
  // 白灯过曝/雾中会产生黄、红暖偏杂票：若主色为白且杂票对应样本蓝通道不低
  // （非真实饱和色），把杂票并入白，保持单色输出
  if (primary === 'white' && secondary !== 'white' && tally[secondary]! / total < 0.5) {
    const warmDrift = pairs.filter((p) => {
      if (!p.s || p.bright === null || p.bright < cutoff) return false;
      const { color } = classifyColor(p.s);
      return color === secondary;
    });
    const saturated = warmDrift.filter((p) => {
      const maxC = Math.max(p.s!.r, p.s!.g, p.s!.b);
      return p.s!.b / Math.max(maxC, 1) < 0.6; // 真实黄/红蓝通道明显低
    }).length;
    if (saturated / Math.max(1, warmDrift.length) < 0.5) {
      tally.white += tally[secondary]!;
      tally[secondary] = 0;
      const reordered = (Object.keys(tally) as LightColor[]).sort((a, b) => tally[b]! - tally[a]!);
      return { colors: [reordered[0]!], perVote: tally };
    }
  }
  // 次色占比需 ≥35% 才判双色：白灯过曝/雾中的暖色漂移只产生少量杂票，不应判互光
  if (tally[secondary]! / total >= 0.35 && secondary !== primary) {
    return { colors: [primary, secondary], perVote: tally };
  }
  return { colors: [primary], perVote: tally };
}

/**
 * 互光双色检测：只看亮帧，识别两种色相的成段交替。
 * 红相用 r/g 比值 >1.6 判定；绿相用 g/r 比值 >1.4 判定；
 * 其余亮帧归为白/黄相。过曝白光带暖色偏也不会误判成红/绿相。
 */
export function detectAlternation(
  samples: (Rgb | null)[],
  brightness: (number | null)[],
): { isAlternating: boolean; colors: LightColor[]; redRatio: number } {
  const brights = brightness.filter((v): v is number => v !== null);
  if (brights.length < 8) return { isAlternating: false, colors: [], redRatio: 0 };
  // 用低分位作门槛，保留较暗的色相段（红灯段通常比白灯段暗）
  const cutoff = [...brights].sort((a, b) => a - b)[Math.floor(brights.length * 0.25)] ?? 0;
  const phaseVotes: Record<string, number> = {};
  const phaseSeq: LightColor[] = [];
  let total = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const bright = brightness[i];
    if (!s || bright === null || bright === undefined || bright < cutoff) continue;
    total++;
    const rgRatio = s.r / Math.max(s.g, 1);
    const grRatio = s.g / Math.max(s.r, 1);
    let phase: LightColor;
    if (rgRatio > 1.6 && s.r > s.b) {
      phase = 'red';
    } else if (grRatio > 1.4 && s.g > s.b) {
      phase = 'green';
    } else {
      const { color } = classifyColor(s);
      phase = color === 'red' || color === 'green' ? 'white' : color;
    }
    phaseVotes[phase] = (phaseVotes[phase] ?? 0) + 1;
    phaseSeq.push(phase);
  }
  const entries = (Object.entries(phaseVotes) as [LightColor, number][]).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return { isAlternating: false, colors: [], redRatio: 0 };
  const [c1, n1] = entries[0]!;
  const [c2, n2] = entries[1]!;
  const r1 = n1 / total;
  const r2 = n2 / total;
  if (!(n1 >= 15 && n2 >= 15 && r1 >= 0.25 && r2 >= 0.25 && r1 <= 0.75 && r2 <= 0.75)) {
    return { isAlternating: false, colors: [], redRatio: (phaseVotes.red ?? 0) / total };
  }
  // 连续性验证：两种色相都要出现至少一段 ≥10 帧的连续段，
  // 雾致颜色漂移只有零散单帧，无法形成长连续段
  const maxRun = (color: LightColor): number => {
    let best = 0;
    let run = 0;
    for (const p of phaseSeq) {
      if (p === color) { run++; best = Math.max(best, run); }
      else run = 0;
    }
    return best;
  };
  if (maxRun(c1) < 10 || maxRun(c2) < 10) {
    return { isAlternating: false, colors: [], redRatio: (phaseVotes.red ?? 0) / total };
  }
  // 互光必须含高饱和色相（红或绿）：黄/白互转是过曝暖白漂移，不是真互光
  const hasSaturated = c1 === 'red' || c1 === 'green' || c2 === 'red' || c2 === 'green';
  if (!hasSaturated) {
    return { isAlternating: false, colors: [], redRatio: (phaseVotes.red ?? 0) / total };
  }
  return {
    isAlternating: true,
    colors: [c1, c2],
    redRatio: (phaseVotes.red ?? 0) / total,
  };
}

/** 合成器用：灯色对应的发光 RGB（雾中衰减前） */
export const COLOR_EMIT: Record<LightColor, Rgb> = {
  // 红灯绿/蓝通道压低，过曝后仍保持红相；黄灯保留高绿通道
  red: { r: 255, g: 36, b: 28 },
  green: { r: 26, g: 255, b: 88 },
  white: { r: 255, g: 255, b: 255 },
  yellow: { r: 255, g: 210, b: 50 },
};
