/**
 * 内置示例航标表与合成测试场景。
 * 20 座航标覆盖 7 种灯质 × 4 种灯色，并注入 3 类故障灯；
 * 另含路灯/船灯干扰与海面倒影，由合成器自动生成。
 */
import { makeAidLight } from './synthetic';
import type { AidEntry, GroundTruthLight, SceneConfig } from './types';

export const SAMPLE_AIDS: AidEntry[] = [
  { id: 'A01', name: '1号灯浮（进口左侧）', characteristic: 'single-flash', groupSize: null, periodSec: 4, colors: ['red'], onDurationSec: 0.5 },
  { id: 'A02', name: '2号灯浮（进口右侧）', characteristic: 'single-flash', groupSize: null, periodSec: 4, colors: ['green'], onDurationSec: 0.5 },
  { id: 'A03', name: '3号灯浮', characteristic: 'group-flash', groupSize: 2, periodSec: 6, colors: ['red'], onDurationSec: 0.5 },
  { id: 'A04', name: '4号灯浮', characteristic: 'group-flash', groupSize: 3, periodSec: 8, colors: ['green'], onDurationSec: 0.5 },
  { id: 'A05', name: '5号灯浮', characteristic: 'long-flash', groupSize: null, periodSec: 8, colors: ['white'], onDurationSec: 2.0 },
  { id: 'A06', name: '6号灯浮', characteristic: 'long-flash', groupSize: null, periodSec: 10, colors: ['yellow'], onDurationSec: 2.0 },
  { id: 'A07', name: '7号灯浮', characteristic: 'quick', groupSize: null, periodSec: 1, colors: ['white'], onDurationSec: 0.4 },
  { id: 'A08', name: '8号灯浮', characteristic: 'quick', groupSize: 3, periodSec: 5, colors: ['yellow'], onDurationSec: 0.4 },
  { id: 'A09', name: '9号灯桩', characteristic: 'single-flash', groupSize: null, periodSec: 5, colors: ['white'], onDurationSec: 0.5 },
  { id: 'A10', name: '10号灯桩', characteristic: 'group-flash', groupSize: 2, periodSec: 6, colors: ['green'], onDurationSec: 0.5 },
  { id: 'A11', name: '11号灯桩', characteristic: 'alternating', groupSize: null, periodSec: 6, colors: ['red', 'white'] },
  { id: 'A12', name: '12号灯桩', characteristic: 'alternating', groupSize: null, periodSec: 8, colors: ['green', 'white'] },
  { id: 'A13', name: '13号导标', characteristic: 'morse', groupSize: null, periodSec: 8, colors: ['white'], onDurationSec: 0.3 },
  { id: 'A14', name: '14号导标', characteristic: 'fixed', groupSize: null, periodSec: 0, colors: ['red'] },
  { id: 'A15', name: '15号导标', characteristic: 'fixed', groupSize: null, periodSec: 0, colors: ['green'] },
  { id: 'A16', name: '16号锚地灯浮', characteristic: 'group-flash', groupSize: 4, periodSec: 10, colors: ['yellow'], onDurationSec: 0.5 },
  { id: 'A17', name: '17号转向标', characteristic: 'single-flash', groupSize: null, periodSec: 6, colors: ['yellow'], onDurationSec: 0.5 },
  { id: 'A18', name: '18号转向标', characteristic: 'long-flash', groupSize: null, periodSec: 12, colors: ['white'], onDurationSec: 2.0 },
  // 故障灯真值（航标表仍记规定灯质）
  { id: 'A19', name: '19号灯浮（疑似熄灭）', characteristic: 'single-flash', groupSize: null, periodSec: 4, colors: ['red'], onDurationSec: 0.5 },
  { id: 'A20', name: '20号灯浮（疑似常亮）', characteristic: 'group-flash', groupSize: 2, periodSec: 6, colors: ['green'], onDurationSec: 0.5 },
];

