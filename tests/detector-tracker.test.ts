/**
 * 检测器与跟踪器测试：连通域检测、多目标跟踪、断航重捕获。
 */
import { describe, expect, it } from 'vitest';
import { detectBlobs } from '../src/core/detector';
import { MultiTracker } from '../src/core/tracker';
import type { Frame } from '../src/core/types';

function makeFrame(width: number, height: number, index: number, spots: { x: number; y: number; r?: number; g?: number; b?: number }[]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  // 暗背景
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 8;
    data[i + 1] = 10;
    data[i + 2] = 14;
    data[i + 3] = 255;
  }
  for (const s of spots) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const p = (y * width + x) * 4;
        data[p] = s.r ?? 255;
        data[p + 1] = s.g ?? 255;
        data[p + 2] = s.b ?? 255;
      }
    }
  }
  return { width, height, data, index, timeSec: index / 10 };
}

describe('detectBlobs 灯点检测', () => {
  it('检测出全部亮灯点', () => {
    const frame = makeFrame(320, 240, 0, [
      { x: 50, y: 50 }, { x: 150, y: 80, r: 255, g: 40, b: 30 }, { x: 250, y: 120, r: 40, g: 255, b: 90 },
    ]);
    const blobs = detectBlobs(frame);
    expect(blobs.length).toBe(3);
  });

  it('空黑画面无灯点', () => {
    const frame = makeFrame(320, 240, 0, []);
    expect(detectBlobs(frame).length).toBe(0);
  });

  it('输出形态特征字段完整', () => {
    const frame = makeFrame(320, 240, 0, [{ x: 100, y: 100 }]);
    const [b] = detectBlobs(frame);
    expect(b).toBeDefined();
    expect(b!.area).toBeGreaterThan(0);
    expect(b!.aspect).toBeGreaterThan(0);
    expect(b!.brightness).toBeGreaterThan(50);
  });
});

describe('MultiTracker 多目标跟踪', () => {
  it('静止两灯各自保持独立轨迹', () => {
    const tracker = new MultiTracker();
    for (let f = 0; f < 20; f++) {
      const frame = makeFrame(320, 240, f, [{ x: 60, y: 60 }, { x: 200, y: 120 }]);
      tracker.update(detectBlobs(frame), frame);
    }
    const confirmed = tracker.tracks.filter((t) => t.confirmed);
    expect(confirmed.length).toBe(2);
  });

  it('灯灭后重亮能接回同一轨迹（断航重捕获）', () => {
    const tracker = new MultiTracker({ maxMissed: 30 });
    // 前 5 帧亮
    for (let f = 0; f < 5; f++) tracker.update(detectBlobs(makeFrame(320, 240, f, [{ x: 100, y: 100 }])), makeFrame(320, 240, f, [{ x: 100, y: 100 }]));
    const idBefore = tracker.tracks[0]!.id;
    // 灭 10 帧
    for (let f = 5; f < 15; f++) tracker.update(detectBlobs(makeFrame(320, 240, f, [])), makeFrame(320, 240, f, []));
    // 重亮 5 帧
    for (let f = 15; f < 20; f++) tracker.update(detectBlobs(makeFrame(320, 240, f, [{ x: 100, y: 100 }])), makeFrame(320, 240, f, [{ x: 100, y: 100 }]));
    const same = tracker.tracks.find((t) => t.id === idBefore);
    expect(same).toBeDefined();
    // 重亮后该轨迹应继续有观测
    const lateObs = same!.brightness.slice(15).filter((v) => v !== null).length;
    expect(lateObs).toBeGreaterThan(0);
  });

  it('一个画面 20 盏灯各跟各的', () => {
    const tracker = new MultiTracker();
    const spots = Array.from({ length: 20 }, (_, i) => ({ x: 40 + (i % 5) * 120, y: 50 + Math.floor(i / 5) * 90 }));
    for (let f = 0; f < 15; f++) {
      const frame = makeFrame(640, 400, f, spots);
      tracker.update(detectBlobs(frame), frame);
    }
    const confirmed = tracker.tracks.filter((t) => t.confirmed);
    expect(confirmed.length).toBe(20);
  });
});
