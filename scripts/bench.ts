/**
 * 达标评测：三种浪高/雾浓度场景 × 20 盏真值灯，
 * 统计灯质种类误判率、周期误差、灯色误判率、跟踪配对率、分析耗时。
 *
 * 运行：npm run bench
 */
import { runHeadless } from '../src/core/headless';
import { describeKind, COLOR_LABEL } from '../src/core/lightModel';
import { buildScenario, SCENARIO_TEMPLATES } from '../src/core/scenarios';
import { SyntheticScene } from '../src/core/synthetic';
import { DEFAULT_CONFIG } from '../src/core/types';
import type { LightCharacteristics, TestScenario, TrackAnalysis } from '../src/core/types';

interface Row {
  scenario: string;
  beaconId: string;
  truth: LightCharacteristics;
  measured?: LightCharacteristics;
  kindOk: boolean;
  colorOk: boolean;
  periodErr: number | null;
  matched: boolean;
}

interface ScenarioSummary {
  name: string;
  total: number;
  matched: number;
  kindErrors: number;
  colorErrors: number;
  periodOverTol: number;
  maxPeriodErr: number;
  rows: Row[];
  elapsedMs: number;
  videoSec: number;
  distractorFlagged: number;
  distractorTotal: number;
}

function evaluate(): void {
  const config = { ...DEFAULT_CONFIG };
  // 固定种子：三种场景各自可复现，bench 与单独调试结果一致
  const scenarios = SCENARIO_TEMPLATES.map((tpl, i) => buildScenario(tpl, 60, 100 + i));
  const summaries: ScenarioSummary[] = [];
  const allRows: Row[] = [];

  for (const built of scenarios) {
    const { scenario, beacons } = built;
    const tStart = performance.now();
    const scene = new SyntheticScene(scenario, {
      width: config.analyzeWidth,
      height: 270,
      fog: scenario.fog,
      waveHeightM: scenario.waveHeightM,
    });
    const run = runHeadless(scene, config);
    const elapsedMs = performance.now() - tStart;

    const analysisByTrack = new Map(run.analyses.map((a: TrackAnalysis) => [a.trackId, a]));
    const rows: Row[] = [];
    let kindErrors = 0;
    let colorErrors = 0;
    let periodOverTol = 0;
    let maxPeriodErr = 0;
    let matched = 0;

    // 评测算法本体：每盏真值灯按最近轨迹对照，不依赖航标自动配对（配对另算）
    beacons.forEach((beacon, idx) => {
      const truthLight = scenario.lights.find((l) => l.lightId === idx + 1)!;
      const tx = truthLight.nx * config.analyzeWidth;
      const ty = truthLight.ny * 270;
      const nearest = run.tracks
        .map((t) => ({ t, d: Math.hypot(t.cx - tx, t.cy - ty) }))
        .sort((a, b) => a.d - b.d)[0];
      const analysis = nearest && nearest.d < 40
        ? analysisByTrack.get(nearest.t.id)
        : undefined;
      const measured = analysis?.measured;
      // 故障灯真值是 fixed，航标表标称是闪灯；评测以"视频真值"为准
      const truth = truthLight.characteristics;
      const row: Row = {
        scenario: scenario.id,
        beaconId: beacon.id,
        truth,
        measured,
        matched: !!measured,
        kindOk: false,
        colorOk: !measured ? false : measured.color === truth.color,
        periodErr: null,
      };
      if (measured) {
        matched++;
        row.kindOk = measured.kind === truth.kind;
        if (!row.kindOk) kindErrors++;
        if (!row.colorOk) colorErrors++;
        if (truth.kind !== 'fixed') {
          row.periodErr = Math.abs(measured.periodSec - truth.periodSec);
          maxPeriodErr = Math.max(maxPeriodErr, row.periodErr);
          if (row.periodErr > 0.2) periodOverTol++;
        }
      } else {
        kindErrors++;
        colorErrors++;
      }
      rows.push(row);
      allRows.push(row);
    });

    // 干扰源识别评估（纯干扰 5 个 + 故障灯 2 个）
    const pureDistractors = scenario.lights.filter((l) => l.distractor && l.distractorKind !== 'steady');
    let flagged = 0;
    for (const d of pureDistractors) {
      // 找距干扰源真值最近的轨迹
      const dx = d.nx * config.analyzeWidth;
      const dy = d.ny * 270;
      const nearest = run.tracks
        .map((t) => ({ t, dist: Math.hypot(t.cx - dx, t.cy - dy) }))
        .sort((a, b) => a.dist - b.dist)[0];
      const an = nearest ? run.analyses.find((a) => a.trackId === nearest.t.id) : undefined;
      if (an?.isDistractor) flagged++;
    }

    summaries.push({
      name: scenario.name,
      total: beacons.length,
      matched,
      kindErrors,
      colorErrors,
      periodOverTol,
      maxPeriodErr,
      rows,
      elapsedMs,
      videoSec: scenario.durationSec,
      distractorFlagged: flagged,
      distractorTotal: pureDistractors.length,
    });
  }

  printReport(summaries, allRows, scenarios.map((s) => s.scenario));
}

