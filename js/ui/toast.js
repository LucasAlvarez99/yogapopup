import { el, icon } from '../lib/dom.js';

let host;
function container() {
  host ??= document.body.appendChild(el('div', { class: 'yp-toasts', 'aria-live': 'polite', 'aria-atomic': 'false' }));
  return host;
}

/** Aviso breve. type: 'success' | 'error' | 'info' */
export function toast(message, { type = 'info', ms = 4500 } = {}) {
  const ico = type === 'success' ? 'check-circle-fill' : type === 'error' ? 'exclamation-circle-fill' : 'info-circle-fill';
  const node = el('div', { class: `yp-toast yp-toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(ico), el('span', {}, message),
    el('button', { type: 'button', class: 'yp-toast-x', 'aria-label': 'Cerrar', onclick: () => node.remove() }, icon('x-lg')));
  container().append(node);
  if (ms > 0) setTimeout(() => node.remove(), ms);
  return node;
}
