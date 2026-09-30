import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { getMyProgressMap, listContinueWatching, listPublishedClasses } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { LEVEL_LABELS } from '../lib/format.js';
import { el, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { classCard } from '../components/class-card.js';
import { emptyState, errorState, skeletonGrid } from '../ui/states.js';
import { openAuth } from '../ui/auth-modal.js';

/** Videoteca: catálogo real, filtros, "Continuar viendo" y progreso por clase. */
const filters = { q: '', category: '', level: '' };
let classes = [];
let progress = {};

const gridBox = document.getElementById('catalogGrid');
const filtersBox = document.getElementById('catalogFilters');
const continueBox = document.getElementById('continueBlock');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function visible() {
  const q = norm(filters.q);
  return classes.filter((c) =>
    (!filters.category || c.category === filters.category) &&
    (!filters.level || c.level === filters.level) &&
    (!q || norm([c.title, c.description, c.category].filter(Boolean).join(' ')).includes(q)));
}

function renderFilters() {
  const cats = [...new Set(classes.map((c) => c.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const chip = (label, value) => el('button', {
    type: 'button', class: 'yp-chip', 'aria-pressed': String(filters.category === value),
    onclick: () => { filters.category = value; renderFilters(); renderGrid(); },
  }, label);
  mount(filtersBox,
    el('input', { type: 'search', class: 'form-control', placeholder: 'Buscar clases…', 'aria-label': 'Buscar clases', value: filters.q,
      oninput: (e) => { filters.q = e.target.value; renderGrid(); } }),
    el('select', { class: 'form-select', 'aria-label': 'Nivel', onchange: (e) => { filters.level = e.target.value; renderGrid(); } },
      el('option', { value: '' }, 'Todos los niveles'),
      ...Object.entries(LEVEL_LABELS).filter(([k]) => k !== 'todos').map(([k, v]) => el('option', { value: k, selected: filters.level === k }, v))),
    cats.length ? el('div', { class: 'yp-chips', role: 'group', 'aria-label': 'Categorías' }, chip('Todas', ''), ...cats.map((c) => chip(c, c))) : null);
  filtersBox.hidden = classes.length === 0;
}

function renderGrid() {
  const list = visible();
  if (list.length === 0) {
    return mount(gridBox, classes.length === 0
      ? emptyState('Todavía no hay clases publicadas', 'Estamos preparando la videoteca. Vuelve pronto.')
      : emptyState('No encontramos clases con esos filtros', 'Prueba con otra búsqueda o categoría.'));
  }
  mount(gridBox, el('div', { class: 'row g-4' }, ...list.map((c) => classCard(c, { progress: progress[c.id] }))));
}

async function renderContinue() {
  continueBox.hidden = true;
  if (!session.isLoggedIn()) return;
  try {
    const items = await listContinueWatching(3);
    if (items.length === 0) return;
    mount(continueBox, el('h2', { class: 'yp-block-title' }, 'Continuar viendo'),
      el('div', { class: 'row g-4 mb-5' }, ...items.map((r) => classCard(r.classes, { progress: r, cont: true }))));
    continueBox.hidden = false;
  } catch { /* la sección es opcional: si falla, simplemente no se muestra */ }
}

async function loadProgress() {
  progress = {};
  if (session.isLoggedIn()) {
    try { progress = await getMyProgressMap(); } catch { /* sin barras de progreso, pero el catálogo sigue */ }
  }
  renderGrid();
  await renderContinue();
}

async function load() {
  mount(gridBox, skeletonGrid(6));
  filtersBox.hidden = true;
  if (!supabase) return mount(gridBox, emptyState('Videoteca en preparación', 'Falta configurar la conexión con Supabase (js/config.js).'));
  try {
    classes = await listPublishedClasses();
  } catch (err) {
    return mount(gridBox, errorState(messageFor(err), load));
  }
  renderFilters();
  await loadProgress();
}

await boot('videoteca');
session.onChange((_s, event) => { if (event !== 'INITIAL_SESSION' && classes.length) loadProgress(); });
document.getElementById('loginCta')?.addEventListener('click', () => openAuth());
await load();