/** 与航标表对应的灯真值（A19 熄灭、A20 常亮、A17 周期漂移） */
export function buildSceneLights(width: number, height: number): GroundTruthLight[] {
  const cols = 5;
  const marginX = 70;
  const gapX = (width - marginX * 2) / (cols - 1);
  // 四行灯点全部位于水天线（0.62H）以上，倒影只出现在灯点下方
  const rowY = [
    Math.round(height * 0.15),
    Math.round(height * 0.29),
    Math.round(height * 0.43),
    Math.round(height * 0.57),
  ];
  const pos = (idx: number) => ({
    x: Math.round(marginX + (idx % cols) * gapX),
    y: rowY[Math.floor(idx / cols)]!,
  });

  const specs: {
    id: string; color: AidEntry['colors'][number];
    ch: AidEntry['characteristic']; period: number; group: number | null;
    fault?: GroundTruthLight['fault']; alt?: GroundTruthLight['altColor'];
  }[] = [
    { id: 'A01', color: 'red', ch: 'single-flash', period: 4, group: null },
    { id: 'A02', color: 'green', ch: 'single-flash', period: 4, group: null },
    { id: 'A03', color: 'red', ch: 'group-flash', period: 6, group: 2 },
    { id: 'A04', color: 'green', ch: 'group-flash', period: 8, group: 3 },
    { id: 'A05', color: 'white', ch: 'long-flash', period: 8, group: null },
    { id: 'A06', color: 'yellow', ch: 'long-flash', period: 10, group: null },
    { id: 'A07', color: 'white', ch: 'quick', period: 1, group: null },
    { id: 'A08', color: 'yellow', ch: 'quick', period: 5, group: 3 },
    { id: 'A09', color: 'white', ch: 'single-flash', period: 5, group: null },
    { id: 'A10', color: 'green', ch: 'group-flash', period: 6, group: 2 },
    { id: 'A11', color: 'red', ch: 'alternating', period: 6, group: null, alt: 'white' },
    { id: 'A12', color: 'green', ch: 'alternating', period: 8, group: null, alt: 'white' },
    { id: 'A13', color: 'white', ch: 'morse', period: 8, group: null },
    { id: 'A14', color: 'red', ch: 'fixed', period: 0, group: null },
    { id: 'A15', color: 'green', ch: 'fixed', period: 0, group: null },
    { id: 'A16', color: 'yellow', ch: 'group-flash', period: 10, group: 4 },
    { id: 'A17', color: 'yellow', ch: 'single-flash', period: 6, group: null, fault: 'drift' },
    { id: 'A18', color: 'white', ch: 'long-flash', period: 12, group: null },
    { id: 'A19', color: 'red', ch: 'single-flash', period: 4, group: null, fault: 'dead' },
    { id: 'A20', color: 'green', ch: 'group-flash', period: 6, group: 2, fault: 'steady' },
  ];

  const lights: GroundTruthLight[] = specs.map((s, i) => {
    const p = pos(i);
    return { ...makeAidLight(s.id, p.x, p.y, s.color, s.ch, s.period, s.group, s.fault ?? 'none'), altColor: s.alt };
  });

  // 岸上路灯（常亮干扰，画面最顶部，与航标行明显分离）
  for (let i = 0; i < 3; i++) {
    lights.push({
      aidId: null,
      kind: 'street',
      x: Math.round(110 + i * (width - 220) / 2),
      y: 16,
      color: 'yellow',
      characteristic: 'fixed',
      periodSec: 0,
      groupSize: null,
    });
  }
  // 船灯（移动常亮干扰）
  lights.push({
    aidId: null, kind: 'vessel', x: width - 90, y: 300,
    color: 'white', characteristic: 'fixed', periodSec: 0, groupSize: null,
  });
  lights.push({
    aidId: null, kind: 'vessel', x: 120, y: 380,
    color: 'red', characteristic: 'fixed', periodSec: 0, groupSize: null,
  });
  return lights;
}

export interface ScenarioPreset {
  key: string;
  label: string;
  seaState: number;
  fogLevel: number;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  { key: 'calm-clear', label: '小浪·无雾', seaState: 0, fogLevel: 0 },
  { key: 'mid-fog', label: '中浪·轻雾', seaState: 1, fogLevel: 1 },
  { key: 'rough-midfog', label: '大浪·轻雾', seaState: 2, fogLevel: 1 },
  { key: 'rough-clear', label: '大浪·无雾', seaState: 2, fogLevel: 0 },
  { key: 'calm-fog', label: '小浪·中雾', seaState: 0, fogLevel: 2 },
  // 压力测试：大浪+中雾叠加，接近可视极限，用于验证退化表现
  { key: 'rough-fog', label: '大浪·中雾[压力]', seaState: 2, fogLevel: 2 },
];

export function buildScene(
  preset: ScenarioPreset,
  opts: { width?: number; height?: number; fps?: number; durationSec?: number; seed?: number } = {},
): SceneConfig {
  const width = opts.width ?? 960;
  const height = opts.height ?? 540;
  return {
    width,
    height,
    fps: opts.fps ?? 10,
    durationSec: opts.durationSec ?? 60,
    seaState: preset.seaState,
    fogLevel: preset.fogLevel,
    seed: opts.seed ?? 20261127,
    lights: buildSceneLights(width, height),
  };
}
