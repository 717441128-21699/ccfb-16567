/**
 * 航标表页：展示/导入/导出航标表，一键生成测试航标表。
 */
import { COLOR_LABEL, describeLight } from '../../core/lightModel';
import { buildAllScenarios } from '../../core/scenarios';
import type { Beacon } from '../../core/types';
import { h, mount, setFooter } from '../dom';
import { store } from '../../state/store';

export function renderBeaconPage(root: HTMLElement): void {
  const state = store.getState();

  const tableWrap = h('div', { class: 'table-wrap' }, [
    h('table', {}, [
      h('thead', {}, [
        h('tr', {}, [
          h('th', { textContent: '编号' }),
          h('th', { textContent: '名称' }),
          h('th', { textContent: '位置' }),
          h('th', { textContent: '灯质种类' }),
          h('th', { textContent: '周期(s)' }),
          h('th', { textContent: '明时长(s)' }),
          h('th', { textContent: '灯色' }),
          h('th', { textContent: '灯质描述' }),
          h('th', { textContent: '备注' }),
        ]),
      ]),
      h('tbody', { id: 'beacon-tbody' }),
    ]),
  ]);

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    style: 'display:none',
    onchange: onImportFile,
  });

  const page = h('div', {}, [
    h('div', { class: 'card' }, [
      h('h2', { textContent: '航标表' }),
      h('div', { class: 'toolbar' }, [
        h('button', {
          class: 'secondary',
          textContent: '导入航标表(JSON)',
          onclick: () => fileInput.click(),
        }),
        h('button', {
          class: 'secondary',
          textContent: '导出当前航标表',
          onclick: onExport,
        }),
        h('button', {
          textContent: '生成测试航标表(20 座灯)',
          onclick: onGenerate,
        }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', id: 'beacon-count', textContent: `当前 ${state.beacons.length} 座航标` }),
        fileInput,
      ]),
      tableWrap,
    ]),
    h('div', { class: 'card' }, [
      h('h3', { textContent: '航标表 JSON 格式示例' }),
      h('pre', {
        style: 'background:var(--panel-2);padding:12px;border-radius:8px;overflow:auto;font-size:12px',
        textContent: JSON.stringify([{
          id: 'B001',
          name: '3 号灯浮',
          location: '主航道北侧',
          nominal: {
            kind: 'group', groupCount: 2, periodSec: 10,
            onSec: 0.5, color: 'red',
          },
        }], null, 2),
      }),
    ]),
  ]);

  mount(root, page);
  renderRows();
  setFooter('航标表页', `共 ${state.beacons.length} 座航标`);

  function renderRows(): void {
    const tbody = document.getElementById('beacon-tbody')!;
    tbody.replaceChildren();
    const s = store.getState();
    for (const b of s.beacons) {
      tbody.append(h('tr', {}, [
        h('td', { class: 'mono', textContent: b.id }),
        h('td', { textContent: b.name }),
        h('td', { textContent: b.location }),
        h('td', {}, [h('span', { class: 'badge kind', textContent: describeLight(b.nominal).split(' ')[0]! })]),
        h('td', { class: 'mono', textContent: b.nominal.periodSec.toFixed(1) }),
        h('td', { class: 'mono', textContent: b.nominal.onSec.toFixed(2) }),
        h('td', {}, [
          h('span', {}, [
            h('span', { class: `dot ${b.nominal.color}` }),
            document.createTextNode(COLOR_LABEL[b.nominal.color]),
          ]),
        ]),
        h('td', { class: 'muted', textContent: describeLight(b.nominal) }),
        h('td', { class: 'muted', textContent: b.note ?? '—' }),
      ]));
    }
    const count = document.getElementById('beacon-count');
    if (count) count.textContent = `当前 ${s.beacons.length} 座航标`;
  }

  function onGenerate(): void {
    const built = buildAllScenarios(60)[0]!;
    store.setBeacons(built.beacons, built.hints);
    renderRows();
    setFooter('已生成测试航标表', `${built.beacons.length} 座航标，含 2 座故障注入灯`);
  }

  function onExport(): void {
    const s = store.getState();
    const blob = new Blob([JSON.stringify(s.beacons, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: '航标表.json' });
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImportFile(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as Beacon[];
      if (!Array.isArray(data) || !data.every((d) => d.id && d.nominal)) {
        throw new Error('缺少 id 或 nominal 字段');
      }
      store.setBeacons(data, {});
      renderRows();
      setFooter('航标表导入成功', `${data.length} 座航标`);
    } catch (err) {
      alert(`航标表导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
    input.value = '';
  }
}
