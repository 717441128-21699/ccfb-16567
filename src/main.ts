import './styles.css';
import { h, mount } from './ui/dom';
import { store, type PageId } from './state/store';
import { renderBeaconPage } from './ui/pages/beaconPage';
import { renderImportPage } from './ui/pages/importPage';
import { renderTrackingPage } from './ui/pages/trackingPage';
import { renderResultsPage } from './ui/pages/resultsPage';

const PAGES: { id: PageId; label: string; render: (root: HTMLElement) => void }[] = [
  { id: 'beacons', label: '航标表', render: renderBeaconPage },
  { id: 'import', label: '视频导入', render: renderImportPage },
  { id: 'tracking', label: '灯点跟踪', render: renderTrackingPage },
  { id: 'results', label: '核查结果', render: renderResultsPage },
];

const nav = document.getElementById('step-nav')!;
const root = document.getElementById('page-root')!;

function renderNav(): void {
  nav.replaceChildren();
  const current = store.getState().page;
  PAGES.forEach((p, i) => {
    const btn = h('button', {
      class: `step-btn${p.id === current ? ' active' : ''}`,
      onclick: () => store.setPage(p.id),
    }, [
      h('span', { class: 'num', textContent: String(i + 1) }),
      document.createTextNode(p.label),
    ]);
    nav.append(btn);
  });
}

function renderPage(): void {
  const current = store.getState().page;
  const page = PAGES.find((p) => p.id === current)!;
  mount(root, document.createElement('div'));
  root.replaceChildren();
  page.render(root);
  renderNav();
  window.scrollTo(0, 0);
}

store.subscribe(() => renderPage());
renderPage();
