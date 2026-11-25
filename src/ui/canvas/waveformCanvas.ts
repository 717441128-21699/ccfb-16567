/**
 * Canvas 渲染：单灯亮度-时间曲线 + 明暗区间 + 周期标注。
 */
import type { OnOffInterval, Track, TrackAnalysis } from '../../core/types';
import { colorCss } from './trackCanvas';

export interface WaveformOptions {
  track: Track;
  analysis: TrackAnalysis;
  /** 显示窗口秒数（null=全程） */
  windowSec?: number | null;
}

export function drawWaveform(ctx: CanvasRenderingContext2D, opts: WaveformOptions): void {
  const { track, analysis } = opts;
  const dpr = window.devicePixelRatio || 1;
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 44;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const t0 = track.times[0] ?? 0;
  const t1 = track.times[track.times.length - 1] ?? 1;
  const win = opts.windowSec ?? null;
  const winStart = win ? Math.max(t0, t1 - win) : t0;
  const winEnd = t1;
  const maxB = Math.max(1, ...track.brightness) * 1.05;

  const xOf = (t: number) => padL + ((t - winStart) / Math.max(1e-6, winEnd - winStart)) * plotW;
  const yOf = (v: number) => padT + plotH - (v / maxB) * plotH;

  // 背景网格
  ctx.strokeStyle = 'rgba(148,163,184,0.18)';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#94a3b8';
  const gridN = 5;
  for (let i = 0; i <= gridN; i++) {
    const t = winStart + ((winEnd - winStart) * i) / gridN;
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${t.toFixed(1)}s`, x - 10, padT + plotH + 14);
  }
  for (let i = 0; i <= 4; i++) {
    const v = (maxB * i) / 4;
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y + 3);
  }

  // 明暗区间底色
  for (const iv of analysis.intervals) {
    if (iv.endSec < winStart || iv.startSec > winEnd) continue;
    ctx.fillStyle = iv.on ? 'rgba(250,204,21,0.10)' : 'rgba(30,41,59,0.35)';
    const x = xOf(Math.max(iv.startSec, winStart));
    const x2 = xOf(Math.min(iv.endSec, winEnd));
    ctx.fillRect(x, padT, Math.max(1, x2 - x), plotH);
  }

  // 阈值线
  if (analysis.threshold > 0) {
    ctx.strokeStyle = 'rgba(248,113,113,0.7)';
    ctx.setLineDash([4, 4]);
    const y = yOf(analysis.threshold);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f87171';
    ctx.fillText(`阈值 ${analysis.threshold.toFixed(0)}`, padL + 4, y - 3);
  }

  // 亮度曲线
  ctx.strokeStyle = colorCss(analysis.measured.color);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < track.brightness.length; i++) {
    const t = track.times[i]!;
    if (t < winStart || t > winEnd) {
      pen = false;
      continue;
    }
    const x = xOf(t);
    const y = yOf(track.brightness[i]!);
    if (!pen) {
      ctx.moveTo(x, y);
      pen = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();

  // 周期标注：相邻明段起点
  const onSegs = analysis.intervals.filter((i: OnOffInterval) => i.on);
  if (onSegs.length >= 2) {
    ctx.strokeStyle = 'rgba(74,222,128,0.8)';
    ctx.fillStyle = '#4ade80';
    ctx.lineWidth = 1;
    for (let i = 1; i < Math.min(onSegs.length, 4); i++) {
      const a = xOf(onSegs[i - 1]!.startSec);
      const b = xOf(onSegs[i]!.startSec);
      const y = padT + 8;
      ctx.beginPath();
      ctx.moveTo(a, y);
      ctx.lineTo(b, y);
      ctx.moveTo(a, y - 3);
      ctx.lineTo(a, y + 3);
      ctx.moveTo(b, y - 3);
      ctx.lineTo(b, y + 3);
      ctx.stroke();
      const period = onSegs[i]!.startSec - onSegs[i - 1]!.startSec;
      ctx.fillText(`${period.toFixed(2)}s`, (a + b) / 2 - 12, y - 4);
    }
  }
  ctx.restore();
}
