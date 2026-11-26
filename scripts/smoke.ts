/**
 * 快速冒烟：小场景跑通 检测→跟踪→分类→核查，打印每盏灯结果。
 * 用法：npx tsx scripts/smoke.ts
 */
import { detectBlobs } from '../src/core/detector';
import { sceneReferences } from '../src/core/matching';
import { runPipeline, SyntheticFrameSource } from '../src/core/pipeline';
import { SAMPLE_AIDS, SCENARIO_PRESETS, buildScene } from '../src/core/sampleData';
import { SyntheticVideo } from '../src/core/synthetic';

async function main(): Promise<void> {
  const preset = SCENARIO_PRESETS[1]!;
  const scene = buildScene(preset, { width: 640, height: 360, fps: 10, durationSec: 40 });
  const video = new SyntheticVideo(scene);
  const source = new SyntheticFrameSource(video);

  // 先单帧验证检测
  const f0 = video.renderFrame(0);
  const blobs = detectBlobs(f0);
  console.log(`场景 ${preset.label}：首帧检测到 ${blobs.length} 个灯点候选`);

  let maxTracks = 0;
  const out = await runPipeline({
    source,
    aids: SAMPLE_AIDS,
    matches: [],
    sceneRefs: sceneReferences(scene),
    onFrame: ({ tracks }) => {
      maxTracks = Math.max(maxTracks, tracks.length);
    },
  });

  console.log(`并发轨迹峰值 ${maxTracks}，确认轨迹 ${out.tracks.filter((t) => t.confirmed).length}`);
  console.log(`分析耗时 ${out.analysisTimeMs.toFixed(0)}ms，视频时长 ${out.videoTimeSec}s`);
  console.log('');
  for (const a of out.audits.slice(0, 20)) {
    const m = a.measured;
    console.log(
      `${a.aid.id} 规定=${a.aid.characteristic.padEnd(13)} 实测=${(m?.characteristic ?? '—').padEnd(13)} ` +
      `周期=${m?.periodSec?.toFixed(2) ?? '—'.padStart(5)}s 色=${(m?.colors.join('+') ?? '—').padEnd(11)} ` +
      `${a.pass ? '✓ 一致' : '✗ ' + a.mismatches.map((x) => x.detail).join('；')}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
