/**
 * 合成场景视频源：把 SyntheticScene 渲染到离屏 canvas，
 * 实现与视频文件相同的 VideoSource 接口，可选择同时 MediaRecorder 录制为 WebM。
 */
import { SyntheticScene } from '../core/synthetic';
import type { VideoSource } from '../core/pipeline';
export class SyntheticVideoSource implements VideoSource {
  private t = 0;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;

  constructor(
    private readonly scene: SyntheticScene,
    private readonly fps: number,
  ) {
    this.width = scene.opts.width;
    this.height = scene.opts.height;
    this.durationSec = scene.scenario.durationSec;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  get videoName(): string {
    return `${this.scene.scenario.id}.webm`;
  }

  get displayCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  readonly selfPaced = true;

  async drawFrame(targetCtx: CanvasRenderingContext2D): Promise<{ t: number; w: number; h: number } | null> {
    if (this.t >= this.durationSec) return null;
    const frame = this.scene.render(this.t);
    const image = new ImageData(frame.data, frame.width, frame.height);
    this.ctx.putImageData(image, 0, 0);
    targetCtx.drawImage(this.canvas, 0, 0, targetCtx.canvas.width, targetCtx.canvas.height);
    const result = { t: this.t, w: this.width, h: this.height };
    this.t += 1 / this.fps;
    return result;
  }
}
