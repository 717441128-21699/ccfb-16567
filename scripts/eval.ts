/**
 * 浪高×雾况矩阵评估。
 * - 正常灯（A01-A18）：统计灯质分类、灯色、周期准确率；
 * - 故障灯（A17 漂移 / A19 熄灭 / A20 常亮）：统计是否正确报异常；
 * - 大浪·中雾[压力]为接近可视极限的压力场景，单独标注、不计入可作业海况汇总。
 */
import { runPipeline, SyntheticFrameSource } from '../src/core/pipeline';
import { sceneReferences } from '../src/core/matching';
import { SAMPLE_AIDS, SCENARIO_PRESETS, buildScene } from '../src/core/sampleData';
import { SyntheticVideo } from '../src/core/synthetic';

const FAULT = new Set(['A17', 'A19', 'A20']);
let gChar = 0, gColor = 0, gN = 0;
const gPer: number[] = [];
let gFault = 0, gFaultN = 0;

for (const preset of SCENARIO_PRESETS) {
  const stress = preset.key === 'rough-fog';
  const scene = buildScene(preset, { width: 640, height: 360, fps: 10, durationSec: 60 });
  const video = new SyntheticVideo(scene);
  const out = await runPipeline({
    source: new SyntheticFrameSource(video),
    aids: SAMPLE_AIDS, matches: [], sceneRefs: sceneReferences(scene),
  });
  let char = 0, color = 0, n = 0;
  const per: number[] = [];
  let fault = 0, faultN = 0;
  const fails: string[] = [];
  for (const a of out.audits.slice(0, 20)) {
    if (FAULT.has(a.aid.id)) { faultN++; if (!a.pass) fault++; continue; }
    n++;
    const m = a.measured;
    if (!m) { fails.push(`${a.aid.id}无轨迹`); continue; }
    if (m.characteristic === a.aid.characteristic) char++;
    else fails.push(`${a.aid.id}:${a.aid.characteristic}→${m.characteristic}`);
    if (a.aid.colors.every((c) => m.colors.includes(c)) && m.colors.length === a.aid.colors.length) color++;
    if (m.periodSec !== null && a.aid.periodSec > 0) per.push(Math.abs(m.periodSec - a.aid.periodSec));
  }
  if (!stress) { gChar += char; gColor += color; gN += n; gPer.push(...per); gFault += fault; gFaultN += faultN; }
  const tag = stress ? '[压力]' : '      ';
  console.log(`${preset.label.padEnd(12)}${tag} 灯质${char}/${n}(${(char / n * 100).toFixed(0)}%) 颜色${color}/${n} 周期≤0.2s ${per.filter((x) => x <= 0.2).length}/${per.length} 故障报警${fault}/${faultN} ${fails.join(' ')}`);
}

const sp = [...gPer].sort((a, b) => a - b);
console.log('\n=== 可作业海况汇总（剔除压力场景，正常灯 17 座 × 5 场景）===');
console.log(`灯质分类准确率: ${(gChar / gN * 100).toFixed(1)}%（目标 ≥95%）`);
console.log(`灯色准确率:     ${(gColor / gN * 100).toFixed(1)}%（目标 ≥98%）`);
console.log(`周期误差 中位${sp[Math.floor(sp.length / 2)]?.toFixed(2)}s P90 ${sp[Math.floor(sp.length * 0.9)]?.toFixed(2)}s 最大${sp[sp.length - 1]?.toFixed(2)}s（目标 ≤0.2s）`);
console.log(`故障灯报警率:   ${(gFault / gFaultN * 100).toFixed(0)}%（${gFault}/${gFaultN}）`);
