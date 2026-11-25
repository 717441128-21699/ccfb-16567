/**
 * 颜色分类与图像工具测试
 */
import { describe, expect, it } from 'vitest';
import { classifyColor, coefficientOfVariation, median, otsuThreshold, pearson } from '../src/core/imageUtils';

describe('classifyColor 灯色判定', () => {
  it('纯红判红', () => {
    expect(classifyColor({ r: 240, g: 40, b: 40 }, null).color).toBe('red');
  });
  it('纯绿判绿', () => {
    expect(classifyColor({ r: 40, g: 230, b: 80 }, null).color).toBe('green');
  });
  it('高亮近灰判白', () => {
    expect(classifyColor({ r: 240, g: 238, b: 235 }, null).color).toBe('white');
  });
  it('红黄区分：蓝通道显著弱于红绿判黄', () => {
    // 黄的本质是 r≈g >> b；雾压低饱和后该结构仍保留
    expect(classifyColor({ r: 250, g: 210, b: 60 }, null).color).toBe('yellow');
    expect(classifyColor({ r: 113, g: 104, b: 60 }, null).color).toBe('yellow');
    // 纯红的绿蓝都低且接近，不判黄
    expect(classifyColor({ r: 240, g: 50, b: 55 }, null).color).toBe('red');
  });
  it('环境色校正：减去雾偏色后还原', () => {
    // 带雾偏色的红灯，灭灯时环境偏 (60,50,55)
    const result = classifyColor({ r: 200, g: 90, b: 95 }, { r: 60, g: 50, b: 55 });
    expect(result.color).toBe('red');
  });
  it('四种颜色置信度均 > 0', () => {
    for (const c of [
      { r: 255, g: 50, b: 50 },
      { r: 50, g: 235, b: 90 },
      { r: 245, g: 245, b: 245 },
      { r: 255, g: 214, b: 64 },
    ]) {
      expect(classifyColor(c, null).confidence).toBeGreaterThan(0);
    }
  });
});

describe('统计工具', () => {
  it('变异系数：恒定序列为 0', () => {
    expect(coefficientOfVariation([5, 5, 5, 5])).toBeCloseTo(0);
  });
  it('中位数奇偶正确', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBeCloseTo(2.5);
  });
  it('Otsu 能分出双峰', () => {
    const data = [10, 12, 11, 200, 205, 198];
    const t = otsuThreshold(data);
    // 阈值应落在暗峰(≈11)与亮峰(≈200)之间
    expect(t).toBeGreaterThanOrEqual(12);
    expect(t).toBeLessThan(198);
  });
  it('皮尔逊相关：完全正相关为 1', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
  });
});
