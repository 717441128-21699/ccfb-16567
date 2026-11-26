/**
 * 灯质时刻表生成：按 IALA/国标常见灯质定义，把灯质展开为逐帧
 * 「亮灭 + 色序」状态。合成视频渲染与真值导出共用本模块，
 * 分类器的判读口径也以这里的时间定义为准。
 */
import type { LightCharacteristic, LightColor } from './types';

export interface ScheduleSpec {
  characteristic: LightCharacteristic;
  periodSec: number;
  groupSize: number | null;
  colors: LightColor[];
  fps: number;
  durationSec: number;
  fault?: 'none' | 'dead' | 'steady' | 'drift';
}

export interface Schedule {
  /** 逐帧亮灭 */
  on: Uint8Array;
  /** 逐帧色序号（互光在两色间切换，其余恒为 0） */
  colorIndex: Uint8Array;
  frames: number;
}

/** 单闪/联闪组内单次亮时（秒） */
export const SHORT_ON = 0.5;
/** 联闪组内亮闪间隔（秒） */
export const GROUP_GAP = 0.6;
/** 长闪亮时（秒，国标 LFl 亮不少于 2s） */
export const LONG_ON = 2.0;
/** 快闪基础节奏：1s 一次（60 次/分），亮 0.4s */
export const QUICK_SLOT = 1.0;
export const QUICK_ON = 0.4;
/** 莫尔斯电码点/划时长与间隔（秒）。码内间隔短，字母组间留长暗以形成周期 */
export const MORSE_DIT = 0.3;
export const MORSE_DASH = 0.9;
export const MORSE_GAP = 0.3;
/** 莫尔斯字母组之间的额外间隔（秒），叠加后组间暗明显长于码内暗 */
export const MORSE_GROUP_GAP = 2.4;

const MORSE_TABLE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
  H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
  O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
  V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
};

/** 周期内相位 u∈[0,1) 的灯质状态（标称节奏，不含故障） */
function nominalCycleState(spec: ScheduleSpec, u: number): { on: boolean; colorIndex: number } {
  const t = u * spec.periodSec;
  switch (spec.characteristic) {
    case 'fixed':
      return { on: true, colorIndex: 0 };
    case 'single-flash':
      return { on: t < SHORT_ON, colorIndex: 0 };
    case 'long-flash':
      return { on: t < LONG_ON, colorIndex: 0 };
    case 'group-flash': {
      const n = Math.max(1, spec.groupSize ?? 1);
      const slot = SHORT_ON + GROUP_GAP;
      const idx = Math.floor(t / slot);
      const inSlot = t - idx * slot;
      return { on: idx < n && inSlot < SHORT_ON, colorIndex: 0 };
    }
    case 'quick': {
      const n = spec.groupSize;
      if (n && n > 1) {
        // 联组快闪：n 个 1s 快闪 slot，组后长暗
        const idx = Math.floor(t / QUICK_SLOT);
        const inSlot = t - idx * QUICK_SLOT;
        return { on: idx < n && inSlot < QUICK_ON, colorIndex: 0 };
      }
      // 连续快闪
      return { on: t % QUICK_SLOT < QUICK_ON, colorIndex: 0 };
    }
    case 'alternating': {
      // 互光：两色各占半周期，全程有光
      const half = spec.periodSec / 2;
      return { on: true, colorIndex: Math.floor(t / half) % 2 };
    }
    case 'morse': {
      // 在周期内顺序布局 S(...)：点 0.3s + 码内暗 0.3s，组尾留长暗
      const code = MORSE_TABLE.S!;
      const dit = MORSE_DIT;
      const innerGap = MORSE_GAP;
      let cursor = 0;
      for (let k = 0; k < code.length; k++) {
        const onEnd = cursor + dit;
        if (t >= cursor && t < onEnd) return { on: true, colorIndex: 0 };
        cursor = onEnd + innerGap;
      }
      return { on: false, colorIndex: 0 };
    }
    default:
      return { on: false, colorIndex: 0 };
  }
}

export function buildSchedule(spec: ScheduleSpec): Schedule {
  const frames = Math.round(spec.durationSec * spec.fps);
  const on = new Uint8Array(frames);
  const colorIndex = new Uint8Array(frames);
  const fault = spec.fault ?? 'none';
  const dt = 1 / spec.fps;

  if (fault === 'dead') {
    return { on, colorIndex, frames };
  }
  if (fault === 'steady') {
    on.fill(1);
    return { on, colorIndex, frames };
  }

  // 莫尔斯用绝对时间码（点划时长是固定秒数，不能做相位积分）
  if (spec.characteristic === 'morse') {
    const ditFrames = Math.round(MORSE_DIT * spec.fps);
    const gapFrames = Math.round(MORSE_GAP * spec.fps);
    const periodFrames = Math.round(spec.periodSec * spec.fps);
    // S(...) 三个点的起始帧（周期内）
    const starts = [0, ditFrames + gapFrames, 2 * (ditFrames + gapFrames)];
    for (let f = 0; f < frames; f++) {
      const phase = f % periodFrames;
      const lit = starts.some((s) => phase >= s && phase < s + ditFrames);
      on[f] = lit ? 1 : 0;
    }
    return { on, colorIndex, frames };
  }

  // 其余周期灯质：相位积分，drift 故障让周期在 ±15% 内缓慢漂移
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const tNow = f * dt;
    let period = spec.periodSec;
    if (fault === 'drift') {
      period = spec.periodSec * (1 + 0.15 * Math.sin((2 * Math.PI * tNow) / Math.max(spec.durationSec * 0.5, 1)));
    }
    const u = phase % 1;
    const st = nominalCycleState(spec, u);
    on[f] = st.on ? 1 : 0;
    colorIndex[f] = st.colorIndex;
    phase += dt / period;
  }
  return { on, colorIndex, frames };
}

/** 供分类器测试/文档使用：莫尔斯码表 */
export function morseCode(letter: string): string | null {
  return MORSE_TABLE[letter.toUpperCase()] ?? null;
}
