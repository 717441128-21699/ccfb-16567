/**
 * 确定性种子化随机数：mulberry32 + 高斯采样。
 * 同种子下 Node 评估与浏览器渲染结果完全一致。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 保证非零 32 位状态
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** [0,1) 均匀分布 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 均值 0、标准差 sigma 的高斯分布（Box-Muller） */
  gaussian(sigma: number): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** [min,max) 均匀 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** 从数组中均匀取一个 */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
}
