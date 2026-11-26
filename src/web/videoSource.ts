/**
 * 浏览器视频抽帧：用隐藏 video + canvas 按目标帧率抽帧，
 * 包装成流水线 FrameSource。仅在浏览器环境运行。
 */
import type { Frame } from '../core/types';
import type { FrameSource } from '../core/pipeline';

export interface VideoSourceOptions {
  video: HTMLVideoElement;
  analysisFps: number;
}

export class VideoFrameSource implements FrameSource {
  readonly fps: number;
  readonly totalFrames: number;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scaleW: number;
  private readonly scaleH: number;

  constructor(opts: VideoSourceOptions) {
    this.video = opts.video;
    this.fps = opts.analysisFps;
    const duration = opts.video.duration || 0;
    this.totalFrames = Math.max(1, Math.round(duration * opts.analysisFps));
    // 分析分辨率上限 960×540，控制每帧计算量
    this.scaleW = 960;
    this.scaleH = Math.round((opts.video.videoHeight / Math.max(opts.video.videoWidth, 1)) * this.scaleW) || 540;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.scaleW;
    this.canvas.height = this.scaleH;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Frame> {
    const dt = 1 / this.fps;
    for (let i = 0; i < this.totalFrames; i++) {
      const t = i * dt;
      await this.seek(t);
      this.ctx.drawImage(this.video, 0, 0, this.scaleW, this.scaleH);
      const imageData = this.ctx.getImageData(0, 0, this.scaleW, this.scaleH);
      yield {
        width: this.scaleW,
        height: this.scaleH,
        data: imageData.data,
        index: i,
        timeSec: t,
      };
      if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
    }
  }

  private seek(time: number): Promise<void> {
    return new Promise((resolve) => {
      const onSeeked = (): void => {
        this.video.removeEventListener('seeked', onSeeked);
        resolve();
      };
      this.video.addEventListener('seeked', onSeeked);
      this.video.currentTime = Math.min(time, this.video.duration || time);
    });
  }
}
