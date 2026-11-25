/**
 * 配置换算：AnalyzerConfig -> 跟踪器参数
 */
import type { AnalyzerConfig } from './types';

export function trackerFrameOptions(config: AnalyzerConfig) {
  return {
    frameMatchDistance: config.maxMatchDistance,
    clusterDistance: config.maxMatchDistance * 1.4,
    // 大浪浓雾下亮灯帧可能很稀疏，下限取 3；长周期灯 60s 内也有 2~4 次闪光
    minHits: 3,
  };
}
