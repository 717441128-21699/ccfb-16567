/**
 * 应用入口：挂载导航与四个页面，按哈希路由切换。
 */
import './styles.css';
import { renderAidsPage } from './pages/aidsPage';
import { renderImportPage } from './pages/importPage';
import { renderResultsPage } from './pages/resultsPage';
import { renderTrackPage } from './pages/trackPage';
import { currentRoute, navigate, onRouteChange, type Route } from './router';

const NAV: { route: Route; label: string }[] = [
  { route: 'aids', label: '航标表' },
  { route: 'import', label: '视频导入' },
  { route: 'track', label: '灯点跟踪' },
  { route: 'results', label: '核查结果' },
];

function mount(route: Route): void {
  const main = document.querySelector<HTMLElement>('#page')!;
  main.innerHTML = '';
  const page = route === 'aids' ? renderAidsPage()
    : route === 'import' ? renderImportPage()
    : route === 'track' ? renderTrackPage()
    : renderResultsPage();
  main.appendChild(page);
  document.querySelectorAll<HTMLButtonElement>('.nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route);
  });
}

function renderShell(): void {
  const header = document.querySelector<HTMLElement>('.app-header')!;
  const nav = header.querySelector<HTMLElement>('.nav')!;
  nav.innerHTML = NAV.map((n) => `<button data-route="${n.route}">${n.label}</button>`).join('');
  nav.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.route as Route));
  });
}

renderShell();
mount(currentRoute());
onRouteChange(mount);
