/**
 * 灯质时间模型单元测试
 */
import { describe, expect, it } from 'vitest';
import { makeLight, morseCycleSec, morseSchedule, stateAtTime } from '../src/core/lightModel';

describe('stateAtTime 灯质时间函数', () => {
  it('单闪：周期 6s 明 0.5s', () => {
    const c = makeLight({ kind: 'single', color: 'red', periodSec: 6, onSec: 0.5 });
    expect(stateAtTime(c, 0).on).toBe(true);
    expect(stateAtTime(c, 0.4).on).toBe(true);
    expect(stateAtTime(c, 1).on).toBe(false);
    expect(stateAtTime(c, 5.9).on).toBe(false);
    expect(stateAtTime(c, 6.1).on).toBe(true); // 下一周期
  });

  it('联闪(2)：每周期两次明，中间短暗', () => {
    const c = makeLight({ kind: 'group', color: 'red', groupCount: 2, periodSec: 10, onSec: 0.5 });
    expect(stateAtTime(c, 0).on).toBe(true);
    expect(stateAtTime(c, 0.7).on).toBe(false); // 组内暗
    expect(stateAtTime(c, 1.1).on).toBe(true);  // 第二次闪
    expect(stateAtTime(c, 2).on).toBe(false);   // 组间长暗
    expect(stateAtTime(c, 9.9).on).toBe(false);
  });

  it('快闪：60 次/分，间隔 1s', () => {
    const c = makeLight({ kind: 'quick', color: 'yellow', periodSec: 1, onSec: 0.5 });
    expect(stateAtTime(c, 0).on).toBe(true);
    expect(stateAtTime(c, 0.7).on).toBe(false);
    expect(stateAtTime(c, 1.2).on).toBe(true);
  });

  it('长闪：明时长 2.5s', () => {
    const c = makeLight({ kind: 'longFlash', color: 'white', periodSec: 8, onSec: 2.5 });
    expect(stateAtTime(c, 2).on).toBe(true);
    expect(stateAtTime(c, 3).on).toBe(false);
  });

  it('互光：两色交替', () => {
    const c = makeLight({
      kind: 'alternating', color: 'red', alternateColor: 'white', periodSec: 6, onSec: 6,
    });
    expect(stateAtTime(c, 0).color).toBe('red');
    expect(stateAtTime(c, 4).color).toBe('white');
    expect(stateAtTime(c, 0).on).toBe(true);
  });

  it('莫尔斯 A：点-划，周期内明暗序列正确', () => {
    const c = makeLight({ kind: 'morse', color: 'white', morseLetter: 'A', onSec: 0.4, periodSec: 8.8 });
    // A = .- ，点明 0~0.4，码元暗 0.4~0.8，划明 0.8~2.0，之后长暗
    expect(stateAtTime(c, 0.2).on).toBe(true);   // 点
    expect(stateAtTime(c, 0.5).on).toBe(false);  // 码元间隔
    expect(stateAtTime(c, 1.0).on).toBe(true);   // 划
    expect(stateAtTime(c, 1.9).on).toBe(true);   // 划仍在持续
    expect(stateAtTime(c, 2.1).on).toBe(false);  // 划结束，进入长暗
    expect(stateAtTime(c, 3.0).on).toBe(false);  // 长暗
  });

  it('常亮：任何时刻都明', () => {
    const c = makeLight({ kind: 'fixed', color: 'green' });
    expect(stateAtTime(c, 123).on).toBe(true);
  });
});

describe('莫尔斯调度', () => {
  it('A 的单位序列为 1明 1暗 3明 7暗', () => {
    const sched = morseSchedule('A');
    expect(sched.map((s) => ({ on: s.on, units: s.units }))).toEqual([
      { on: true, units: 1 },
      { on: false, units: 1 },
      { on: true, units: 3 },
      { on: false, units: 7 },
    ]);
  });

  it('周期时长 = 单位序列总和 × 单位秒', () => {
    expect(morseCycleSec('A', 0.4)).toBeCloseTo(12 * 0.4);
  });
});
