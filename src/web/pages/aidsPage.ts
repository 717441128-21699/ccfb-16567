/**
 * 航标表页：查看/编辑 20 座航标的规定灯质、周期、组闪、灯色。
 */
import { charName, colorName } from '../../core/audit';
import type { LightCharacteristic, LightColor } from '../../core/types';
import { getState, setState, subscribe } from '../store';

const CHARS: LightCharacteristic[] = ['fixed', 'single-flash', 'group-flash', 'long-flash', 'quick', 'alternating', 'morse'];
const COLORS: LightColor[] = ['red', 'green', 'white', 'yellow'];

export function renderAidsPage(): HTMLElement {
  const el = document.createElement('div');
  const draw = (): void => {
    const { aids } = getState();
    el.innerHTML = `
      <div class="panel">
        <h2>航标表（规定灯质台账）</h2>
        <p class="muted small">共 ${aids.length} 座航标。核查时以本表为基准，实测灯质/周期/灯色任一不符即标记异常。</p>
        <div class="scroll">
          <table>
            <thead><tr>
              <th>编号</th><th>名称</th><th>灯质</th><th>周期(s)</th><th>组闪</th><th>灯色</th><th>亮时(s)</th>
            </tr></thead>
            <tbody>
              ${aids.map((a, i) => `
                <tr>
                  <td><strong>${a.id}</strong></td>
                  <td>${a.name}</td>
                  <td>
                    <select data-i="${i}" data-f="characteristic">
                      ${CHARS.map((c) => `<option value="${c}" ${c === a.characteristic ? 'selected' : ''}>${charName(c)}</option>`).join('')}
                    </select>
                  </td>
                  <td><input type="number" style="width:70px" step="0.5" min="0" data-i="${i}" data-f="periodSec" value="${a.periodSec}"></td>
                  <td><input type="number" style="width:60px" min="0" data-i="${i}" data-f="groupSize" value="${a.groupSize ?? ''}" placeholder="-"></td>
                  <td>
                    <select data-i="${i}" data-f="color">
                      ${COLORS.map((c) => `<option value="${c}" ${c === a.colors[0] ? 'selected' : ''}>${colorName(c)}</option>`).join('')}
                    </select>
                  </td>
                  <td>${a.onDurationSec?.toFixed(1) ?? '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    el.querySelectorAll<HTMLSelectElement | HTMLInputElement>('select, input').forEach((input) => {
      input.addEventListener('change', () => {
        const i = Number(input.dataset.i);
        const f = input.dataset.f as string;
        const next = structuredClone(getState().aids);
        const aid = next[i]!;
        if (f === 'characteristic') aid.characteristic = input.value as LightCharacteristic;
        else if (f === 'periodSec') aid.periodSec = Number(input.value) || 0;
        else if (f === 'groupSize') aid.groupSize = input.value === '' ? null : Number(input.value);
        else if (f === 'color') aid.colors = [input.value as LightColor];
        setState({ aids: next });
      });
    });
  };
  subscribe(draw);
  draw();
  return el;
}
