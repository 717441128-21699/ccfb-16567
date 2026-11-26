/**
 * 端到端时效：包含合成渲染（模拟视频解码）+ 完整分析流水线。
 */
import { runPipeline, SyntheticFrameSource } from '../src/core/pipeline';
import { sceneReferences } from '../src/core/matching';
import { SAMPLE_AIDS, SCENARIO_PRESETS, buildScene } from '../src/core/sampleData';
import { SyntheticVideo } from '../src/core/synthetic';

const scene = buildScene(SCENARIO_PRESETS[1]!, { width: 960, height: 540, fps: 10, durationSec: 600 });
const video = new SyntheticVideo(scene);
const t0 = Date.now();
const result = await runPipeline({
  source: new SyntheticFrameSource(video),
  aids: SAMPLE_AIDS, matches: [], sceneRefs: sceneReferences(scene),
});
const elapsed = (Date.now()-t0)/1000;
console.log(`10分钟视频端到端（含帧生成+分析）耗时 ${elapsed.toFixed(1)}s，轨迹 ${result.tracks.length} 条`);
console.log(elapsed <= 60 ? '✓ 1分钟内完成，时效达标' : `倍率 ${(600/elapsed).toFixed(1)}x`);
