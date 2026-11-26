/**
 * 视频导入页：选择合成测试场景（浪高×雾况）、时长/帧率，
 * 或导入真实夜拍视频。合成场景自带每盏灯真值，用于验收。
 */
import { SCENARIO_PRESETS } from '../../core/sampleData';
import { navigate } from '../router';
import { getState, setAnalysisParams, setPreset, setState, subscribe } from '../store';

export function renderImportPage(): HTMLElement {
  const el = document.createElement('div');
  const draw = (): void => {
    const s = getState();
    el.innerHTML = `
      <div class="panel">
        <h2>合成测试场景</h2>
        <p class="muted small">按浪高（小/中/大）× 雾浓度（无/轻/浓）参数化生成夜拍视频，20 座航标覆盖 7 种灯质 × 4 色，
        含路灯/船灯干扰、海面倒影，并注入熄灭、常亮、周期漂移三类故障。</p>
        <div class="row" style="margin: 12px 0">
          ${SCENARIO_PRESETS.map((p) => `
            <button class="ghost ${p.key === s.preset.key ? 'primary' : ''}" data-preset="${p.key}" style="${p.key === s.preset.key ? '' : ''}">${p.label}</button>
          `).join('')}
        </div>
        <div class="row">
          <label class="small muted">时长(s)
            <input type="number" id="duration" min="20" max="600" step="10" value="${s.durationSec}" style="width:90px">
          </label>
          <label class="small muted">分析帧率(fps)
            <input type="number" id="fps" min="5" max="25" step="1" value="${s.analysisFps}" style="width:80px">
          </label>
          <span class="small muted">场景分辨率 960×540 · 当前视频约 ${(s.durationSec * s.analysisFps).toFixed(0)} 帧</span>
        </div>
        <div class="row" style="margin-top:16px">
          <button class="primary" id="start">开始分析 → 跟踪页</button>
        </div>
      </div>

      <div class="panel">
        <h2>真实视频导入</h2>
        <p class="muted small">支持浏览器可解码的夜拍视频（mp4/webm）。导入后按目标帧率抽帧送入同一套检测/跟踪/分类流水线。
        真实视频需在跟踪页人工绑定灯点与航标表条目。</p>
        <div class="row">
          <input type="file" id="file" accept="video/*">
          <span id="file-info" class="small muted">未选择文件</span>
        </div>
        <video id="preview" controls style="max-width:420px; margin-top:12px; display:none"></video>
      </div>`;

    el.querySelectorAll<HTMLButtonElement>('button[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = SCENARIO_PRESETS.find((p) => p.key === btn.dataset.preset)!;
        setPreset(preset);
      });
    });
    el.querySelector<HTMLInputElement>('#duration')!.addEventListener('change', (e) => {
      setAnalysisParams({ durationSec: Number((e.target as HTMLInputElement).value) });
    });
    el.querySelector<HTMLInputElement>('#fps')!.addEventListener('change', (e) => {
      setAnalysisParams({ fps: Number((e.target as HTMLInputElement).value) });
    });
    el.querySelector<HTMLButtonElement>('#start')!.addEventListener('click', () => {
      setState({ output: null, progress: { frame: 0, total: 0, tracks: 0 } });
      navigate('track');
    });

    const fileInput = el.querySelector<HTMLInputElement>('#file')!;
    const preview = el.querySelector<HTMLVideoElement>('#preview')!;
    const info = el.querySelector<HTMLElement>('#file-info')!;
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      preview.src = url;
      preview.style.display = 'block';
      info.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
      preview.addEventListener('loadedmetadata', () => {
        info.textContent += ` · ${preview.duration.toFixed(1)}s ${preview.videoWidth}×${preview.videoHeight}`;
      }, { once: true });
    });
  };
  subscribe(draw);
  draw();
  return el;
}
