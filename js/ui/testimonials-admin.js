import { adminDeleteTestimonial, adminListTestimonials, adminSetTestimonialStatus } from '../lib/api.js';
import { countByStatus, initials, moderationActions, MODERATION_FILTERS, sortForModeration, STATUS_LABEL, STATUS_TONE } from '../lib/testimonials.js';
import { messageFor } from '../lib/errors.js';
import { formatDate } from '../lib/format.js';
import { el, icon, mount } from '../lib/dom.js';
import { toast } from './toast.js';
import { emptyState, errorState, skeletonGrid } from './states.js';

/**
 * Pestaña "Comentarios" del panel (Fase 27): aprobar, ocultar y borrar. Un comentario no se ve en público hasta que se
 * aprueba. Cada cambio de estado y cada borrado queda en el historial de auditoría (lo hace la base).
 */
let root = null;
let isCurrent = () => true;
let rows = [];
let filter = 'pending';

const EMPTY = {
  pending: ['No hay comentarios por revisar', 'Cuando alguien escriba uno, va a aparecer acá.'],
  approved: ['Todavía no aprobaste ninguno', 'Los aprobados se ven en la home, en "Lo que dice nuestra comunidad".'],
  hidden: ['No hay comentarios ocultos', 'Lo que ocultes se guarda acá y no se ve en la página.'],
};

async function act(button, task, okMessage) {
  button.disabled = true;
  try {
    await task();
    toast(okMessage, { type: 'success' });
    if (isCurrent()) await load();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
    button.disabled = false;
  }
}

function card(t) {
  const actions = moderationActions(t.status).map((a) => (a === 'approve'
    ? el('button', { type: 'button', class: 'btn btn-sm btn-brand', 'data-action': 'approve', onclick: (e) => act(e.currentTarget, () => adminSetTestimonialStatus(t.id, 'approved'), 'Comentario aprobado: ya se ve en la página.') }, icon('check-lg'), ' Aprobar')
    : el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', 'data-action': 'hide', onclick: (e) => act(e.currentTarget, () => adminSetTestimonialStatus(t.id, 'hidden'), 'Comentario oculto.') }, icon('eye-slash'), ' Ocultar')));
  actions.push(el('button', {
    type: 'button', class: 'btn btn-sm btn-outline-danger', 'data-action': 'delete',
    onclick: (e) => {
      if (!confirm(`¿Borrar el comentario de ${t.author_name}? No se puede deshacer.`)) return;
      act(e.currentTarget, () => adminDeleteTestimonial(t.id), 'Comentario borrado.');
    },
  }, icon('trash'), ' Borrar'));
  return el('li', { class: 'acc-row align-items-start', 'data-testimonial-id': t.id },
    el('div', { class: 'acc-row-main' },
      el('div', { class: 'd-flex align-items-center gap-2 mb-1' },
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(t.author_name)),
        el('strong', { translate: 'no' }, t.author_name),
        el('span', { class: `badge text-bg-${STATUS_TONE[t.status]}` }, STATUS_LABEL[t.status]),
        t.rating ? el('span', { class: 'small text-muted' }, `${t.rating}/5`) : null,
        el('span', { class: 'small text-muted' }, formatDate(t.created_at))),
      // Texto de una persona: siempre como texto.
      el('p', { class: 'mb-0', translate: 'no' }, t.body)),
    el('div', { class: 'd-flex gap-1 flex-wrap justify-content-end' }, ...actions));
}

function view() {
  const counts = countByStatus(rows);
  const bar = el('div', { class: 'd-flex gap-2 mb-3 flex-wrap', role: 'group', 'aria-label': 'Filtrar comentarios' },
    ...MODERATION_FILTERS.map(([key, label]) => el('button', {
      type: 'button', 'data-filter': key,
      class: `btn btn-sm ${filter === key ? 'btn-brand' : 'btn-outline-secondary'}`, 'aria-pressed': String(filter === key),
      onclick: () => { filter = key; mount(root, view()); },
    }, `${label} (${counts[key]})`)));
  const shown = sortForModeration(rows, filter);
  return el('div', {}, bar, shown.length === 0
    ? emptyState(...EMPTY[filter])
    : el('ul', { class: 'acc-list', id: 'tmList' }, ...shown.map(card)));
}

async function load() {
  if (!root || !isCurrent()) return;
  mount(root, skeletonGrid(3));
  try { rows = await adminListTestimonials(); }
  catch (err) { if (isCurrent()) mount(root, errorState(messageFor(err), load)); return; }
  if (isCurrent()) mount(root, view());
}

export function showTestimonialsAdmin(target, opts = {}) {
  root = target;
  isCurrent = opts.isCurrent ?? (() => true);
  filter = 'pending';
  load();
}
