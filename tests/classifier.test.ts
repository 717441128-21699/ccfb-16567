/**
 * 分类器端到端测试：从合成亮度序列判读 7 种灯质，验证周期/组闪/颜色。
 */
import { describe, expect, it } from 'vitest';
import { classifyTrack } from '../src/core/classifier';
import { buildSchedule } from '../src/core/schedule';
import type { LightColor, Track } from '../src/core/types';

const fps = 10;
const frames = 600; // 60s

function makeTrack(ch: Parameters<typeof buildSchedule>[0]['characteristic'], periodSec: number, groupSize: number | null, color: LightColor, fault?: 'none' | 'dead' | 'steady' | 'drift'): Track {
  const sched = buildSchedule({ characteristic: ch, periodSec, groupSize, colors: [color], fps, durationSec: frames / fps, fault });
  const emit: Record<LightColor, { r: number; g: number; b: number }> = {
    red: { r: 255, g: 36, b: 28 },
    green: { r: 26, g: 255, b: 88 },
    white: { r: 255, g: 255, b: 255 },
    yellow: { r: 255, g: 210, b: 50 },
  };
  const brightness: (number | null)[] = [];
  const colors: Track['colors'] = [];
  for (let f = 0; f < frames; f++) {
    if (sched.on[f]) {
      brightness.push(200);
      colors.push(emit[color]);
    } else {
      brightness.push(null);
      colors.push(null);
    }
  }
  return {
    id: 1,
    positions: brightness.map(() => ({ x: 100, y: 100 })),
    brightness,
    colors,
    firstFrame: 0,
    lastSeenFrame: frames - 1,
    hitCount: frames,
    confirmed: true,
    rejected: null,
  };
}

describe('classifyTrack 灯质分类', () => {
  it('单闪 Fl(4s)', () => {
    const r = classifyTrack(makeTrack('single-flash', 4, null, 'red'), { fps });
    expect(r.characteristic).toBe('single-flash');
    expect(Math.abs(r.periodSec! - 4)).toBeLessThanOrEqual(0.2);
    expect(r.colors).toContain('red');
  });

  it('联闪 Fl(2) 6s', () => {
    const r = classifyTrack(makeTrack('group-flash', 6, 2, 'green'), { fps });
    expect(r.characteristic).toBe('group-flash');
    expect(r.groupSize).toBe(2);
    expect(Math.abs(r.periodSec! - 6)).toBeLessThanOrEqual(0.2);
  });

  it('长闪 LFl 8s', () => {
    const r = classifyTrack(makeTrack('long-flash', 8, null, 'white'), { fps });
    expect(r.characteristic).toBe('long-flash');
    expect(r.onDurationSec!).toBeGreaterThanOrEqual(1.5);
  });

  it('连续快闪 Q 1s', () => {
    const r = classifyTrack(makeTrack('quick', 1, null, 'white'), { fps });
    expect(r.characteristic).toBe('quick');
    expect(r.flashesPerMinute).toBeGreaterThanOrEqual(50);
  });

  it('联组快闪 Q(3) 5s', () => {
    const r = classifyTrack(makeTrack('quick', 5, 3, 'yellow'), { fps });
    expect(r.characteristic).toBe('quick');
    expect(r.groupSize).toBe(3);
  });

  it('互光 Al 红白 6s', () => {
    const t = makeTrack('alternating', 6, null, 'red');
    // 互光需要双色，手动注入白色相
    const sched = buildSchedule({ characteristic: 'alternating', periodSec: 6, groupSize: null, colors: ['red', 'white'], fps, durationSec: frames / fps });
    for (let f = 0; f < frames; f++) {
      t.colors[f] = sched.colorIndex[f] === 1 ? { r: 255, g: 255, b: 255 } : { r: 255, g: 36, b: 28 };
      t.brightness[f] = 180;
    }
    const r = classifyTrack(t, { fps });
    expect(r.characteristic).toBe('alternating');
    expect(r.colors.sort()).toEqual(['red', 'white']);
  });

  it('莫尔斯 Mo(S) 8s', () => {
    const r = classifyTrack(makeTrack('morse', 8, null, 'white'), { fps });
    expect(r.characteristic).toBe('morse');
    expect(r.morseLetter).toBe('S');
    expect(Math.abs(r.periodSec! - 8)).toBeLessThanOrEqual(0.3);
  });

  it('常亮 F', () => {
    const r = classifyTrack(makeTrack('fixed', 0, null, 'green'), { fps });
    expect(r.characteristic).toBe('fixed');
  });

  it('常亮故障 steady 被判 fixed', () => {
    const r = classifyTrack(makeTrack('group-flash', 6, 2, 'green', 'steady'), { fps });
    expect(r.characteristic).toBe('fixed');
  });

  it('周期测量误差 ≤0.2s（多周期中位）', () => {
    const r = classifyTrack(makeTrack('single-flash', 5, null, 'white'), { fps });
    expect(Math.abs(r.periodSec! - 5)).toBeLessThanOrEqual(0.2);
  });
});
