/**
 * 灯质信号模型：给定灯质与时间 t，返回该时刻的明/暗与颜色。
 * 合成测试视频、单元测试的真值都从这里出，保证"标称"与"实测"共用同一套时间定义。
 */
import type { LightCharacteristics, LightColor, LightKind } from './types';

export const MORSE_CODE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.',
  G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
};

const MORSE_REVERSE: Readonly<Record<string, string>> =
  Object.fromEntries(Object.entries(MORSE_CODE).map(([k, v]) => [v, k]));

export function morseLetter(pattern: string): string | undefined {
  return MORSE_REVERSE[pattern];
}

export interface LightState {
  on: boolean;
  color: LightColor;
}

/** 莫尔斯灯一个完整周期内的明(+)暗(-)单位序列，单位长度 = onSec */
export function morseSchedule(letter: string): { on: boolean; units: number }[] {
  const pattern = MORSE_CODE[letter.toUpperCase()];
  if (!pattern) throw new Error(`未知莫尔斯字符: ${letter}`);
  const schedule: { on: boolean; units: number }[] = [];
  const chars = pattern.split('');
  chars.forEach((sym, i) => {
    schedule.push({ on: true, units: sym === '.' ? 1 : 3 });
    if (i < chars.length - 1) schedule.push({ on: false, units: 1 }); // 码元间隔
  });
  schedule.push({ on: false, units: 7 }); // 周期末长暗
  return schedule;
}

export function morseCycleSec(letter: string, unitSec: number): number {
  return morseSchedule(letter).reduce((s, e) => s + e.units, 0) * unitSec;
}

export function stateAtTime(c: LightCharacteristics, t: number): LightState {
  const phase = ((t % c.periodSec) + c.periodSec) % c.periodSec;
  switch (c.kind) {
    case 'fixed':
      return { on: true, color: c.color };
    case 'alternating': {
      const color = phase < c.periodSec / 2 ? c.color : (c.alternateColor ?? c.color);
      return { on: true, color };
    }
    case 'single':
    case 'longFlash':
      return { on: phase < c.onSec, color: c.color };
    case 'quick': {
      const slot = c.periodSec; // periodSec 存闪光间隔
      return { on: phase % slot < c.onSec, color: c.color };
    }
    case 'group': {
      const n = c.groupCount ?? 2;
      const slot = 2 * c.onSec; // 明 onSec + 同长短暗
      const idx = Math.floor(phase / slot);
      const inFlash = idx < n && phase - idx * slot < c.onSec;
      return { on: inFlash, color: c.color };
    }
    case 'morse': {
      const u = c.onSec;
      let cursor = 0;
      for (const e of morseSchedule(c.morseLetter ?? 'A')) {
        const dur = e.units * u;
        if (phase < cursor + dur) return { on: e.on, color: c.color };
        cursor += dur;
      }
      return { on: false, color: c.color };
    }
  }
}

/** 组闪（联闪）一个周期的总活动时长 */
export function groupActiveSec(kind: LightKind, groupCount: number, onSec: number): number {
  if (kind !== 'group') return onSec;
  return groupCount * onSec + (groupCount - 1) * onSec;
}

const KIND_LABEL: Record<LightKind, string> = {
  fixed: '常亮',
  single: '单闪',
  group: '联闪',
  longFlash: '长闪',
  quick: '快闪',
  alternating: '互光',
  morse: '莫尔斯',
};

export const COLOR_LABEL: Record<LightColor, string> = {
  red: '红', green: '绿', white: '白', yellow: '黄',
};

export function describeKind(c: LightCharacteristics): string {
  switch (c.kind) {
    case 'group':
      return `${KIND_LABEL.group}(${c.groupCount ?? 2})`;
    case 'morse':
      return `莫尔斯(${c.morseLetter ?? '?'})`;
    case 'alternating':
      return `${KIND_LABEL.alternating}(${COLOR_LABEL[c.color]}/${COLOR_LABEL[c.alternateColor ?? 'white']})`;
    default:
      return KIND_LABEL[c.kind];
  }
}

export function describeLight(c: LightCharacteristics): string {
  const period = c.kind === 'quick'
    ? `间隔${c.periodSec.toFixed(2)}s`
    : `周期${c.periodSec.toFixed(1)}s`;
  return `${describeKind(c)} ${period} 明${c.onSec.toFixed(2)}s ${COLOR_LABEL[c.color]}`;
}

export function makeLight(partial: Partial<LightCharacteristics> & Pick<LightCharacteristics, 'kind' | 'color'>): LightCharacteristics {
  const defaults: Record<LightKind, LightCharacteristics> = {
    fixed: { kind: 'fixed', periodSec: 1, onSec: 1, color: partial.color },
    single: { kind: 'single', periodSec: 6, onSec: 0.5, color: partial.color },
    group: { kind: 'group', groupCount: 2, periodSec: 10, onSec: 0.5, color: partial.color },
    longFlash: { kind: 'longFlash', periodSec: 8, onSec: 2.5, color: partial.color },
    quick: { kind: 'quick', periodSec: 60 / 60, onSec: 0.5, color: partial.color },
    alternating: {
      kind: 'alternating', periodSec: 6, onSec: 6, color: partial.color,
      alternateColor: partial.alternateColor ?? 'white',
    },
    morse: { kind: 'morse', periodSec: 10, onSec: 0.4, morseLetter: 'A', color: partial.color },
  };
  return { ...defaults[partial.kind], ...partial };
}
