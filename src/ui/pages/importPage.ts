/**
 * 视频导入页：本地夜拍视频导入，或按浪高/雾浓度合成测试视频。
 * 合成时实时渲染预览，可选择同时录制 WebM 落盘。
 */
import { CanvasRecorder } from '../../core/recorder';
import { SCENARIO_TEMPLATES, buildScenario } from '../../core/scenarios';
import { SyntheticScene } from '../../core/synthetic';
import type { TestScenario } from '../../core/types';
import { h, setFooter } from '../dom';
import { store } from '../../state/store';
import { SyntheticVideoSource } from '../syntheticSource';

export function renderImportPage(root: HTMLElement): void {
  const state = store.getState();

  const video = h('video', {
    controls: true,
    style: 'width:100%;max-height:340px;background:#000;border-radius:8px',
  }) as HTMLVideoElement;

  if (state.videoUrl) video.src = state.videoUrl;

  const dropZone = h('div', { class: 'drop-zone', id: 'drop-zone' }, [
    h('div', { class: 'big', textContent: '拖入夜拍视频，或点击选择文件' }),
    h('div', { textContent: '支持 MP4 / WebM / MOV，建议时长 5–15 分钟' }),
  ]);
  const fileInput = h('input', {
    type: 'file',
    accept: 'video/*',
    style: 'display:none',
    onchange: (e) => void onVideoFile(e),
  });
  dropZone.append(fileInput);
  dropZone.onclick = () => fileInput.click();
  dropZone.ondragover = (e) => {
    e.preventDefault();
    dropZone.classList.add('drag');
  };
  dropZone.ondragleave = () => dropZone.classList.remove('drag');
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadVideoFile(f);
  };

  // ---- 合成测试视频区 ----
  const scenarioSelect = h('select', {},
    SCENARIO_TEMPLATES.map((tpl) =>
      h('option', { value: tpl.id, textContent: tpl.name }))) as HTMLSelectElement;

  const durationInput = h('input', {
    type: 'number', value: '60', min: '10', max: '600', step: '10',
  }) as HTMLInputElement;

  const recordCheck = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;

  const previewCanvas = h('canvas', {
    width: 480, height: 270,
    style: 'width:100%;background:#000;border-radius:8px',
  }) as HTMLCanvasElement;

  const genLog = h('div', { id: 'gen-log' });
  const genBtn = h('button', { textContent: '生成测试视频并送入跟踪页' });
  const recordBtn = h('button', {
    class: 'secondary',
    textContent: '仅录制 WebM 下载',
    disabled: !CanvasRecorder.isSupported(),
  });

  function logLine(text: string, cls = ''): void {
    genLog.append(h('div', { class: `log-line ${cls}`, textContent: text }));
    genLog.scrollTop = genLog.scrollHeight;
  }

  async function buildScene(): Promise<{
    scene: SyntheticScene; scenario: TestScenario; source: SyntheticVideoSource;
  }> {
    const tpl = SCENARIO_TEMPLATES.find((t) => t.id === scenarioSelect.value)!;
    const duration = Math.max(10, Number(durationInput.value) || 60);
    const built = buildScenario(tpl, duration);
    // 与航标表联动：若当前无航标表或数量不一致，同步载入该场景的航标表
    const s = store.getState();
    if (s.beacons.length !== built.beacons.length) {
      store.setBeacons(built.beacons, built.hints);
      logLine(`已同步载入航标表：${built.beacons.length} 座（含 2 座故障注入灯）`, 'ok');
    }
    const scene = new SyntheticScene(built.scenario, {
      width: 480,
      height: 270,
      fog: tpl.fog,
      waveHeightM: tpl.waveHeightM,
    });
    const source = new SyntheticVideoSource(scene, store.getState().config.sampleFps);
    return { scene, scenario: built.scenario, source };
  }

  genBtn.onclick = async () => {
    genBtn.disabled = true;
    recordBtn.disabled = true;
    genLog.replaceChildren();
    try {
      const { scenario, source } = await buildScene();
      // 把合成源暂存到 window，供跟踪页直接消费（不落盘也能核查）
      (window as unknown as Record<string, unknown>).__syntheticSource = source;
      store.setVideo(source.videoName, null);
      logLine(`场景「${scenario.name}」已生成：${scenario.lights.length} 个光源（含 5 个干扰源）`, 'ok');
      logLine(`浪高 ${scenario.waveHeightM}m，雾浓度 ${scenario.fog}，时长 ${scenario.durationSec}s`);
      // 预览首帧
      const pctx = previewCanvas.getContext('2d')!;
      const first = await source.drawFrame(pctx);
      if (first) logLine(`预览渲染成功，${store.getState().config.sampleFps} fps 采样`);
      setFooter('测试视频已就绪', source.videoName);
      store.setPage('tracking');
    } catch (err) {
      logLine(`生成失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      genBtn.disabled = false;
      recordBtn.disabled = !CanvasRecorder.isSupported();
    }
  };

  recordBtn.onclick = async () => {
    genBtn.disabled = true;
    recordBtn.disabled = true;
    genLog.replaceChildren();
    let recorder: CanvasRecorder | null = null;
    try {
      const { scene, scenario } = await buildScene();
      const fps = store.getState().config.sampleFps;
      recorder = new CanvasRecorder();
      recorder.start(previewCanvas, { fps });
      logLine('开始录制 WebM…');
      const pctx = previewCanvas.getContext('2d')!;
      const frames = scenario.durationSec * fps;
      for (let i = 0; i < frames; i++) {
        const t = i / fps;
        const frame = scene.render(t);
        pctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
        if (i % fps === 0) logLine(`录制中 ${t.toFixed(0)}s / ${scenario.durationSec}s`);
        await new Promise((r) => setTimeout(r, 0));
      }
      const blob = await recorder.stop();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${scenario.id}.webm` });
      a.click();
      logLine(`录制完成：${(blob.size / 1024 / 1024).toFixed(2)} MB，已触发下载`, 'ok');
    } catch (err) {
      logLine(`录制失败：${err instanceof Error ? err.message : String(err)}`, 'err');
    } finally {
      genBtn.disabled = false;
      recordBtn.disabled = !CanvasRecorder.isSupported();
    }
  };

  async function loadVideoFile(file: File): Promise<void> {
    const url = URL.createObjectURL(file);
    video.src = url;
    store.setVideo(file.name, url);
    (window as unknown as Record<string, unknown>).__syntheticSource = null;
    setFooter('视频已导入', file.name);
  }

  async function onVideoFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) await loadVideoFile(f);
    input.value = '';
  }

  root.append(
    h('div', { class: 'card' }, [
      h('h2', { textContent: '视频导入' }),
      dropZone,
      h('div', { style: 'margin-top:14px' }, [video]),
    ]),
    h('div', { class: 'card' }, [
      h('h2', { textContent: '合成测试视频（自造带真值夜拍素材）' }),
      h('div', { class: 'row' }, [
        h('div', { class: 'col' }, [
          h('label', { class: 'field' }, [
            document.createTextNode('场景（浪高 / 雾浓度）'),
            scenarioSelect,
          ]),
          h('div', { style: 'height:10px' }),
          h('label', { class: 'field' }, [
            document.createTextNode('时长（秒）'),
            durationInput,
          ]),
          h('div', { style: 'height:10px' }),
          h('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:8px' }, [
            recordCheck,
            document.createTextNode('生成时同步航标表与位置提示'),
          ]),
          h('div', { style: 'height:14px' }),
          h('div', { class: 'toolbar' }, [genBtn, recordBtn]),
          h('div', { style: 'height:8px' }),
          genLog,
        ]),
        h('div', { class: 'col' }, [
          h('h3', { textContent: '场景预览' }),
          h('div', { class: 'canvas-stage' }, [previewCanvas]),
          h('p', {
            class: 'muted',
            style: 'font-size:12px;margin-top:8px',
            textContent: '每场景 20 盏航标灯（覆盖单闪/联闪/长闪/快闪/互光/莫尔斯与红绿白黄四色）+ 5 个干扰源（路灯、移动船灯、倒影、常亮坏灯）。',
          }),
        ]),
      ]),
    ]),
  );
  setFooter('视频导入页');
}
