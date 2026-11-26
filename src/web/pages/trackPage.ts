/**
 * 跟踪页：启动分析 Worker，Canvas 实时绘制检测框+轨迹线，
 * 选中轨迹后绘制其亮度时间曲线与明暗节奏。
 */
import type { Blob, Frame, Track, WorkerResponse } from '../../core/types';
import { drawBrightnessCurve, drawFrameOverlay } from '../canvasDraw';
import { navigate } from '../router';
import { getState, selectedClassification, setOutput, setState, subscribe } from '../store';

let worker: Worker | null = null;
let latestFrame: Frame | null = null;
let latestBlobs: Blob[] = [];

export function renderTrackPage(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="panel">
      <div class="row">
        <h2 style="margin:0; flex:1">灯点跟踪</h2>
        <button class="primary" id="run">启动分析</button>
        <button class="ghost" id="cancel">取消</button>
        <button class="ghost" id="to-results">查看核查结果 →</button>
      </div>
      <div class="row" style="margin-top:12px">
        <div class="progress-wrap"><div class="progress-bar" id="bar" style="width:0%"></div></div>
        <span class="small muted" id="progress-text">待启动</span>
      </div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h2>实时画面（检测框 + 轨迹线）</h2>
        <div class="canvas-wrap"><canvas id="overlay"></canvas></div>
        <p class="small muted" style="margin-top:8px">蓝框=检测到的灯点连通域；彩色折线=各灯轨迹（红/绿/白/黄）；灰线=干扰/倒影。</p>
      </div>
      <div class="panel">
        <h2>轨迹列表</h2>
        <div class="scroll" id="track-list" style="max-height:280px"></div>
        <h3>选中轨迹亮度曲线</h3>
        <div class="canvas-wrap"><canvas id="curve" width="330" height="150"></canvas></div>
        <div id="curve-meta" class="small muted" style="margin-top:8px"></div>
      </div>
    </div>`;

  const overlayCanvas = el.querySelector<HTMLCanvasElement>('#overlay')!;
  const overlayCtx = overlayCanvas.getContext('2d')!;
  const curveCanvas = el.querySelector<HTMLCanvasElement>('#curve')!;
  const bar = el.querySelector<HTMLElement>('#bar')!;
  const progressText = el.querySelector<HTMLElement>('#progress-text')!;
  const trackList = el.querySelector<HTMLElement>('#track-list')!;

  const renderLoop = (): void => {
    if (latestFrame) {
      if (overlayCanvas.width !== latestFrame.width) overlayCanvas.width = latestFrame.width;
      if (overlayCanvas.height !== latestFrame.height) overlayCanvas.height = latestFrame.height;
      const tracks = getState().output?.tracks ?? currentTracks;
      overlayCtx.putImageData(new ImageData(latestFrame.data, latestFrame.width, latestFrame.height), 0, 0);
      drawFrameOverlay(overlayCtx, latestFrame, latestBlobs, tracks);
    }
    requestAnimationFrame(renderLoop);
  };
  let currentTracks: Track[] = [];
  requestAnimationFrame(renderLoop);

  const refreshTrackList = (): void => {
    const tracks = getState().output?.tracks ?? currentTracks;
    trackList.innerHTML = tracks.map((t) => {
      const obs = t.brightness.filter((v) => v !== null).length;
      const sel = getState().selectedTrackId === t.id;
      return `<div class="row" data-track="${t.id}" style="padding:6px 8px; border-radius:6px; cursor:pointer; ${sel ? 'background:rgba(74,168,255,0.12)' : ''}">
        <span class="small">#${t.id}</span>
        <span class="small muted">观测 ${obs} 帧</span>
        ${t.rejected ? '<span class="badge neutral">干扰</span>' : ''}
        ${t.steady ? '<span class="badge warn">常亮</span>' : ''}
      </div>`;
    }).join('');
    trackList.querySelectorAll<HTMLElement>('[data-track]').forEach((row) => {
      row.addEventListener('click', () => {
        setState({ selectedTrackId: Number(row.dataset.track) });
        drawSelectedCurve();
      });
    });
  };

  const drawSelectedCurve = (): void => {
    const s = getState();
    const t = s.output?.tracks.find((x) => x.id === s.selectedTrackId)
      ?? currentTracks.find((x) => x.id === s.selectedTrackId);
    if (!t) return;
    const cls = selectedClassification();
    drawBrightnessCurve(curveCanvas, t, s.analysisFps, cls?.characteristic);
    el.querySelector<HTMLElement>('#curve-meta')!.textContent = cls
      ? `判读：${cls.characteristic} · 周期 ${cls.periodSec?.toFixed(2) ?? '—'}s · 灯色 ${cls.colors.join('+')} · 占空 ${(cls.dutyCycle * 100).toFixed(0)}%`
      : '轨迹尚在积累，分析完成后显示判读';
  };

  el.querySelector<HTMLButtonElement>('#run')!.addEventListener('click', () => startWorker());
  el.querySelector<HTMLButtonElement>('#cancel')!.addEventListener('click', () => {
    worker?.terminate();
    worker = null;
    setState({ running: false });
    progressText.textContent = '已取消';
  });
  el.querySelector<HTMLButtonElement>('#to-results')!.addEventListener('click', () => navigate('results'));

  function startWorker(): void {
    worker?.terminate();
    setState({ running: true, output: null });
    worker = new Worker(new URL('../analysis.worker.ts', import.meta.url), { type: 'module' });
    const s = getState();
    worker.postMessage({
      type: 'start',
      payload: {
        scene: s.scene,
        analysisFps: s.analysisFps,
        horizonRatio: 0.62,
        aids: s.aids,
        matches: [],
      },
    });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        const pct = msg.payload.total ? (msg.payload.frame / msg.payload.total) * 100 : 0;
        bar.style.width = `${pct}%`;
        progressText.textContent = `帧 ${msg.payload.frame + 1}/${msg.payload.total} · 活动轨迹 ${msg.payload.tracks}`;
      } else if (msg.type === 'frame') {
        latestFrame = msg.payload.frame;
        latestBlobs = msg.payload.blobs;
        currentTracks = msg.payload.tracks as unknown as Track[];
        refreshTrackList();
      } else if (msg.type === 'done') {
        setOutput(msg.payload);
        currentTracks = msg.payload.tracks;
        setState({ running: false });
        bar.style.width = '100%';
        progressText.textContent = `完成：${msg.payload.tracks.length} 条轨迹，耗时 ${(msg.payload.analysisTimeMs / 1000).toFixed(1)}s`;
        refreshTrackList();
        drawSelectedCurve();
      } else if (msg.type === 'error') {
        progressText.textContent = `错误：${msg.payload}`;
        setState({ running: false });
      }
    };
  }

  subscribe(() => {
    refreshTrackList();
    drawSelectedCurve();
  });

  // 自动开始
  startWorker();
  return el;
}
