/**
 * 浏览器端视频录制：Canvas 帧流 -> MediaRecorder -> WebM Blob。
 * Node 测试不经过这里，直接用 SyntheticScene 的帧缓冲做逐帧分析。
 */
export interface RecordOptions {
  fps: number;
  timesliceMs?: number;
  mimeType?: string;
}

export class CanvasRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  static isSupported(): boolean {
    return typeof MediaRecorder !== 'undefined'
      && CanvasRecorder.pickMime() !== null;
  }

  static pickMime(): string | null {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
    return null;
  }

  start(canvas: HTMLCanvasElement, opts: RecordOptions): void {
    const mime = opts.mimeType ?? CanvasRecorder.pickMime() ?? 'video/webm';
    this.stream = canvas.captureStream(opts.fps);
    this.chunks = [];
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(opts.timesliceMs ?? 200);
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('录制未开始'));
        return;
      }
      this.recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.chunks[0]?.type ?? 'video/webm' });
        this.recorder = null;
        this.stream?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
        this.stream = null;
        resolve(blob);
      };
      this.recorder.onerror = (ev) => reject(ev.error ?? new Error('录制失败'));
      this.recorder.stop();
    });
  }
}