function printReport(summaries: ScenarioSummary[], allRows: Row[], scenarios: TestScenario[]): void {
  console.log('\n================ 航标灯质核查达标评测 ================\n');
  for (const s of summaries) {
    const kindRate = ((s.total - s.kindErrors) / s.total) * 100;
    const colorRate = ((s.total - s.colorErrors) / s.total) * 100;
    console.log(`【${s.name}】`);
    console.log(`  跟踪配对：${s.matched}/${s.total}`);
    console.log(`  灯质种类正确率：${kindRate.toFixed(1)}%（指标 ≥95%）${kindRate >= 95 ? ' ✅' : ' ❌'}`);
    console.log(`  灯色正确率：${colorRate.toFixed(1)}%（指标 ≥98%）${colorRate >= 98 ? ' ✅' : ' ❌'}`);
    console.log(`  周期超差(>0.2s)：${s.periodOverTol} 盏，最大误差 ${s.maxPeriodErr.toFixed(3)}s`);
    console.log(`  纯干扰源标记：${s.distractorFlagged}/${s.distractorTotal}`);
    const speedOk = s.elapsedMs < 60_000 && s.videoSec >= 60;
    console.log(`  处理耗时：${(s.elapsedMs / 1000).toFixed(2)}s（${s.videoSec}s 视频，1 分钟内 ✔ 要求）${speedOk ? ' ✅' : ' ❌'}`);
    console.log('');
  }

  const total = allRows.length;
  const kindErrors = allRows.filter((r) => !r.kindOk).length;
  const colorErrors = allRows.filter((r) => !r.colorOk).length;
  const periodErrs = allRows.map((r) => r.periodErr).filter((v): v is number => v !== null);
  console.log('---------------- 全场景汇总 ----------------');
  console.log(`灯质种类误判率：${((kindErrors / total) * 100).toFixed(2)}%（限值 5%）${kindErrors / total <= 0.05 ? ' ✅' : ' ❌'}`);
  console.log(`灯色误判率：${((colorErrors / total) * 100).toFixed(2)}%（限值 2%）${colorErrors / total <= 0.02 ? ' ✅' : ' ❌'}`);
  console.log(`周期最大误差：${Math.max(...periodErrs).toFixed(3)}s（限值 0.2s）`);
  console.log(`周期平均误差：${(periodErrs.reduce((a, b) => a + b, 0) / periodErrs.length).toFixed(3)}s`);

  console.log('\n---------------- 误判明细 ----------------');
  const bad = allRows.filter((r) => !r.kindOk || !r.colorOk || (r.periodErr !== null && r.periodErr > 0.2));
  if (bad.length === 0) {
    console.log('无超差项');
  } else {
    for (const r of bad) {
      const parts = [
        `[${r.scenario}] ${r.beaconId}`,
        `真值=${describeKind(r.truth)} ${COLOR_LABEL[r.truth.color]} 周期${r.truth.periodSec}s`,
        r.measured
          ? `实测=${describeKind(r.measured)} ${COLOR_LABEL[r.measured.color]} 周期${r.measured.periodSec.toFixed(2)}s`
          : '实测=未跟踪',
      ];
      if (!r.kindOk) parts.push('种类错');
      if (!r.colorOk) parts.push('颜色错');
      if (r.periodErr !== null && r.periodErr > 0.2) parts.push(`周期差${r.periodErr.toFixed(2)}s`);
      console.log('  ' + parts.join(' | '));
    }
  }
  void scenarios;
  console.log('\n======================================================\n');
}

evaluate();
