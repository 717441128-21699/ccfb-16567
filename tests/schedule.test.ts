/**
 * 灯质时刻表单元测试：验证 7 种灯质的周期、亮暗时序、故障注入。
 */
import { describe, expect, it } from 'vitest';
import { buildSchedule, LONG_ON, MORSE_DIT, QUICK_SLOT, SHORT_ON } from '../src/core/schedule';
import type { LightCharacteristic } from '../src/core/types';

const fps = 10;

function pulseLengths(on: Uint8Array): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const v of on) {
    if (v) cur++;
    else if (cur > 0) {
      out.push(cur);
      cur = 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

describe('buildSchedule 灯质时刻表', () => {
  it('单闪：每周期一次 0.5s 亮脉冲', () => {
    const s = buildSchedule({ characteristic: 'single-flash', periodSec: 4, groupSize: null, colors: ['red'], fps, durationSec: 12 });
    const pulses = pulseLengths(s.on);
    expect(pulses.length).toBe(3); // 12s / 4s
    expect(pulses[0]).toBe(Math.round(SHORT_ON * fps));
  });

  it('联闪：每周期固定组闪次', () => {
    const s = buildSchedule({ characteristic: 'group-flash', periodSec: 6, groupSize: 2, colors: ['red'], fps, durationSec: 12 });
    const pulses = pulseLengths(s.on);
    expect(pulses.length).toBe(4); // 2 组 × 2 闪
  });

  it('长闪：亮时 ≥2s', () => {
    const s = buildSchedule({ characteristic: 'long-flash', periodSec: 8, groupSize: null, colors: ['white'], fps, durationSec: 16 });
    const pulses = pulseLengths(s.on);
    expect(pulses[0]).toBeGreaterThanOrEqual(Math.round(LONG_ON * fps) - 1);
  });

  it('连续快闪：1s 一个节奏', () => {
    const s = buildSchedule({ characteristic: 'quick', periodSec: QUICK_SLOT, groupSize: null, colors: ['white'], fps, durationSec: 10 });
    const pulses = pulseLengths(s.on);
    expect(pulses.length).toBe(10);
  });

  it('互光：全程有光且色序交替', () => {
    const s = buildSchedule({ characteristic: 'alternating', periodSec: 6, groupSize: null, colors: ['red', 'white'], fps, durationSec: 12 });
    expect(s.on.every((v) => v === 1)).toBe(true);
    const colors = new Set(s.colorIndex);
    expect(colors.size).toBe(2);
  });

  it('莫尔斯 S：每组三个等长点', () => {
    const s = buildSchedule({ characteristic: 'morse', periodSec: 8, groupSize: null, colors: ['white'], fps, durationSec: 16 });
    const pulses = pulseLengths(s.on);
    expect(pulses.length).toBe(6); // 2 组 × 3 点
    expect(pulses[0]).toBe(Math.round(MORSE_DIT * fps));
  });

  it('常亮：全程亮', () => {
    const s = buildSchedule({ characteristic: 'fixed', periodSec: 0, groupSize: null, colors: ['green'], fps, durationSec: 10 });
    expect(s.on.every((v) => v === 1)).toBe(true);
  });

  it('故障 dead：全程灭', () => {
    const s = buildSchedule({ characteristic: 'single-flash', periodSec: 4, groupSize: null, colors: ['red'], fps, durationSec: 10, fault: 'dead' });
    expect(s.on.every((v) => v === 0)).toBe(true);
  });

  it('故障 steady：全程常亮', () => {
    const s = buildSchedule({ characteristic: 'group-flash', periodSec: 6, groupSize: 2, colors: ['green'], fps, durationSec: 10, fault: 'steady' });
    expect(s.on.every((v) => v === 1)).toBe(true);
  });

  it('故障 drift：周期漂移但仍周期性闪烁', () => {
    const s = buildSchedule({ characteristic: 'single-flash', periodSec: 6, groupSize: null, colors: ['yellow'], fps, durationSec: 30, fault: 'drift' });
    const pulses = pulseLengths(s.on);
    expect(pulses.length).toBeGreaterThan(2);
  });

  it('覆盖全部灯质枚举', () => {
    const all: LightCharacteristic[] = ['fixed', 'single-flash', 'group-flash', 'long-flash', 'quick', 'alternating', 'morse'];
    for (const ch of all) {
      const s = buildSchedule({ characteristic: ch, periodSec: 6, groupSize: ch === 'group-flash' ? 2 : null, colors: ['white'], fps, durationSec: 12 });
      expect(s.frames).toBe(120);
    }
  });
});
