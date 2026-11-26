/**
 * 合成夜拍视频生成器：确定性渲染夜间海面航标场景。
 * - 浪高（seaState 0..2）→ 全局随机抖动幅度 + 倒影强度；
 * - 雾浓度（fogLevel 0..2）→ 对比度衰减、光晕扩散、噪声抬升；
 * - 航标灯按灯质时刻表闪烁，可注入熄灭/常亮/周期漂移故障；
 * - 路灯（岸上常亮）、船灯（移动常亮）、海面倒影（纵向拉长闪烁）。
 * 逐帧生成、不落地，供 Worker/Node 评估直接消费。
 */
import { COLOR_EMIT } from './color';
import { Rng } from './rng';
import { buildSchedule, type Schedule } from './schedule';
import type { Frame, GroundTruth, GroundTruthLight, LightColor, SceneConfig } from './types';

/** 浪高等级 → 抖动/倒影参数 */
const SEA = [
  { jitter: 2.2, jitterFreq: 0.9, tilt: 0.004, refl: 0.25 },
  { jitter: 5.0, jitterFreq: 1.5, tilt: 0.009, refl: 0.45 },
  { jitter: 8.5, jitterFreq: 2.0, tilt: 0.014, refl: 0.7 },
];

/** 雾等级 → 衰减/光晕/背景抬升 */
const FOG = [
  { retain: 1.0, glowSigma: 2.4, floor: 5, noise: 4 },
  { retain: 0.9, glowSigma: 3.5, floor: 10, noise: 6 },
  { retain: 0.85, glowSigma: 4.5, floor: 13, noise: 7 },
];

interface RenderLight extends GroundTruthLight {
  schedule: Schedule;
  /** 船灯的漂移速度（像素/秒） */
  driftVx: number;
  driftVy: number;
}

export class SyntheticVideo {
  readonly cfg: SceneConfig;
  readonly groundTruth: GroundTruth;
  private readonly lights: RenderLight[];
  private readonly rng: Rng;
  private frameCount: number;
  /** 每帧全局船摇的绝对位移（零均值）与旋转 */
  private readonly absMotion: { x: number; y: number; rot: number }[];
  /** 每帧帧间增量（跟踪器全局抖动指示用） */
  private readonly motions: { dx: number; dy: number; rot: number }[];
  /** 静态背景缓存（天空/海面渐变 + 雾底色），每帧拷贝复用 */
  private background: Uint8ClampedArray | null = null;

  get fps(): number {
    return this.cfg.fps;
  }

  get totalFrames(): number {
    return this.frameCount;
  }

  constructor(cfg: SceneConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.frameCount = Math.round(cfg.durationSec * cfg.fps);

    this.lights = cfg.lights.map((l) => ({
      ...l,
      schedule: buildSchedule({
        characteristic: l.characteristic,
        periodSec: l.periodSec,
        groupSize: l.groupSize,
        colors: [l.color],
        fps: cfg.fps,
        durationSec: cfg.durationSec,
        fault: l.fault ?? 'none',
      }),
      driftVx: l.kind === 'vessel' ? this.rng.range(-14, 14) : 0,
      driftVy: l.kind === 'vessel' ? this.rng.range(-3, 3) : 0,
    }));

    const sea = SEA[cfg.seaState]!;
    this.absMotion = [];
    this.motions = [];
    // 船摇为零均值往复运动：双频正弦 + 白噪声，位移围绕 0 振荡
    const f1 = sea.jitterFreq;
    const f2 = sea.jitterFreq * 2.37;
    const phase1 = (cfg.seed % 17) * 0.37;
    const phase2 = (cfg.seed % 11) * 0.61;
    let prevX = 0;
    let prevY = 0;
    for (let f = 0; f < this.frameCount; f++) {
      const t = f / cfg.fps;
      const x =
        sea.jitter * Math.sin(2 * Math.PI * f1 * t + phase1) +
        sea.jitter * 0.35 * Math.sin(2 * Math.PI * f2 * t + phase2) +
        this.rng.gaussian(sea.jitter * 0.08);
      const y =
        sea.jitter * 0.55 * Math.cos(2 * Math.PI * f1 * 0.83 * t + phase1 + 1.7) +
        sea.jitter * 0.2 * Math.sin(2 * Math.PI * f2 * 1.1 * t + phase2) +
        this.rng.gaussian(sea.jitter * 0.08);
      const rot = sea.tilt * Math.sin(2 * Math.PI * f1 * 0.6 * t + phase2);
      this.absMotion.push({ x, y, rot });
      this.motions.push({ dx: x - prevX, dy: y - prevY, rot });
      prevX = x;
      prevY = y;
    }

    const schedules: GroundTruth['schedules'] = {};
    for (const l of this.lights) {
      if (l.aidId) schedules[l.aidId] = Array.from(l.schedule.on).map(Boolean);
    }
    this.groundTruth = { config: cfg, schedules };
  }

