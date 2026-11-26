/**
 * 分析流水线：帧源（合成器或浏览器抽帧）→ 检测 → 跟踪
 * → 分类 → 航标表核查。纯编排逻辑，不依赖 DOM。
 */
import { audit, autoMatch } from './audit';
import { classifyAll } from './classifier';
import { detectBlobs } from './detector';
import { matchByScene, type ReferenceLight } from './matching';
import { mergeTracks } from './merge';
import { MultiTracker } from './tracker';
import type {
  AidEntry,
  AuditResult,
  Blob,
  Classification,
  Frame,
  Track,
  TrackAidMatch,
} from './types';

export interface FrameSource extends AsyncIterable<Frame> {
  readonly fps: number;
  readonly totalFrames: number;
}

export interface PipelineOptions {
  source: FrameSource;
  aids: AidEntry[];
  matches: TrackAidMatch[];
  /** 合成模式：场景参考灯位，提供后按真值布局绑定 */
  sceneRefs?: ReferenceLight[];
  horizonRatio?: number;
  onFrame?: (info: {
    frame: Frame;
    blobs: Blob[];
    tracks: Track[];
    index: number;
    total: number;
    dx: number;
    dy: number;
  }) => void | Promise<void>;
  shouldCancel?: () => boolean;
}

export interface PipelineOutput {
  tracks: Track[];
  classifications: { trackId: number; result: Classification }[];
  audits: AuditResult[];
  totalFrames: number;
  videoTimeSec: number;
  analysisTimeMs: number;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineOutput> {
  const started = performance.now();
  const tracker = new MultiTracker({ horizonRatio: opts.horizonRatio ?? 0.62 });
  let total = 0;
  let lastFrame: Frame | null = null;

  for await (const frame of opts.source) {
    if (opts.shouldCancel?.()) {
      throw new Error('分析已取消');
    }
    const blobs = detectBlobs(frame);
    const { dx, dy } = tracker.update(blobs, frame);
    total++;
    lastFrame = frame;
    await opts.onFrame?.({
      frame,
      blobs,
      tracks: tracker.tracks,
      index: frame.index,
      total: opts.source.totalFrames,
      dx,
      dy,
    });
  }

  const fps = opts.source.fps;
  // 后处理：合并大浪/浓雾下因数据关联分裂的碎轨迹
  const mergedAll = mergeTracks(tracker.tracks);
  // 过滤观测帧过少的碎轨迹（不足 2 个周期或 15 帧），它们无法可靠判读灯质
  const mergedTracks = mergedAll.filter(
    (t) => t.confirmed && t.brightness.filter((v) => v !== null).length >= 15,
  );
  const classifications = classifyAll(mergedTracks, fps);
  const sceneMatches = opts.sceneRefs ? matchByScene(mergedTracks, opts.sceneRefs) : [];
  const allMatches = sceneMatches.length ? sceneMatches : autoMatch(mergedTracks, opts.aids, opts.matches);
  const audits = audit(opts.aids, mergedTracks, classifications, allMatches);

  return {
    tracks: mergedTracks.map((t) => ({ ...t })),
    classifications,
    audits,
    totalFrames: total,
    videoTimeSec: lastFrame ? lastFrame.timeSec + 1 / fps : 0,
    analysisTimeMs: performance.now() - started,
  };
}

/** 把合成视频包装成流水线帧源 */
export class SyntheticFrameSource implements FrameSource {
  constructor(private readonly video: { fps: number; totalFrames: number; renderFrame: (i: number) => Frame }) {}
  get fps(): number {
    return this.video.fps;
  }
  get totalFrames(): number {
    return this.video.totalFrames;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
    for (let i = 0; i < this.video.totalFrames; i++) {
      yield this.video.renderFrame(i);
      // 让出事件循环，避免 Worker 长任务阻塞消息
      if (i % 30 === 29) await Promise.resolve();
    }
  }
}
