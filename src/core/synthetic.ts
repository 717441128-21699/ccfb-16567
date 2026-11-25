/**
 * 合成夜拍视频帧生成器（纯函数、确定性随机）。
 *
 * 模拟要素：
 * - 夜海深色背景 + 噪声 + 雾（雾化混合 + 对比度衰减 + 灯光光晕扩散）
 * - 船体摇晃：全画面正弦平移（幅度随浪高），另加高频抖动
 * - 航标灯：按 lightModel 的灯质时间函数发光，带光晕、轻微散射
 * - 干扰源：岸边路灯（常亮暖黄）、过往船灯（移动常亮白点）、海面倒影（灯点下方纵向拉伸碎光）
 *
 * 输出 RGBA 帧缓冲，Node 测试与浏览器内"造测试视频"共用同一套渲染。
 */
import { stateAtTime } from './lightModel';
import type { GroundTruthLight, LightColor, TestScenario } from './types';

/** 确定性 LCG 随机数，保证测试可复现 */
export class Rng {
  private state: number;
  constructor(seed = 42) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
}

export const COLOR_RGB: Record<LightColor, { r: number; g: number; b: number }> = {
  red: { r: 255, g: 48, b: 48 },
  green: { r: 48, g: 235, b: 92 },
  white: { r: 245, g: 245, b: 245 },
  yellow: { r: 255, g: 214, b: 64 },
};

export interface RenderOptions {
  width: number;
  height: number;
  fog: number; // 0-1
  waveHeightM: number;
  /** 船晃主周期（秒） */
  swayPeriodSec?: number;
  seed?: number;
}

export interface FrameRender {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 该帧每盏灯的真实屏幕坐标（含船晃），供测试评分用 */
  truthPositions: { lightId: number; x: number; y: number; on: boolean; color: LightColor }[];
}

/** 全局平移（船晃），独立出来供测试验证稳像能力 */
export function globalOffset(t: number, opts: RenderOptions): { x: number; y: number } {
  const period = opts.swayPeriodSec ?? 7;
  const amp = 2 + opts.waveHeightM * 9; // 浪高 0.5m -> 6.5px, 2m -> 20px (按 480 宽画面)
  const x = Math.sin((t / period) * Math.PI * 2) * amp
    + Math.sin(t * 3.1) * amp * 0.18;
  const y = Math.cos((t / (period * 0.73)) * Math.PI * 2) * amp * 0.55
    + Math.sin(t * 2.4) * amp * 0.12;
  return { x, y };
}

function setPx(data: Uint8ClampedArray, w: number, h: number, x: number, y: number,
  r: number, g: number, b: number, add: boolean): void {
  const ix = x | 0;
  const iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
  const o = (iy * w + ix) * 4;
  if (add) {
    data[o] = Math.min(255, data[o]! + r);
    data[o + 1] = Math.min(255, data[o + 1]! + g);
    data[o + 2] = Math.min(255, data[o + 2]! + b);
  } else {
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }
  data[o + 3] = 255;
}

/** 画带光晕的灯：核心 + 多层衰减圆 */
function drawGlow(data: Uint8ClampedArray, w: number, h: number,
  x: number, y: number, rgb: { r: number; g: number; b: number },
  intensity: number, glowRadius: number): void {
  const rMax = Math.max(1.5, glowRadius);
  const r = Math.ceil(rMax);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const dist = Math.hypot(dx, dy);
      if (dist > rMax) continue;
      const falloff = Math.max(0, 1 - dist / rMax) ** 1.8;
      const v = falloff * intensity;
      setPx(data, w, h, x + dx, y + dy,
        rgb.r * v, rgb.g * v, rgb.b * v, true);
    }
  }
}

export class SyntheticScene {
  private readonly rng: Rng;
  private readonly noiseBase: Uint8ClampedArray;

  constructor(public readonly scenario: TestScenario, public readonly opts: RenderOptions) {
    this.rng = new Rng(opts.seed ?? 42);
    this.noiseBase = new Uint8ClampedArray(opts.width * opts.height * 4);
    // 预生成静态夜海背景：深蓝黑渐变 + 固定噪声纹理
    for (let y = 0; y < opts.height; y++) {
      const depth = y / opts.height;
      for (let x = 0; x < opts.width; x++) {
        const o = (y * opts.width + x) * 4;
        const n = this.rng.next() * 10;
        this.noiseBase[o] = 6 + depth * 4 + n * 0.4;
        this.noiseBase[o + 1] = 10 + depth * 8 + n * 0.5;
        this.noiseBase[o + 2] = 18 + depth * 14 + n * 0.7;
        this.noiseBase[o + 3] = 255;
      }
    }
  }

