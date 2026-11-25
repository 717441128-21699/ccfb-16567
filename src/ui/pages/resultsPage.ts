/**
 * 核查结果页：汇总统计 + 逐座航标的标称/实测比对，
 * 不一致项红标，未跟踪到的黄标，支持导出 JSON 报告。
 */
import { COLOR_LABEL, describeLight } from '../../core/lightModel';
import { h, setFooter } from '../dom';
import { store } from '../../state/store';

export function renderResultsPage(root: HTMLElement): void {
  const state = store.getState();

  // 进入页面时（重新）构建报告
  if (state.analyses.length) {
    store.rebuildReport();
  }
  const report = store.getState().report;

  if (!report) {
    root.append(h('div', { class: 'card' }, [
      h('h2', { textContent: '核查结果' }),
      h('p', { class: 'muted', textContent: '尚无分析结果。请先在「灯点跟踪」页完成逐帧分析。' }),
      h('button', { textContent: '前往灯点跟踪', onclick: () => store.setPage('tracking') }),
    ]));
    setFooter('核查结果页 · 无数据');
    return;
  }

  const theReport = report;
  const pass = theReport.items.filter((i) => i.verdict === 'pass').length;
  const fail = theReport.items.filter((i) => i.verdict === 'fail').length;
  const unmatched = theReport.items.filter((i) => i.verdict === 'unmatched').length;

  const exportBtn = h('button', {
    class: 'secondary',
    textContent: '导出核查报告(JSON)',
    onclick: () => {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `核查报告-${theReport.videoName.replace(/\.[^.]+$/, '')}.json` });
      a.click();
      URL.revokeObjectURL(a.href);
    },
  });

  const filterSelect = h('select', {
    onchange: () => renderTable(filterSelect.value),
  }, [
    h('option', { value: 'all', textContent: '全部航标' }),
    h('option', { value: 'fail', textContent: '仅不一致' }),
    h('option', { value: 'unmatched', textContent: '仅未跟踪' }),
    h('option', { value: 'pass', textContent: '仅合格' }),
  ]) as HTMLSelectElement;

  const tableBody = h('tbody', { id: 'result-tbody' });

  function renderTable(filter: string): void {
    tableBody.replaceChildren();
    const items = filter === 'all' ? theReport.items : theReport.items.filter((i) => i.verdict === filter);
    for (const item of items) {
      const { beacon, analysis, verdict, mismatches } = item;
      const verdictBadge = verdict === 'pass'
        ? h('span', { class: 'badge pass', textContent: '合格' })
        : verdict === 'fail'
          ? h('span', { class: 'badge fail', textContent: '不一致' })
          : h('span', { class: 'badge unmatched', textContent: '未跟踪' });
      tableBody.append(h('tr', {}, [
        h('td', { class: 'mono', textContent: beacon.id }),
        h('td', { textContent: beacon.name }),
        h('td', {}, [verdictBadge]),
        h('td', { class: 'muted', textContent: describeLight(beacon.nominal) }),
        h('td', {
          textContent: analysis ? describeLight(analysis.measured) : '—',
          style: verdict === 'fail' ? 'color:#fca5a5' : '',
        }),
        h('td', {}, [
          h('span', { class: `dot ${beacon.nominal.color}` }),
          document.createTextNode(COLOR_LABEL[beacon.nominal.color]),
        ]),
        h('td', {
          textContent: analysis ? COLOR_LABEL[analysis.measured.color] : '—',
          style: analysis && analysis.measured.color !== beacon.nominal.color ? 'color:#fca5a5' : '',
        }),
        h('td', {}, [mismatches.length
          ? h('ul', { class: 'mismatch-list' }, mismatches.map((m) => h('li', { textContent: m })))
          : h('span', { class: 'muted', textContent: '—' })]),
      ]));
    }
  }

  renderTable('all');

  root.append(
    h('div', { class: 'card' }, [
      h('h2', { textContent: '核查结果汇总' }),
      h('div', { class: 'stat-grid' }, [
        bigStat('航标总数', String(theReport.items.length), 'var(--text)'),
        bigStat('合格', String(pass), 'var(--ok)'),
        bigStat('不一致', String(fail), 'var(--bad)'),
        bigStat('未跟踪', String(unmatched), 'var(--warn)'),
        bigStat('轨迹总数', String(theReport.totalTracks), 'var(--accent)'),
        bigStat('疑似干扰', String(theReport.distractorTracks), 'var(--muted)'),
      ]),
      h('div', { style: 'height:12px' }),
      h('p', {
        class: 'muted',
        style: 'font-size:12px',
        textContent: `视频：${theReport.videoName} · 时长 ${theReport.durationSec.toFixed(1)}s · 采样 ${theReport.sampleFps.toFixed(1)} fps · 生成于 ${new Date(theReport.createdAt).toLocaleString('zh-CN')}`,
      }),
      h('div', { class: 'toolbar' }, [exportBtn, h('span', { class: 'spacer' }), filterSelect]),
    ]),
    h('div', { class: 'card' }, [
      h('h2', { textContent: '逐标比对明细' }),
      h('div', { class: 'table-wrap' }, [
        h('table', {}, [
          h('thead', {}, [
            h('tr', {}, [
              h('th', { textContent: '编号' }),
              h('th', { textContent: '名称' }),
              h('th', { textContent: '结论' }),
              h('th', { textContent: '标称灯质' }),
              h('th', { textContent: '实测灯质' }),
              h('th', { textContent: '标称色' }),
              h('th', { textContent: '实测色' }),
              h('th', { textContent: '不一致明细' }),
            ]),
          ]),
          tableBody,
        ]),
      ]),
    ]),
  );
  setFooter('核查结果页', `合格 ${pass} · 不一致 ${fail} · 未跟踪 ${unmatched}`);
}

function bigStat(key: string, value: string, color: string): HTMLElement {
  return h('div', { class: 'stat' }, [
    h('div', { class: 'v', style: `color:${color}`, textContent: value }),
    h('div', { class: 'k', textContent: key }),
  ]);
}
