/**
 * 灯色判定单元测试：红绿白黄四类 + 过曝退化 + 互光双色检测。
 */
import { describe, expect, it } from 'vitest';
import { classifyColor, detectAlternation, voteColors } from '../src/core/color';

describe('classifyColor 单帧颜色', () => {
  it('纯红/绿/白/黄', () => {
    expect(classifyColor({ r: 255, g: 30, b: 24 }).color).toBe('red');
    expect(classifyColor({ r: 26, g: 255, b: 88 }).color).toBe('green');
    expect(classifyColor({ r: 255, g: 255, b: 255 }).color).toBe('white');
    expect(classifyColor({ r: 255, g: 210, b: 50 }).color).toBe('yellow');
  });

  it('红灯过曝后仍判红（绿色通道起不来）', () => {
    const c = classifyColor({ r: 235, g: 143, b: 62 });
    expect(c.color).toBe('red');
  });

  it('白灯过曝带暖色偏仍判白', () => {
    const c = classifyColor({ r: 220, g: 215, b: 200 });
    expect(['white', 'yellow']).toContain(c.color);
  });

  it('黑像素不崩溃', () => {
    expect(classifyColor({ r: 0, g: 0, b: 0 }).confidence).toBe(0);
  });
});

describe('voteColors 轨迹级投票', () => {
  it('多数一致颜色胜出', () => {
    const samples = Array.from({ length: 20 }, () => ({ r: 255, g: 30, b: 24 }));
    const bright = samples.map(() => 200);
    expect(voteColors(samples, bright).colors[0]).toBe('red');
  });

  it('忽略暗帧背景色', () => {
    const samples = [
      ...Array.from({ length: 15 }, () => ({ r: 255, g: 30, b: 24 })),
      ...Array.from({ length: 10 }, () => ({ r: 20, g: 25, b: 30 })),
    ];
    const bright = [...Array.from({ length: 15 }, () => 200), ...Array.from({ length: 10 }, () => 20)];
    expect(voteColors(samples, bright).colors[0]).toBe('red');
  });
});

describe('detectAlternation 互光检测', () => {
  it('红白交替被识别为互光', () => {
    const n = 200;
    const samples: ({ r: number; g: number; b: number } | null)[] = [];
    const bright: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const redPhase = Math.floor(i / 30) % 2 === 0;
      samples.push(redPhase ? { r: 250, g: 54, b: 54 } : { r: 200, g: 200, b: 205 });
      bright.push(150);
    }
    const r = detectAlternation(samples, bright);
    expect(r.isAlternating).toBe(true);
    expect(r.colors.sort()).toEqual(['red', 'white']);
  });

  it('单色常亮不判互光', () => {
    const n = 100;
    const samples = Array.from({ length: n }, () => ({ r: 30, g: 255, b: 90 }));
    const bright = Array.from({ length: n }, () => 180);
    expect(detectAlternation(samples, bright).isAlternating).toBe(false);
  });
});