  render(t: number): FrameRender {
    const { width: w, height: h, fog } = this.opts;
    const data = new Uint8ClampedArray(this.noiseBase);
    const offset = globalOffset(t, this.opts);
    const truthPositions: FrameRender['truthPositions'] = [];
    const fogColor = { r: 128, g: 138, b: 150 };

    for (const light of this.scenario.lights) {
      const baseX = light.nx * w;
      const baseY = light.ny * h;
      const state = stateAtTime(light.characteristics, t);

      if (light.distractor) {
        this.renderDistractor(data, light, baseX, baseY, t, offset, truthPositions);
        continue;
      }

      const x = baseX + offset.x;
      const y = baseY + offset.y;
      if (state.on) {
        const rgb = COLOR_RGB[state.color];
        // 雾使灯光更弥散；灯光是主动光源，峰值只小幅衰减
        const glowRadius = 3.2 + fog * 8;
        const intensity = 1.05 - fog * 0.18;
        drawGlow(data, w, h, x, y, rgb, intensity, glowRadius);
        // 雾灯透镜聚光：灯芯叠加近白高亮核（颜色信息仍在周围彩色光晕里），
        // 保证浓雾下灯芯灰度显著高于雾背景，能被纯亮度检测稳定捕获
        if (fog > 0.25) {
          const core = {
            r: Math.min(255, rgb.r * 0.35 + 235),
            g: Math.min(255, rgb.g * 0.35 + 235),
            b: Math.min(255, rgb.b * 0.35 + 235),
          };
          drawGlow(data, w, h, x, y, core, 1.15, 2.2);
        }
        // 海面倒影：灯点正下方纵向碎光
        this.drawReflection(data, light, x, y, rgb, intensity, t);
        truthPositions.push({ lightId: light.lightId, x, y, on: true, color: state.color });
      } else {
        // 灭灯：仅留极弱环境反射，亮度必须低于检测阈值，保证暗态真实存在
        const rgb = COLOR_RGB[light.characteristics.color];
        drawGlow(data, w, h, x, y, rgb, 0.012 + fog * 0.01, 1.5 + fog * 1.5);
        truthPositions.push({ lightId: light.lightId, x, y, on: false, color: state.color });
      }
    }

    // 雾：整体雾化混合 + 动态噪声
    if (fog > 0.01) {
      const fogNoise = fog * 0.5;
      for (let i = 0; i < w * h; i++) {
        const o = i * 4;
        const f = fog * (0.85 + this.rng.next() * fogNoise);
        data[o] = data[o]! * (1 - f) + fogColor.r * f;
        data[o + 1] = data[o + 1]! * (1 - f) + fogColor.g * f;
        data[o + 2] = data[o + 2]! * (1 - f) + fogColor.b * f;
      }
    }
    return { data, width: w, height: h, truthPositions };
  }

  private renderDistractor(
    data: Uint8ClampedArray, light: GroundTruthLight,
    baseX: number, baseY: number, t: number,
    offset: { x: number; y: number },
    truth: FrameRender['truthPositions'],
  ): void {
    const { width: w, height: h } = this.opts;
    switch (light.distractorKind) {
      case 'street': {
        // 岸边路灯：常亮暖黄，位置固定（岸上物体不随船晃同向，幅度减半）
        const x = baseX + offset.x * 0.3;
        const y = baseY + offset.y * 0.3;
        drawGlow(data, w, h, x, y, { r: 255, g: 196, b: 120 }, 0.9, 5 + this.opts.fog * 6);
        truth.push({ lightId: light.lightId, x, y, on: true, color: 'yellow' });
        break;
      }
      case 'boat': {
        // 过往船灯：横向移动的常亮白点
        const move = ((t * 14) % (w + 80)) - 40;
        const x = baseX + move * 0.3 + offset.x;
        const y = baseY + Math.sin(t * 0.8) * 3 + offset.y;
        drawGlow(data, w, h, x, y, { r: 240, g: 240, b: 235 }, 0.95, 4);
        truth.push({ lightId: light.lightId, x, y, on: true, color: 'white' });
        break;
      }
      case 'reflection': {
        // 独立倒影团：水面漂浮碎光，位置抖动大
        const x = baseX + offset.x + this.rng.range(-3, 3);
        const y = baseY + this.rng.range(-5, 5);
        const rgb = COLOR_RGB[light.characteristics.color];
        for (let k = 0; k < 5; k++) {
          drawGlow(data, w, h, x + this.rng.range(-4, 4), y + k * 2.4,
            rgb, 0.25 + this.rng.next() * 0.2, 2.2);
        }
        truth.push({ lightId: light.lightId, x, y, on: true, color: light.characteristics.color });
        break;
      }
      case 'steady':
      default: {
        // 常亮坏灯/未知强光
        const x = baseX + offset.x;
        const y = baseY + offset.y;
        drawGlow(data, w, h, x, y, COLOR_RGB[light.characteristics.color], 0.9, 4);
        truth.push({ lightId: light.lightId, x, y, on: true, color: light.characteristics.color });
      }
    }
  }

  private drawReflection(
    data: Uint8ClampedArray, light: GroundTruthLight,
    x: number, y: number, rgb: { r: number; g: number; b: number },
    intensity: number, t: number,
  ): void {
    if (light.ny < 0.55) return; // 位置较高的灯不画水反
    const len = 10 + this.opts.waveHeightM * 6;
    for (let k = 1; k <= len; k += 2) {
      const ripple = Math.sin(t * 2.2 + k * 0.7 + light.lightId) * 1.6;
      const v = intensity * 0.18 * (1 - k / len);
      if (this.rng.next() > 0.35) {
        drawGlow(data, this.opts.width, this.opts.height,
          x + ripple, y + k, rgb, v, 1.8);
      }
    }
  }
}
