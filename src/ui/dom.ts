/** 极简 DOM 构建工具 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], 'style' | 'children'>> & {
    class?: string;
    style?: string | Partial<CSSStyleDeclaration>;
  } = {},
  children: (Node | string | null | false | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else Object.assign(el.style, v);
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else {
      (el as Record<string, unknown>)[k] = v;
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

export function mount(root: HTMLElement, node: Node): void {
  clear(root);
  root.append(node);
}

export function setFooter(status: string, meta = ''): void {
  const s = document.getElementById('footer-status');
  const m = document.getElementById('footer-meta');
  if (s) s.textContent = status;
  if (m) m.textContent = meta;
}
