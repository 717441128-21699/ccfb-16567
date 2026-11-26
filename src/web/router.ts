/**
 * 极简哈希路由：四个页面 航标表 / 视频导入 / 跟踪 / 核查结果。
 */
export type Route = 'aids' | 'import' | 'track' | 'results';

const ROUTES: Route[] = ['aids', 'import', 'track', 'results'];

export function currentRoute(): Route {
  const hash = location.hash.replace('#/', '') as Route;
  return ROUTES.includes(hash) ? hash : 'aids';
}

export function navigate(route: Route): void {
  location.hash = `#/${route}`;
}

export function onRouteChange(cb: (route: Route) => void): () => void {
  const handler = (): void => cb(currentRoute());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
