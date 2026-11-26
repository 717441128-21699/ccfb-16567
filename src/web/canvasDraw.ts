/**
 * Canvas 绘制：视频帧叠加灯点检测框/轨迹线，以及亮度节奏曲线。
 * 纯 2D Canvas，无第三方依赖。
 */
import { charName, colorName } from '../core/audit';
import type { Blob, Frame, Track } from '../core/types';

const COLOR_HEX: Record<string, string> = {
  red: '#ff5a52',
  green: '#3cff7a',
  white: '#f5f7ff',
  yellow: '#ffd642',
};

export function drawFrameOverlay(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  blobs: Blob[],
  tracks: Track[],
): void {
  ctx.clearRect(0, 0, frame.width, frame.height);
  // 检测框
  ctx.lineWidth = 1;
  for (const b of blobs) {
    ctx.strokeStyle = 'rgba(120,200,255,0.55)';
    ctx.strokeRect(b.minX - 1, b.minY - 1, b.maxX - b.minX + 2, b.maxY - b.minY + 2);
  }
  // 轨迹线（统一原始坐标，连线反映灯点随船晃的跳动）
  for (const t of tracks) {
    if (!t.confirmed) continue;
    const hex = COLOR_HEX[t.colors.find((c) => c !== null) ? pickColor(t) : 'white'] ?? '#f5f7ff';
    ctx.strokeStyle = t.rejected ? 'rgba(150,150,150,0.4)' : hex;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (const p of t.positions) {
      if (!p) {
        started = false;
        continue;
      }
      if (!started) {
        ctx.moveTo(p.x, p.y);
        started = true;
      } else {
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
    // 当前点
    const last = [...t.positions].reverse().find((p) => p !== null);
    if (last) {
      ctx.fillStyle = hex;
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function pickColor(t: Track): string {
  const tally: Record<string, number> = {};
  for (const c of t.colors) {
    if (!c) continue;
    const key = c.r > c.g && c.r > c.b ? (c.g > c.r * 0.7 ? 'yellow' : 'red')
      : c.g > c.r && c.g > c.b ? 'green'
      : 'white';
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'white';
}

/** 绘制单条轨迹的亮度时间曲线 + 二值化亮灭节律 */
export function drawBrightnessCurve(
  canvas: HTMLCanvasElement,
  track: Track,
  fps: number,
  measuredChar?: string,
): void {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const vals = track.brightness;
  const maxV = Math.max(80, ...vals.filter((v): v is number => v !== null));
  const minV = Math.min(...vals.filter((v): v is number => v !== null).map((v) => v), 0);
  const range = Math.max(1, maxV - minV);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  // 亮度曲线
  ctx.strokeStyle = '#5ec8ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  vals.forEach((v, i) => {
    const x = (i / Math.max(1, vals.length - 1)) * w;
    const y = h - ((v ?? minV) - minV) / range * (h - 14) - 4;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 亮灯节律竖线（非空帧）
  ctx.fillStyle = 'rgba(255,214,80,0.25)';
  vals.forEach((v, i) => {
    if (v !== null) {
      const x = (i / Math.max(1, vals.length - 1)) * w;
      ctx.fillRect(x, 0, 1, h);
    }
  });

  // 标注
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '11px monospace';
  const duration = (vals.length / fps).toFixed(1);
  ctx.fillText(`时长 ${duration}s · ${measuredChar ? charName(measuredChar) : '未判读'}`, 6, 14);
  void colorName;
}
