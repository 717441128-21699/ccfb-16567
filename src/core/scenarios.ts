/**
 * 测试场景工厂：按浪高/雾浓度组合造场景，每场景 20 盏灯，
 * 灯质覆盖单闪/联闪/长闪/快闪/互光/莫尔斯/常亮（故障注入），灯色覆盖红绿白黄。
 * 同时产出与场景真值一致的航标表。
 */
import { makeLight } from './lightModel';
import type { Beacon, GroundTruthLight, LightColor, TestScenario } from './types';

interface ScenarioTemplate {
  id: string;
  name: string;
  waveHeightM: number;
  fog: number;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  { id: 'calm-clear', name: '小浪晴朗（浪高 0.5m，雾 0.1）', waveHeightM: 0.5, fog: 0.1 },
  { id: 'mid-mist', name: '中浪轻雾（浪高 1.2m，雾 0.35）', waveHeightM: 1.2, fog: 0.35 },
  { id: 'rough-fog', name: '大浪浓雾（浪高 2.0m，雾 0.6）', waveHeightM: 2.0, fog: 0.6 },
];

const COLORS: LightColor[] = ['red', 'green', 'white', 'yellow'];

/** 20 盏灯的灯质配方（覆盖全部种类与颜色） */
function lightRecipes(): { kind: Parameters<typeof makeLight>[0]['kind']; color: LightColor; extra?: Record<string, unknown> }[] {
  return [
    { kind: 'single', color: 'red' },
    { kind: 'single', color: 'green' },
    { kind: 'group', color: 'red', extra: { groupCount: 2, periodSec: 10, onSec: 0.5 } },
    { kind: 'group', color: 'green', extra: { groupCount: 3, periodSec: 12, onSec: 0.5 } },
    { kind: 'group', color: 'white', extra: { groupCount: 4, periodSec: 15, onSec: 0.4 } },
    { kind: 'longFlash', color: 'white', extra: { periodSec: 8, onSec: 2.5 } },
    { kind: 'longFlash', color: 'yellow', extra: { periodSec: 10, onSec: 3 } },
    { kind: 'quick', color: 'yellow', extra: { periodSec: 1, onSec: 0.5 } },       // 60 次/分
    { kind: 'quick', color: 'white', extra: { periodSec: 0.75, onSec: 0.37 } },    // 80 次/分
    { kind: 'alternating', color: 'red', extra: { alternateColor: 'white', periodSec: 6, onSec: 6 } },
    { kind: 'alternating', color: 'green', extra: { alternateColor: 'yellow', periodSec: 8, onSec: 8 } },
    { kind: 'morse', color: 'white', extra: { morseLetter: 'A', onSec: 0.4, periodSec: 8.8 } },
    { kind: 'morse', color: 'red', extra: { morseLetter: 'U', onSec: 0.35, periodSec: 9.8 } },
    { kind: 'morse', color: 'green', extra: { morseLetter: 'K', onSec: 0.3, periodSec: 9.3 } },
    { kind: 'single', color: 'yellow', extra: { periodSec: 5, onSec: 0.6 } },
    { kind: 'single', color: 'white', extra: { periodSec: 7, onSec: 0.4 } },
    { kind: 'group', color: 'yellow', extra: { groupCount: 2, periodSec: 8, onSec: 0.6 } },
    { kind: 'longFlash', color: 'red', extra: { periodSec: 12, onSec: 2.2 } },
    // 两盏故障灯：标称单闪/联闪，实际常亮（视频里按 steady 干扰渲染，航标表仍记标称）
    { kind: 'single', color: 'red', extra: { periodSec: 6, onSec: 0.5, _fault: 'steady' } },
    { kind: 'group', color: 'green', extra: { groupCount: 2, periodSec: 10, onSec: 0.5, _fault: 'steady' } },
  ];
}

let seedCounter = 1;

export function buildScenario(template: ScenarioTemplate, durationSec = 60, seed?: number): {
  scenario: TestScenario;
  beacons: Beacon[];
  hints: Record<string, { nx: number; ny: number }>;
} {
  const recipes = lightRecipes();
  // 允许传入固定种子保证可复现；否则用自增计数器
  const layoutSeed = seed ?? seedCounter;
  const lights: GroundTruthLight[] = [];
  const beacons: Beacon[] = [];
  const hints: Record<string, { nx: number; ny: number }> = {};
  // 5 列 x 4 行网格，加小偏移避免过于规整
  const cols = 5;
  recipes.forEach((recipe, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const jitter = ((i * 37 + layoutSeed * 13) % 11) / 100;
    const nx = 0.08 + col * (0.84 / (cols - 1)) + jitter * 0.2;
    const ny = 0.12 + row * 0.2 + jitter * 0.15;
    const id = `B${String(i + 1).padStart(3, '0')}`;
    const nominal = makeLight({
      kind: recipe.kind,
      color: recipe.color,
      ...(recipe.extra ?? {}),
    } as Parameters<typeof makeLight>[0]);
    const isFault = recipe.extra && '_fault' in recipe.extra;
    lights.push({
      lightId: i + 1,
      nx: Math.min(0.97, nx),
      ny: Math.min(0.9, ny),
      characteristics: isFault
        ? makeLight({ kind: 'fixed', color: recipe.color })
        : nominal,
      distractor: isFault,
      distractorKind: isFault ? 'steady' : undefined,
    });
    beacons.push({
      id,
      name: `${row + 1} 排 ${col + 1} 号灯浮`,
      location: `网格 ${col + 1}-${row + 1}`,
      nominal,
      note: isFault ? '巡检重点：历史故障灯器' : undefined,
    });
    hints[id] = { nx: Math.min(0.97, nx), ny: Math.min(0.9, ny) };
  });

  // 纯干扰源（不进航标表）：2 路灯 + 1 移动船灯 + 2 倒影
  const distractors: GroundTruthLight[] = [
    {
      lightId: 101, nx: 0.04, ny: 0.06,
      characteristics: makeLight({ kind: 'fixed', color: 'yellow' }),
      distractor: true, distractorKind: 'street',
    },
    {
      lightId: 102, nx: 0.92, ny: 0.08,
      characteristics: makeLight({ kind: 'fixed', color: 'yellow' }),
      distractor: true, distractorKind: 'street',
    },
    {
      lightId: 103, nx: 0.3, ny: 0.5,
      characteristics: makeLight({ kind: 'fixed', color: 'white' }),
      distractor: true, distractorKind: 'boat',
    },
    {
      lightId: 104, nx: 0.22, ny: 0.72,
      characteristics: makeLight({ kind: 'fixed', color: 'red' }),
      distractor: true, distractorKind: 'reflection',
    },
    {
      lightId: 105, nx: 0.68, ny: 0.78,
      characteristics: makeLight({ kind: 'fixed', color: 'green' }),
      distractor: true, distractorKind: 'reflection',
    },
  ];

  const scenario: TestScenario = {
    id: template.id,
    name: template.name,
    waveHeightM: template.waveHeightM,
    fog: template.fog,
    durationSec,
    lights: [...lights, ...distractors],
  };
  if (seed === undefined) seedCounter++;
  return { scenario, beacons, hints };
}

export function buildAllScenarios(durationSec = 60) {
  return SCENARIO_TEMPLATES.map((tpl) => ({ template: tpl, ...buildScenario(tpl, durationSec) }));
}

export { COLORS };
