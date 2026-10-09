import { listMyProgress } from '../lib/api.js';
import { groupProgress } from '../lib/account-view.js';
import { formatDate } from '../lib/format.js';
import { messageFor } from '../lib/errors.js';
import { el, mount } from '../lib/dom.js';

function row(item) {
  return el('li', { class: 'acc-row' },
    el('div', { class: 'acc-row-main' },
      el('a', { class: 'acc-row-title', href: `clase.html?id=${encodeURIComponent(item.classId)}`, translate: 'no' }, item.title),
      el('div', { class: 'progress acc-progress mt-1', role: 'progressbar', 'aria-valuenow': item.percent, 'aria-valuemin': 0, 'aria-valuemax': 100 },
        el('div', { class: 'progress-bar bg-brand', style: `width:${item.percent}%` })),
      el('div', { class: 'acc-sub small text-muted' }, `${item.percent}%`, item.lastWatchedAt ? ` · ${formatDate(item.lastWatchedAt)}` : '')),
    el('a', { class: 'btn btn-sm btn-outline-brand', href: `clase.html?id=${encodeURIComponent(item.classId)}` }, item.resumeLabel));
}

/** "Mi progreso" (Fase 23): lo que sigue en curso, con "continuar", y lo ya completado. */
export function progressCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card', id: 'accProgress' }, el('h2', { class: 'yp-block-title' }, 'Mi progreso'), body);
  (async () => {
    let groups;
    try { groups = groupProgress(await listMyProgress()); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    body.setAttribute('aria-busy', 'false');
    if (groups.inProgress.length === 0 && groups.completed.length === 0) {
      return mount(body, el('p', { class: 'text-muted' }, 'Todavía no empezaste ninguna clase.'),
        el('a', { class: 'btn btn-outline-brand btn-sm', href: 'videoteca.html' }, 'Ir a la videoteca'));
    }
    mount(body,
      groups.inProgress.length ? el('h3', { class: 'h6 mb-1' }, 'En progreso') : null,
      groups.inProgress.length ? el('ul', { class: 'acc-list', id: 'accInProgress' }, ...groups.inProgress.map(row)) : null,
      groups.completed.length ? el('h3', { class: 'h6 mt-3 mb-1' }, 'Completadas') : null,
      groups.completed.length ? el('ul', { class: 'acc-list', id: 'accCompleted' }, ...groups.completed.map(row)) : null);
  })();
  return card;
}
