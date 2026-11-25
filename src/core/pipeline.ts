/**
 * 视频抽帧服务：视频源 -> Canvas 缩放取 RGBA -> 投递给分析 Worker。
 * 真实视频按目标采样率 seek 抽帧；合成源自行按固定步长出帧。
 * 帧缓冲通过 Transferable 转移，零拷贝。
 */
import { downscale, type RgbaImage } from './imageUtils';
import type { AnalyzerConfig } from './types';
import type { WorkerRequest, WorkerResponse } from './workerProtocol';

export interface ProcessHandle {
  promise: Promise<void>;
  cancel: () => void;
}

export interface VideoSource {
  videoName: string;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  /** 是否由源自行控制时间推进（合成渲染器）；否则 pipeline 负责 seek */
  readonly selfPaced?: boolean;
  /** 跳到指定时间（仅真实视频需要） */
  seek?(t: number): Promise<void>;
  /** 画当前帧到目标 ctx；结束返回 null */
  drawFrame(ctx: CanvasRenderingContext2D): Promise<{ t: number; w: number; h: number } | null>;
}

/** 从 HTMLVideoElement（本地导入文件）构造视频源 */
export function videoElementSource(video: HTMLVideoElement, name: string): VideoSource {
  return {
    videoName: name,
    get durationSec() { return video.duration || 0; },
    get width() { return video.videoWidth; },
    get height() { return video.videoHeight; },
    async seek(t: number) {
      video.currentTime = t;
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.onerror = () => reject(new Error('视频解码失败'));
      });
    },
    async drawFrame(ctx) {
      if (video.ended) return null;
      ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);
      return { t: video.currentTime, w: video.videoWidth, h: video.videoHeight };
    },
  };
}

export class AnalysisPipeline {
  private worker: Worker | null = null;
  private cancelled = false;

  constructor(private readonly config: AnalyzerConfig) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
        type: 'module',
      });
    }
    return this.worker;
  }

  onMessage(handler: (msg: WorkerResponse) => void): void {
    this.ensureWorker().onmessage = (e) => handler(e.data as WorkerResponse);
  }

  process(
    source: VideoSource,
    onProgress: (pct: number, t: number) => void,
  ): ProcessHandle {
    this.cancelled = false;
    const worker = this.ensureWorker();
    worker.postMessage({
      type: 'init',
      config: this.config,
      videoName: source.videoName,
    } satisfies WorkerRequest);

    const canvas = document.createElement('canvas');
    const scale = this.config.analyzeWidth / Math.max(1, source.width);
    canvas.width = this.config.analyzeWidth;
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const frameInterval = 1 / this.config.sampleFps;
    const totalFrames = Math.max(1, Math.ceil((source.durationSec || 0) * this.config.sampleFps));
    let sent = 0;

    const promise = (async () => {
      if (source.selfPaced) {
        // 合成源：源按自己的帧率出帧，pipeline 逐帧收下并按采样率截帧
        while (!this.cancelled) {
          const frame = await source.drawFrame(ctx);
          if (!frame) break;
          if (sent > 0 && frame.t < sent * frameInterval - frameInterval * 0.5) continue;
          await this.sendFrame(ctx, canvas, frame, worker);
          sent++;
          onProgress(Math.min(1, sent / totalFrames), frame.t);
          await raf();
        }
      } else {
        // 真实视频：按采样率 seek
        const duration = source.durationSec || 0;
        for (let t = 0; t < duration && !this.cancelled; t += frameInterval) {
          await source.seek!(t);
          const frame = await source.drawFrame(ctx);
          if (!frame) break;
          await this.sendFrame(ctx, canvas, frame, worker);
          sent++;
          onProgress(Math.min(1, t / duration), t);
          await raf();
        }
      }
      if (!this.cancelled) {
        worker.postMessage({ type: 'finish' } satisfies WorkerRequest);
      }
    })();

    return {
      promise,
      cancel: () => {
        this.cancelled = true;
        worker.postMessage({ type: 'reset' } satisfies WorkerRequest);
      },
    };
  }

  private async sendFrame(
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    frame: { t: number; w: number; h: number },
    worker: Worker,
  ): Promise<void> {
    const full = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scaled: RgbaImage = downscale(
      { data: full.data, width: canvas.width, height: canvas.height },
      this.config.analyzeWidth,
    );
    const buf = scaled.data.buffer.slice(0);
    worker.postMessage({
      type: 'frame',
      buffer: buf,
      width: scaled.width,
      height: scaled.height,
      t: frame.t,
      videoWidth: frame.w,
      videoHeight: frame.h,
    } satisfies WorkerRequest, [buf]);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