  /** 灯在第 frame 帧、含船摇的实际画面位置（零均值振荡位移） */
  lightPosition(l: GroundTruthLight, frame: number): { x: number; y: number } {
    const internal = this.lights.find((x) => x.aidId === l.aidId && x.x === l.x && x.y === l.y);
    const driftVx = internal?.driftVx ?? 0;
    const driftVy = internal?.driftVy ?? 0;
    const t = frame / this.cfg.fps;
    const m = this.absMotion[frame]!;
    const cx = this.cfg.width / 2;
    const cy = this.cfg.height / 2;
    const rx = l.x + driftVx * t - cx;
    const ry = l.y + driftVy * t - cy;
    const cos = Math.cos(m.rot);
    const sin = Math.sin(m.rot);
    return {
      x: cx + m.x + rx * cos - ry * sin,
      y: cy + m.y + rx * sin + ry * cos,
    };
  }

  *frames(): Generator<Frame> {
    for (let f = 0; f < this.frameCount; f++) {
      yield this.renderFrame(f);
    }
  }

  renderFrame(frame: number): Frame {
    const { width: w, height: h, fps } = this.cfg;
    const fog = FOG[this.cfg.fogLevel]!;
    const sea = SEA[this.cfg.seaState]!;
    const data = new Uint8ClampedArray(w * h * 4);
    const horizonY = Math.round(h * 0.62);

    // 静态背景只构建一次并缓存，后续帧直接拷贝
    if (!this.background || this.background.length !== data.length) {
      const bg = new Uint8ClampedArray(data.length);
      for (let y = 0; y < h; y++) {
        const sky = y < horizonY;
        const base = sky ? 10 + (y / horizonY) * 8 : 4 + (1 - (y - horizonY) / (h - horizonY)) * 4;
        for (let x = 0; x < w; x++) {
          const noise = this.rng.gaussian(fog.noise);
          const v = Math.max(0, base + fog.floor * 0.4 + noise);
          const p = (y * w + x) * 4;
          bg[p] = v * 0.7;
          bg[p + 1] = v * 0.85;
          bg[p + 2] = v + 4;
          bg[p + 3] = 255;
        }
      }
      this.background = bg;
    }
    data.set(this.background);

    // 海面细碎反光亮纹（随帧变化，弱信号）
    for (let i = 0; i < 30; i++) {
      const x = this.rng.range(0, w);
      const y = this.rng.range(horizonY, h);
      const len = this.rng.range(4, 14);
      const v = 18 + this.rng.next() * 14 + fog.floor;
      for (let k = 0; k < len; k++) {
        const xx = Math.round(x + k);
        if (xx >= w) break;
        const p = (Math.round(y) * w + xx) * 4;
        data[p] = Math.max(data[p]!, v * 0.8);
        data[p + 1] = Math.max(data[p + 1]!, v * 0.9);
        data[p + 2] = Math.max(data[p + 2]!, v);
      }
    }

    for (const l of this.lights) {
      const on = l.schedule.on[frame] === 1;
      const pos = this.lightPosition(l, frame);
      const colorIdx = l.schedule.colorIndex[frame] ?? 0;
      const alt = l.altColor ? COLOR_EMIT[l.altColor] : null;
      const emit = colorIdx === 1 && alt ? alt : COLOR_EMIT[l.color]!;
      const isAid = l.kind === 'aid';

      if (on) {
        // 雾越浓灯的发光基准越高，保证亮核始终明显高于雾背景（真实航标灯功率足够）
        const fogBoost = 1 + (1 - fog.retain) * 0.9;
        const intensity = (isAid ? 250 : 222) * fog.retain * fogBoost + this.rng.gaussian(6);
        this.drawGlow(data, w, h, pos.x, pos.y, emit, intensity, fog.glowSigma);
      }

      // 倒影：水天线以下，纵向拉长、破碎闪烁；强度压在检测阈值附近，
      // 多数帧不形成连通域，偶发残留也因纵向形态被跟踪器剔除
      if (pos.y < horizonY + 4) {
        const reflStrength = sea.refl * (on ? 1 : 0.1) * fog.retain;
        const flicker = 0.55 + 0.45 * Math.abs(Math.sin(frame * 0.9 + l.x * 0.13 + this.cfg.seed));
        const rLen = (18 + sea.jitter * 2.2) * flicker;
        this.drawReflection(data, w, h, pos.x, horizonY + 2, rLen, emit, reflStrength * 55, fog.glowSigma);
      }
    }

    return {
      width: w,
      height: h,
      timeSec: frame / fps,
      index: frame,
      data,
    };
  }

