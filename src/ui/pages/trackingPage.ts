/**
 * 灯点跟踪页：启动 Worker 分析管线，Canvas 实时叠加检测亮斑与稳像轨迹，
 * 完成后列出全部轨迹，点选查看该灯亮度-时间曲线与实测灯质。
 */
import { AnalysisPipeline, videoElementSource, type VideoSource } from '../../core/pipeline';
import { autoAssignBeacons } from '../../core/audit';
import { describeLight } from '../../core/lightModel';
import type { Track, TrackAnalysis } from '../../core/types';
import type { WorkerResponse } from '../../core/workerProtocol';
import { h, setFooter } from '../dom';
import { store } from '../../state/store';
import { drawOverlay } from '../canvas/trackCanvas';
import { drawWaveform } from '../canvas/waveformCanvas';
import { SyntheticVideoSource } from '../syntheticSource';

export function renderTrackingPage(root: HTMLElement): void {
  const state = store.getState();
  let pipeline: AnalysisPipeline | null = null;
  let tracks: Track[] = [];
  let analyses: TrackAnalysis[] = [];
  let analyzeW = state.config.analyzeWidth;
  let analyzeH = 270;
  let liveBlobs: { x: number; y: number; intensity: number }[] | null = null;
  let showTrails = true;
  let showLabels = true;

  const baseCanvas = h('canvas', { width: 480, height: 270 }) as HTMLCanvasElement;
  const overlayCanvas = h('canvas', { width: 480, height: 270, class: 'overlay' }) as HTMLCanvasElement;
  const stage = h('div', { class: 'canvas-stage' }, [baseCanvas, overlayCanvas]);
  const baseCtx = baseCanvas.getContext('2d')!;
  const overCtx = overlayCanvas.getContext('2d')!;

  const waveCanvas = h('canvas', {
    width: 640, height: 220,
    style: 'width:100%;background:#050912;border-radius:8px',
  }) as HTMLCanvasElement;
  sizeCanvasForDpr(waveCanvas, 640, 220);

  const progressFill = h('div', { class: 'progress-fill', style: 'width:0%' });
  const progressText = h('span', { class: 'muted', textContent: '待启动' });
  const statTracks = stat('跟踪轨迹', '0');
  const statBlobs = stat('当前亮斑', '0');
  const statDistract = stat('疑似干扰', '0');

  const trackListEl = h('div', { class: 'track-list', id: 'track-list' }, [
    h('p', { class: 'muted', textContent: '分析完成后在此列出灯点轨迹' }),
  ]);
  const detailEl = h('div', { id: 'track-detail' }, [
    h('p', { class: 'muted', textContent: '点击左侧轨迹查看亮度曲线与灯质' }),
  ]);

  const startBtn = h('button', { textContent: '开始逐帧分析' });
  const cancelBtn = h('button', { class: 'danger', textContent: '取消', disabled: true });
  const toResultsBtn = h('button', { class: 'secondary', textContent: '前往核查结果', disabled: true });
  let cancelHandle: (() => void) | null = null;

  const trailToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  trailToggle.onchange = () => { showTrails = trailToggle.checked; renderOverlay(); };
  const labelToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  labelToggle.onchange = () => { showLabels = labelToggle.checked; renderOverlay(); };

  function renderOverlay(): void {
    drawOverlay(overCtx, tracks, liveBlobs, {
      analyzeWidth: analyzeW,
      analyzeHeight: analyzeH,
      showTrails,
      showLabels,
      highlightTrackId: store.getState().selectedTrackId,
      analyses,
    });
  }

  function loop(): void {
    renderOverlay();
    requestAnimationFrame(loop);
  }

  startBtn.onclick = () => void start();
  cancelBtn.onclick = () => cancelHandle?.();
  toResultsBtn.onclick = () => store.setPage('results');

  async function resolveSource(): Promise<{ source: VideoSource; previewCanvas?: HTMLCanvasElement }> {
    const synthetic = (window as unknown as { __syntheticSource?: SyntheticVideoSource }).__syntheticSource;
    if (synthetic) {
      // 重建一个新的 source（上一个可能已被消费完）
      return { source: synthetic, previewCanvas: synthetic.displayCanvas };
    }
    if (!state.videoUrl) throw new Error('请先在视频导入页导入视频或生成测试视频');
    const video = document.createElement('video');
    video.src = state.videoUrl;
    video.muted = true;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('视频加载失败'));
    });
    return { source: videoElementSource(video, state.videoName) };
  }

  async function start(): Promise<void> {
    startBtn.disabled = true;
    cancelBtn.disabled = false;
    toResultsBtn.disabled = true;
    tracks = [];
    analyses = [];
    liveBlobs = null;
    store.update({ tracks: [], analyses: [], report: null });
    try {
      const { source, previewCanvas } = await resolveSource();
      pipeline = new AnalysisPipeline(store.getState().config);
      const doneMessages: WorkerResponse[] = [];
      pipeline.onMessage((msg: WorkerResponse) => {
        if (msg.type === 'progress') {
          liveBlobs = msg.lastSample.blobs.map((b) => ({
            x: b.x, y: b.y, intensity: b.intensity,
          }));
          statBlobs.querySelector('.v')!.textContent = String(msg.blobCount);
          progressText.textContent = `帧 ${msg.frameIndex + 1} · t=${msg.t.toFixed(1)}s · 亮斑 ${msg.blobCount}`;
          if (previewCanvas) {
            baseCtx.drawImage(previewCanvas, 0, 0, baseCanvas.width, baseCanvas.height);
          }
        } else if (msg.type === 'done') {
          doneMessages.push(msg);
        } else if (msg.type === 'error') {
          progressText.textContent = `错误：${msg.message}`;
        }
      });
      const handle = pipeline.process(source, (pct) => {
        progressFill.style.width = `${(pct * 100).toFixed(1)}%`;
      });
      cancelHandle = handle.cancel;
      await handle.promise;

      const doneMsg = doneMessages.find((m): m is Extract<WorkerResponse, { type: 'done' }> => m.type === 'done');
      if (doneMsg) {
        tracks = doneMsg.tracks;
        analyses = doneMsg.analyses;
        analyzeW = doneMsg.analyzeWidth;
        analyzeH = doneMsg.analyzeHeight;
        baseCanvas.width = analyzeW;
        baseCanvas.height = analyzeH;
        overlayCanvas.width = analyzeW;
        overlayCanvas.height = analyzeH;
        const assignment = autoAssignBeacons(
          analyses,
          tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy })),
          store.getState().beacons,
          analyzeW,
          analyzeH,
          store.getState().beaconHints,
        );
        store.update({
          tracks, analyses, assignment,
          analyzeSize: {
            width: analyzeW, height: analyzeH,
            videoWidth: doneMsg.videoWidth, videoHeight: doneMsg.videoHeight,
          },
        });
        statTracks.querySelector('.v')!.textContent = String(tracks.length);
        statDistract.querySelector('.v')!.textContent =
          String(analyses.filter((a) => a.isDistractor).length);
        progressText.textContent =
          `完成：${doneMsg.frameCount} 帧 / ${doneMsg.durationSec.toFixed(1)}s，采样率 ${doneMsg.sampleFps.toFixed(1)} fps`;
        progressFill.style.width = '100%';
        renderTrackList();
        toResultsBtn.disabled = false;
        setFooter('分析完成', `${tracks.length} 条轨迹`);
      }
    } catch (err) {
      progressText.textContent = `失败：${err instanceof Error ? err.message : String(err)}`;
      setFooter('分析失败');
    } finally {
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      pipeline?.dispose();
      pipeline = null;
    }
  }

  function renderTrackList(): void {
    trackListEl.replaceChildren();
    const s = store.getState();
    for (const tr of tracks) {
      const analysis = analyses.find((a) => a.trackId === tr.id);
      const beaconId = s.assignment.get(tr.id);
      const beacon = s.beacons.find((b) => b.id === beaconId);
      const item = h('div', {
        class: `track-item${analysis?.isDistractor ? ' distractor' : ''}`,
        onclick: () => selectTrack(tr.id, item),
      }, [
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, [
          h('strong', { textContent: `轨迹 #${tr.id}` }),
          analysis?.isDistractor
            ? h('span', { class: 'badge gray', textContent: '疑似干扰' })
            : h('span', { class: 'badge kind', textContent: describeLight(analysis!.measured).split(' ')[0]! }),
        ]),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:3px' }, [
          document.createTextNode(
            `${analysis ? describeLight(analysis.measured) : '未分析'}${beacon ? ` · 配对 ${beacon.id}` : ''}`,
          ),
        ]),
        h('div', { class: 'muted', style: 'font-size:11px;margin-top:2px' }, [
          document.createTextNode(`命中 ${tr.hits} 帧 · 占空比 ${analysis ? (analysis.dutyCycle * 100).toFixed(0) : '—'}%`),
        ]),
      ]);
      trackListEl.append(item);
    }
  }

  function selectTrack(id: number, el: HTMLElement): void {
    store.update({ selectedTrackId: id });
    trackListEl.querySelectorAll('.track-item').forEach((n) => n.classList.remove('selected'));
    el.classList.add('selected');
    const tr = tracks.find((t) => t.id === id)!;
    const analysis = analyses.find((a) => a.trackId === id)!;
    const s = store.getState();
    const beaconOptions = s.beacons.map((b) =>
      h('option', { value: b.id, textContent: `${b.id} ${b.name}` }));
    const assignSelect = h('select', {}, [
      h('option', { value: '', textContent: '— 不配对航标 —' }),
      ...beaconOptions,
    ]) as HTMLSelectElement;
    assignSelect.value = s.assignment.get(id) ?? '';
    assignSelect.onchange = () => {
      store.assignTrack(id, assignSelect.value || null);
      renderTrackList();
      const selected = trackListEl.querySelector('.selected');
      if (selected) selectTrack(id, selected as HTMLElement);
    };

    detailEl.replaceChildren(
      h('h3', { textContent: `轨迹 #${id} 实测灯质` }),
      h('div', { class: 'stat-grid', style: 'margin-bottom:12px' }, [
        miniStat('灯质种类', describeLight(analysis.measured).split(' ')[0]!),
        miniStat('周期', `${analysis.measured.periodSec.toFixed(2)} s`),
        miniStat('明时长', `${analysis.measured.onSec.toFixed(2)} s`),
        miniStat('占空比', `${(analysis.dutyCycle * 100).toFixed(1)}%`),
        miniStat('明暗阈值', analysis.threshold.toFixed(0)),
        miniStat('命中帧', String(tr.hits)),
      ]),
      h('label', { class: 'field', style: 'margin-bottom:12px' }, [
        document.createTextNode('人工配对航标'),
        assignSelect,
      ]),
      ...(analysis.distractorReasons.length
        ? [h('div', { style: 'margin-bottom:10px' }, [
            h('strong', { style: 'color:var(--warn)', textContent: '干扰判定依据：' }),
            h('ul', { class: 'mismatch-list' }, analysis.distractorReasons.map((r) => h('li', { textContent: r }))),
          ])]
        : []),
      h('h3', { textContent: '亮度-时间曲线与明暗节奏' }),
      waveCanvas,
    );
    requestAnimationFrame(() => {
      const ctx = waveCanvas.getContext('2d')!;
      drawWaveform(ctx, { track: tr, analysis });
    });
    renderOverlay();
  }

  root.append(
    h('div', { class: 'card' }, [
      h('h2', { textContent: '灯点跟踪' }),
      h('div', { class: 'toolbar' }, [
        startBtn, cancelBtn, toResultsBtn,
        h('span', { class: 'spacer' }),
        h('label', { style: 'display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)' }, [
          trailToggle, document.createTextNode('轨迹线'),
        ]),
        h('label', { style: 'display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted)' }, [
          labelToggle, document.createTextNode('标签'),
        ]),
      ]),
      h('div', { class: 'progress-track', style: 'margin-bottom:8px' }, [progressFill]),
      progressText,
      h('div', { class: 'stat-grid', style: 'margin-top:12px' }, [statTracks, statBlobs, statDistract]),
    ]),
    h('div', { class: 'row' }, [
      h('div', { class: 'col', style: 'flex:1.4' }, [
        h('div', { class: 'card' }, [
          h('h3', { textContent: '画面与轨迹叠加（白线十字=逐帧检测亮斑，彩线=稳像后轨迹）' }),
          stage,
        ]),
        h('div', { class: 'card' }, [detailEl]),
      ]),
      h('div', { class: 'col' }, [
        h('div', { class: 'card' }, [
          h('h3', { textContent: '轨迹列表' }),
          trackListEl,
        ]),
      ]),
    ]),
  );

  loop();
  // 重入页面时恢复已有结果
  if (state.tracks.length) {
    tracks = state.tracks;
    analyses = state.analyses;
    analyzeW = state.analyzeSize.width || analyzeW;
    analyzeH = state.analyzeSize.height || analyzeH;
    baseCanvas.width = analyzeW;
    baseCanvas.height = analyzeH;
    overlayCanvas.width = analyzeW;
    overlayCanvas.height = analyzeH;
    statTracks.querySelector('.v')!.textContent = String(tracks.length);
    statDistract.querySelector('.v')!.textContent =
      String(analyses.filter((a) => a.isDistractor).length);
    renderTrackList();
    toResultsBtn.disabled = false;
    progressFill.style.width = '100%';
    progressText.textContent = '已恢复上次分析结果';
  }
  setFooter('灯点跟踪页');
}

function stat(key: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'v', textContent: value }),
    h('div', { class: 'k', textContent: key }),
  ]);
}

function miniStat(key: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, [
    h('div', { style: 'font-size:15px;font-weight:600', textContent: value }),
    h('div', { class: 'k', textContent: key }),
  ]);
}

function sizeCanvasForDpr(canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.maxWidth = '100%';
}
