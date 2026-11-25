/**
 * 分析 Worker：接收缩放后的 RGBA 帧，逐帧亮斑检测 -> 多目标跟踪 -> 收尾分析。
 * 帧缓冲通过 Transferable 转移，零拷贝。
 */
import { analyzeTrack } from '../core/analyzer';
import { detectBlobs } from '../core/blobDetect';
import { trackerFrameOptions } from '../core/config';
import { MultiTracker } from '../core/tracker';
import type { AnalyzerConfig, FrameSample } from '../core/types';
import type {
  WorkerDoneMsg, WorkerErrorMsg, WorkerProgressMsg, WorkerRequest, WorkerResponse,
} from '../core/workerProtocol';

let tracker: MultiTracker | null = null;
let config: AnalyzerConfig | null = null;
let videoName = '';
let frameIndex = 0;
let lastT = 0;
let firstT = 0;
let analyzeWidth = 0;
let analyzeHeight = 0;
let videoWidth = 0;
let videoHeight = 0;

function post(msg: WorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

function init(cfg: AnalyzerConfig, name: string): void {
  config = cfg;
  videoName = name;
  tracker = new MultiTracker(trackerFrameOptions(cfg));
  frameIndex = 0;
  lastT = 0;
  firstT = 0;
}

function handleFrame(msg: Extract<WorkerRequest, { type: 'frame' }>): void {
  if (!tracker || !config) throw new Error('Worker 未初始化');
  const data = new Uint8ClampedArray(msg.buffer);
  const blobs = detectBlobs(
    { data, width: msg.width, height: msg.height },
    { threshold: config.detectThreshold },
  );
  if (frameIndex === 0) firstT = msg.t;
  lastT = msg.t;
  analyzeWidth = msg.width;
  analyzeHeight = msg.height;
  videoWidth = msg.videoWidth;
  videoHeight = msg.videoHeight;

  tracker.update(blobs, msg.t);
  const sample: FrameSample = {
    t: msg.t,
    blobs,
    width: msg.width,
    height: msg.height,
  };
  const progress: WorkerProgressMsg = {
    type: 'progress',
    frameIndex,
    t: msg.t,
    blobCount: blobs.length,
    trackCount: tracker.frameCount_,
    lastSample: sample,
  };
  post(progress);
  frameIndex++;
}

function finish(): void {
  if (!tracker || !config) {
    const err: WorkerErrorMsg = { type: 'error', message: 'Worker 未初始化' };
    post(err);
    return;
  }
  const tracks = tracker.buildTracks();
  const span = Math.max(1e-6, lastT - firstT);
  const dt = span / Math.max(1, frameIndex - 1);
  const analyses = tracks.map((tr) => analyzeTrack(tr, config!, dt));
  const done: WorkerDoneMsg = {
    type: 'done',
    tracks,
    analyses,
    frameCount: frameIndex,
    durationSec: lastT - firstT,
    analyzeWidth,
    analyzeHeight,
    videoWidth,
    videoHeight,
    sampleFps: frameIndex / span,
  };
  post(done);
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  try {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        init(msg.config, msg.videoName);
        break;
      case 'frame':
        handleFrame(msg);
        break;
      case 'finish':
        finish();
        break;
      case 'reset':
        if (config) init(config, videoName);
        break;
    }
  } catch (err) {
    const out: WorkerErrorMsg = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    post(out);
  }
};
