/**
 * Canvas 渲染：灯点轨迹叠加层。
 * 输入分析坐标系的轨迹/实时亮斑，按缩放比换算到显示画布，
 * 画稳像轨迹线、当前灯点、编号与颜色标签。
 */
import { COLOR_LABEL } from '../../core/lightModel';
import type { Track, TrackAnalysis } from '../../core/types';

export interface OverlayOptions {
  /** 分析画面尺寸 */
  analyzeWidth: number;
  analyzeHeight: number;
  showTrails: boolean;
  showLabels: boolean;
  highlightTrackId: number | null;
  analyses: TrackAnalysis[];
}

const KIND_SHORT: Record<string, string> = {
  fixed: '常', single: '单', group: '联', longFlash: '长',
  quick: '快', alternating: '互', morse: '莫',
};

export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  tracks: Track[],
  liveBlobs: { x: number; y: number; intensity: number }[] | null,
  opts: OverlayOptions,
): void {
  const { width: cssW, height: cssH } = ctx.canvas;
  const sx = cssW / opts.analyzeWidth;
  const sy = cssH / opts.analyzeHeight;
  ctx.clearRect(0, 0, cssW, cssH);
  const analysisById = new Map(opts.analyses.map((a) => [a.trackId, a]));

  for (const tr of tracks) {
    const isHi = opts.highlightTrackId === tr.id;
    const analysis = analysisById.get(tr.id);
    const colorName = analysis?.measured.color ?? 'white';
    const stroke = colorCss(colorName);
    ctx.lineWidth = isHi ? 2.4 : 1.2;
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = isHi ? 1 : 0.85;

    if (opts.showTrails) {
      ctx.beginPath();
      let pen = false;
      tr.positions.forEach((p: { x: number; y: number } | null, i: number) => {
        if (!p) {
          pen = false;
          return;
        }
        const x = p.x * sx;
        const y = p.y * sy;
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else {
          ctx.lineTo(x, y);
        }
        void i;
      });
      ctx.stroke();
    }

    // 当前位置：取最后一个命中点
    let last: { x: number; y: number } | null = null;
    for (let i = tr.positions.length - 1; i >= 0; i--) {
      const p = tr.positions[i];
      if (p) {
        last = { x: p.x, y: p.y };
        break;
      }
    }
    if (last) {
      const x = last.x * sx;
      const y = last.y * sy;
      ctx.beginPath();
      ctx.arc(x, y, isHi ? 7 : 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = stroke;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (opts.showLabels) {
        const tag = `${tr.id}${analysis ? KIND_SHORT[analysis.measured.kind] ?? '' : ''}·${COLOR_LABEL[colorName]}`;
        drawTag(ctx, x + 8, y - 8, tag, stroke, !!analysis?.isDistractor);
      }
    }
  }

  // 实时检测亮斑（白色小十字）
  if (liveBlobs) {
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1;
    for (const b of liveBlobs) {
      const x = b.x * sx;
      const y = b.y * sy;
      ctx.beginPath();
      ctx.moveTo(x - 3, y);
      ctx.lineTo(x + 3, y);
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + 3);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawTag(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, text: string,
  color: string, distractor: boolean,
): void {
  ctx.font = '11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 8;
  ctx.fillStyle = distractor ? 'rgba(120,120,120,0.82)' : 'rgba(0,0,0,0.62)';
  roundRect(ctx, x, y - 9, w, 15, 3);
  ctx.fill();
  ctx.fillStyle = distractor ? '#ddd' : color;
  ctx.fillText(text, x + 4, y + 2);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function colorCss(color: string): string {
  switch (color) {
    case 'red': return '#ff5a5a';
    case 'green': return '#4ade80';
    case 'yellow': return '#facc15';
    default: return '#f8fafc';
  }
}
