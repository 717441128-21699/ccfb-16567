/**
 * 核查结果页：航标表逐条核对结果，异常项高亮并列出不符明细，
 * 顶部给出灯质/周期/颜色准确率与故障报警统计。
 */
import { charName, colorName } from '../../core/audit';
import { navigate } from '../router';
import { getState, subscribe } from '../store';

export function renderResultsPage(): HTMLElement {
  const el = document.createElement('div');
  const draw = (): void => {
    const s = getState();
    const out = s.output;
    if (!out) {
      el.innerHTML = `<div class="panel"><h2>核查结果</h2>
        <p class="muted">尚未完成分析。</p>
        <button class="primary" id="go">去跟踪页启动分析</button></div>`;
      el.querySelector<HTMLButtonElement>('#go')!.addEventListener('click', () => navigate('track'));
      return;
    }

    const aidResults = out.audits.filter((a) => !a.aid.id.startsWith('('));
    const pass = aidResults.filter((a) => a.pass).length;
    const fail = aidResults.length - pass;
    const charOk = aidResults.filter((a) => !a.mismatches.some((m) => m.field === 'characteristic' || m.field === 'rhythm')).length;
    const colorOk = aidResults.filter((a) => !a.mismatches.some((m) => m.field === 'color')).length;
    const periodOk = aidResults.filter((a) => !a.mismatches.some((m) => m.field === 'period')).length;

    el.innerHTML = `
      <div class="panel">
        <div class="row">
          <h2 style="margin:0; flex:1">核查结果</h2>
          <button class="ghost" id="back">返回跟踪页</button>
        </div>
        <div class="stat-grid" style="margin-top:14px">
          <div class="stat"><span class="num" style="color:var(--ok)">${pass}/${aidResults.length}</span><span class="label">核查通过</span></div>
          <div class="stat"><span class="num" style="color:var(--bad)">${fail}</span><span class="label">异常航标</span></div>
          <div class="stat"><span class="num">${charOk}/${aidResults.length}</span><span class="label">灯质符合 · 颜色${colorOk} · 周期${periodOk}</span></div>
          <div class="stat"><span class="num">${(out.analysisTimeMs / 1000).toFixed(1)}s</span><span class="label">分析耗时（视频 ${out.videoTimeSec.toFixed(0)}s）</span></div>
        </div>
      </div>

      <div class="panel">
        <h2>逐条核对</h2>
        <div class="scroll">
          <table>
            <thead><tr><th>编号</th><th>名称</th><th>规定</th><th>实测</th><th>周期(规定/实测)</th><th>灯色</th><th>结论</th></tr></thead>
            <tbody>
              ${aidResults.map((a) => {
                const m = a.measured;
                return `<tr data-aid="${a.aid.id}" style="${a.pass ? '' : 'background:rgba(255,90,82,0.05)'}">
                  <td><strong>${a.aid.id}</strong></td>
                  <td>${a.aid.name}</td>
                  <td>${charName(a.aid.characteristic)}${a.aid.groupSize ? `(${a.aid.groupSize})` : ''}</td>
                  <td>${m ? charName(m.characteristic) + (m.groupSize ? `(${m.groupSize})` : '') : '—'}</td>
                  <td>${a.aid.periodSec ? `${a.aid.periodSec}s / ${m?.periodSec?.toFixed(2) ?? '—'}s` : '—'}</td>
                  <td>${a.aid.colors.map((c) => `<span class="dot ${c}"></span>${colorName(c)}`).join(' ')}</td>
                  <td>${a.pass ? '<span class="badge ok">一致</span>' : '<span class="badge bad">异常</span>'}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel" id="detail-panel"><h2>异常明细</h2>
        ${aidResults.filter((a) => !a.pass).length === 0
          ? '<p class="muted">全部航标灯质符合规定。</p>'
          : aidResults.filter((a) => !a.pass).map((a) => `
            <div style="margin-bottom:14px">
              <strong>${a.aid.id} · ${a.aid.name}</strong>
              ${a.mismatches.map((mm) => `<div class="mismatch-item"><span class="field">[${mm.field}]</span> ${mm.detail}</div>`).join('')}
            </div>`).join('')}
      </div>

      ${out.audits.some((a) => a.aid.id.startsWith('(')) ? `
      <div class="panel">
        <h2>未匹配灯点（疑似干扰/新增航标）</h2>
        ${out.audits.filter((a) => a.aid.id.startsWith('(')).map((a) => `
          <div class="row" style="padding:6px 0">
            <span class="small">轨迹 #${a.trackId} · ${a.aid.name}</span>
            <span class="small muted">实测 ${a.measured ? charName(a.measured.characteristic) : '—'} / ${a.measured?.colors.map(colorName).join('+') ?? '—'}</span>
          </div>`).join('')}
      </div>` : ''}`;

    el.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => navigate('track'));
  };
  subscribe(draw);
  draw();
  return el;
}
