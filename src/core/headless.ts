/**
 * Node 侧无头分析管线：与浏览器 Worker 调用同一套核心算法，
 * 供达标评测脚本使用（无 DOM 依赖）。
 */
import { analyzeTrack } from './analyzer';
import { detectBlobs } from './blobDetect';
import { trackerFrameOptions } from './config';
import { MultiTracker } from './tracker';
import type { AnalyzerConfig, Track, TrackAnalysis } from './types';
import type { FrameRender, SyntheticScene } from './synthetic';

export interface HeadlessRun {
  tracks: Track[];
  analyses: TrackAnalysis[];
  frameCount: number;
  durationSec: number;
  sampleFps: number;
  detectMs: number;
  trackMs: number;
  analyzeMs: number;
}

export function runHeadless(
  scene: SyntheticScene,
  config: AnalyzerConfig,
): HeadlessRun {
  const tracker = new MultiTracker(trackerFrameOptions(config));
  const dt = 1 / config.sampleFps;
  const frames = Math.round(scene.scenario.durationSec * config.sampleFps);
  let detectMs = 0;
  let trackMs = 0;

  for (let i = 0; i < frames; i++) {
    const t = i * dt;
    let frame: FrameRender;
    try {
      frame = scene.render(t);
    } catch (err) {
      throw new Error(`第 ${i} 帧渲染失败: ${String(err)}`);
    }
    const t0 = performance.now();
    const blobs = detectBlobs(
      { data: frame.data, width: frame.width, height: frame.height },
      { threshold: config.detectThreshold },
    );
    const t1 = performance.now();
    tracker.update(blobs, t);
    const t2 = performance.now();
    detectMs += t1 - t0;
    trackMs += t2 - t1;
  }

  const t3 = performance.now();
  const tracks = tracker.buildTracks();
  const analyses = tracks.map((tr) => analyzeTrack(tr, config, dt));
  const t4 = performance.now();

  return {
    tracks,
    analyses,
    frameCount: frames,
    durationSec: scene.scenario.durationSec,
    sampleFps: config.sampleFps,
    detectMs,
    trackMs,
    analyzeMs: t4 - t3,
  };
}