  /** 高斯光晕：中心亮核（饱和）+ 衰减尾翼，保证亮灭幅度 >150 灰度 */
  private drawGlow(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    cx: number,
    cy: number,
    emit: { r: number; g: number; b: number },
    intensity: number,
    sigma: number,
  ): void {
    const radius = Math.ceil(sigma * 2.6);
    const x0 = Math.max(0, Math.floor(cx) - radius);
    const x1 = Math.min(w - 1, Math.floor(cx) + radius);
    const y0 = Math.max(0, Math.floor(cy) - radius);
    const y1 = Math.min(h - 1, Math.floor(cy) + radius);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        // 核内饱和 + 核外高斯尾翼；归一化分母随强度收窄，保证弱光下亮核也突出
        const fall = d2 <= sigma * sigma ? 1 : Math.exp(-(d2 - sigma * sigma) / (2 * sigma * sigma));
        const k = Math.min(1, (intensity * fall) / 150);
        const p = (y * w + x) * 4;
        data[p] = Math.min(255, data[p]! + emit.r * k);
        data[p + 1] = Math.min(255, data[p + 1]! + emit.g * k);
        data[p + 2] = Math.min(255, data[p + 2]! + emit.b * k);
      }
    }
  }

  /** 纵向破碎倒影：分段高斯点串，高宽比天然 >2，供检测器剔除 */
  private drawReflection(
    data: Uint8ClampedArray,
    w: number,
    h: number,
    cx: number,
    yStart: number,
    length: number,
    emit: { r: number; g: number; b: number },
    intensity: number,
    sigma: number,
  ): void {
    const segments = Math.max(3, Math.round(length / 5));
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      const yy = yStart + t * length + this.rng.gaussian(1.2);
      const xx = cx + this.rng.gaussian(1.6 + t * 2.2);
      const fade = (1 - t) * (0.4 + 0.6 * this.rng.next());
      this.drawGlow(data, w, h, xx, yy, emit, intensity * fade, sigma * 0.8);
    }
  }
}

/** 场景构造辅助：按规格批量生成航标灯真值 */
export function makeAidLight(
  aidId: string,
  x: number,
  y: number,
  color: LightColor,
  characteristic: GroundTruthLight['characteristic'],
  periodSec: number,
  groupSize: number | null,
  fault: GroundTruthLight['fault'] = 'none',
): GroundTruthLight {
  return { aidId, kind: 'aid', x, y, color, characteristic, periodSec, groupSize, fault };
}
