/**
 * 分析 Worker：后台执行 检测→跟踪→合并→分类→核查 全流程，
 * 主线程通过消息驱动并接收进度/帧快照/最终结果。
 */
import { classifyAll } from '../core/classifier';
import { detectBlobs } from '../core/detector';
import { matchByScene } from '../core/matching';
import { mergeTracks } from '../core/merge';
import { runPipeline, type FrameSource } from '../core/pipeline';
import { SyntheticVideo } from '../core/synthetic';
import type {
  Track,
  TrackSnapshot,
  WorkerJob,
  WorkerOutput,
  WorkerRequest,
  WorkerResponse,
} from '../core/types';
import { MultiTracker } from '../core/tracker';

function snapshot(tracks: Track[]): TrackSnapshot[] {
  return tracks.map((t) => {
    const last = [...t.positions].reverse().find((p) => p !== null);
    const lastBright = [...t.brightness].reverse().find((b) => b !== null);
    return {
      id: t.id,
      x: last?.x ?? 0,
      y: last?.y ?? 0,
      confirmed: t.confirmed,
      rejected: t.rejected ?? null,
      brightness: lastBright ?? null,
    };
  });
}

async function handleStart(payload: WorkerJob): Promise<void> {
  let source: FrameSource;
  let sceneRefs;
  if (payload.scene) {
    const video = new SyntheticVideo(payload.scene);
    source = {
      fps: payload.analysisFps,
      totalFrames: video.totalFrames,
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < video.totalFrames; i++) {
          yield video.renderFrame(i);
          if (i % 30 === 29) await Promise.resolve();
        }
      },
    };
    sceneRefs = (await import('../core/matching')).sceneReferences(payload.scene);
  } else {
    throw new Error('Worker 当前仅支持合成场景；视频抽帧在主线程构造后传入');
  }

  const tracker = new MultiTracker({ horizonRatio: payload.horizonRatio });
  let frameCount = 0;
  const started = performance.now();

  for await (const frame of source) {
    const blobs = detectBlobs(frame);
    const { dx, dy } = tracker.update(blobs, frame);
    frameCount++;
    const progress: WorkerResponse = {
      type: 'progress',
      payload: { frame: frame.index, total: source.totalFrames, tracks: tracker.tracks.length },
    };
    postMessage(progress);
    // 每 5 帧回传一次带画面的快照，供 Canvas 叠加绘制
    if (frame.index % 5 === 0) {
      const msg: WorkerResponse = {
        type: 'frame',
        payload: { frame, blobs, tracks: snapshot(tracker.tracks), globalDx: dx, globalDy: dy },
      };
      postMessage(msg);
    }
  }

  const merged = mergeTracks(tracker.tracks).filter(
    (t) => t.confirmed && t.brightness.filter((v) => v !== null).length >= 15,
  );
  const classifications = classifyAll(merged, source.fps);
  const matches = sceneRefs ? matchByScene(merged, sceneRefs) : payload.matches;
  const { audit } = await import('../core/audit');
  const audits = audit(payload.aids, merged, classifications, matches);

  const output: WorkerOutput = {
    tracks: merged,
    classifications,
    audits,
    totalFrames: frameCount,
    analysisTimeMs: performance.now() - started,
    videoTimeSec: frameCount / source.fps,
  };
  const done: WorkerResponse = { type: 'done', payload: output };
  postMessage(done);
}

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const msg = e.data;
  if (msg.type === 'start') {
    handleStart(msg.payload).catch((err) => {
      const errMsg: WorkerResponse = { type: 'error', payload: String(err?.message ?? err) };
      postMessage(errMsg);
    });
  }
};

// 供主线程类型引用
export type { WorkerOutput };
// 显式引入避免 tree-shaking 误删
void runPipeline;
