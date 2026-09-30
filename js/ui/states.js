import { el, icon } from '../lib/dom.js';

/** Bloques de estado reutilizables: vacío, error con reintento y esqueleto de carga. */
export function emptyState(title, text, action) {
  return el('div', { class: 'yp-state', role: 'status' }, icon('flower1'), el('h2', {}, title), text ? el('p', {}, text) : null, action);
}

export function errorState(message, onRetry) {
  return el('div', { class: 'yp-state', role: 'alert' }, icon('exclamation-triangle'), el('h2', {}, 'No pudimos cargar esto'),
    el('p', {}, message), onRetry ? el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: onRetry }, icon('arrow-repeat'), ' Reintentar') : null);
}

export function skeletonGrid(n = 6) {
  const row = el('div', { class: 'row g-4', 'aria-busy': 'true', 'aria-label': 'Cargando clases' });
  for (let i = 0; i < n; i++) row.append(el('div', { class: 'col-lg-4 col-md-6' }, el('div', { class: 'yp-skeleton' })));
  return row;
}
