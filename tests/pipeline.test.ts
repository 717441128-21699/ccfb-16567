/**
 * 端到端集成测试：合成场景 -> 检测 -> 跟踪 -> 分析全管线，
 * 验证跟踪配对率、灯质种类、灯色、耗时满足验收指标。
 * 全场景只跑一次管线，各断言复用结果（1200 帧渲染较重，避免重复构造）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { runHeadless } from '../src/core/headless';
import { buildScenario, SCENARIO_TEMPLATES } from '../src/core/scenarios';
import { SyntheticScene } from '../src/core/synthetic';
import { DEFAULT_CONFIG } from '../src/core/types';
import type { TrackAnalysis } from '../src/core/types';

describe('端到端核查管线（小浪晴朗）', () => {
  let built: ReturnType<typeof buildScenario>;
  let run: ReturnType<typeof runHeadless>;
  let config: typeof DEFAULT_CONFIG;
  let elapsedMs = 0;

  beforeAll(() => {
    config = { ...DEFAULT_CONFIG };
    const tpl = SCENARIO_TEMPLATES[0]!;
    built = buildScenario(tpl, 60, 100);
    const scene = new SyntheticScene(built.scenario, {
      width: config.analyzeWidth,
      height: 270,
      fog: tpl.fog,
      waveHeightM: tpl.waveHeightM,
    });
    const t0 = performance.now();
    run = runHeadless(scene, config);
    elapsedMs = performance.now() - t0;
  }, 30000);

  function nearestAnalysis(idx: number): TrackAnalysis | undefined {
    const light = built.scenario.lights[idx]!;
    const nearest = run.tracks
      .map((t) => ({ t, d: Math.hypot(t.cx - light.nx * config.analyzeWidth, t.cy - light.ny * 270) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!nearest || nearest.d >= 40) return undefined;
    return run.analyses.find((a) => a.trackId === nearest.t.id);
  }

  it('20 盏灯全部跟踪配对', () => {
    const matched = built.beacons.filter((_, idx) => nearestAnalysis(idx) !== undefined).length;
    expect(matched).toBe(20);
  });

  it('灯质种类正确率 ≥ 95%', () => {
    const correct = built.beacons.filter((_, idx) => {
      const an = nearestAnalysis(idx);
      return an && an.measured.kind === built.scenario.lights[idx]!.characteristics.kind;
    }).length;
    expect(correct / 20).toBeGreaterThanOrEqual(0.95);
  });

  it('灯色正确率 ≥ 98%', () => {
    const correct = built.beacons.filter((_, idx) => {
      const an = nearestAnalysis(idx);
      return an && an.measured.color === built.scenario.lights[idx]!.characteristics.color;
    }).length;
    expect(correct / 20).toBeGreaterThanOrEqual(0.98);
  });

  it('常规闪烁灯周期绝大多数误差 ≤ 0.2s', () => {
    const errors: number[] = [];
    built.beacons.forEach((_, idx) => {
      const truth = built.scenario.lights[idx]!.characteristics;
      if (truth.kind === 'fixed') return;
      const an = nearestAnalysis(idx);
      if (an) errors.push(Math.abs(an.measured.periodSec - truth.periodSec));
    });
    const withinTol = errors.filter((e) => e <= 0.2).length;
    expect(withinTol / errors.length).toBeGreaterThanOrEqual(0.9);
  });

  it('60 秒视频分析耗时远低于 1 分钟', () => {
    expect(run.frameCount).toBeGreaterThan(1000);
    expect(elapsedMs).toBeLessThan(60_000);
  });
}, 30000);
