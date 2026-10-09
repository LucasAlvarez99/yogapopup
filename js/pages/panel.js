import { knownCategories } from '../lib/catalog-fields.js';
import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { adminDeleteClass, adminListClasses, adminSyncVideo, adminUpdateClass } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { levelLabel, formatDate } from '../lib/format.js';
import { el, icon, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { openAuth } from '../ui/auth-modal.js';
import { openClassForm } from '../ui/class-form-modal.js';
import { showProductsAdmin } from '../ui/products-admin.js';
import { showOrdersAdmin } from '../ui/orders-admin.js';
import { paymentsEnabled } from '../lib/env.js';
import { showAgenda, showProfile, showTeachersAdmin } from '../ui/teacher-panel.js';
import { toast } from '../ui/toast.js';
import { emptyState, errorState, skeletonGrid } from '../ui/states.js';

/**
 * Panel de negocio (Fases 8-11): catálogo completo con filtros (publicadas/borradores/con error),
 * crear clase y subir su video, editar los datos de una clase ya creada, reintentar una subida
 * interrumpida, actualizar el estado del video a mano, publicar/despublicar y borrar.
 * El permiso real lo decide la base (RLS + privilegio por columna); esto solo ordena la interfaz.
 *
 * Fase 14: pestaña "Productos" (alta, edición, imagen, publicar/ocultar y borrado de la tienda),
 * en ui/products-admin.js. Cada pestaña se dibuja en `root`; `outer` guarda las pestañas y los avisos de acceso.
 *
 * Fases 28-30: pestañas de profesores. Gestión (admin/developer): "Profesores" (equipo docente). Cualquiera que dé clases
 * (rol profesor, o Manu siendo admin): "Mi agenda" y "Mi perfil". Un profesor NO ve Clases ni Productos.
 *
 * Pendiente para más adelante: borrado lógico (hoy adminDeleteClass borra físico, ver
 * docs/AUDITORIA-Y-PLAN.md punto 9), usuarios y entitlements.
 */
const outer = document.getElementById('panel');
const tabsHost = el('div');
const root = el('div', { id: 'panelContent' });
let activeTab = null; // 'classes' | 'products' | 'payments' | 'teachers' | 'agenda' | 'profile'
let classes = [];
let statusFilter = 'all'; // 'all' | 'published' | 'draft' | 'failed'

const VIDEO_STATUS_LABELS = {
  pending: 'Pendiente', uploading: 'Subiendo', processing: 'Procesando', ready: 'Lista', failed: 'Con error',
};
const VIDEO_STATUS_BADGE = {
  pending: 'text-bg-secondary', uploading: 'text-bg-info', processing: 'text-bg-info',
  ready: 'text-bg-success', failed: 'text-bg-danger',
};
const NEEDS_VIDEO = new Set(['pending', 'uploading', 'failed']);

function statusBadge(status) {
  return el('span', { class: `badge ${VIDEO_STATUS_BADGE[status] || 'text-bg-secondary'}` }, VIDEO_STATUS_LABELS[status] || status);
}

async function togglePublish(row, btn) {
  const next = !row.is_published;
  btn.disabled = true;
  try {
    const updated = await adminUpdateClass(row.id, { is_published: next });
    Object.assign(row, updated);
    toast(next ? 'Clase publicada.' : 'Clase despublicada.', { type: 'success' });
    renderTable();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
    btn.disabled = false;
  }
}

async function refreshStatus(row, btn) {
  btn.disabled = true;
  try {
    const { class: updated } = await adminSyncVideo(row.id);
    Object.assign(row, updated);
    renderTable();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
    btn.disabled = false;
  }
}

async function removeClass(row) {
  if (!confirm(`¿Eliminar "${row.title}"? Esto borra la clase y su video, y no se puede deshacer.`)) return;
  try {
    await adminDeleteClass(row.id);
    classes = classes.filter((c) => c.id !== row.id);
    toast('Clase eliminada.', { type: 'success' });
    renderTable();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
  }
}

async function editClass(row) {
  if (await openClassForm({ mode: 'edit', row, categories: knownCategories(classes) })) loadClasses();
}

async function retryUpload(row) {
  if (await openClassForm({ mode: 'retry', row })) loadClasses();
}

function classRow(row) {
  const canPublish = row.is_published || row.video_status === 'ready';
  const actions = [
    el('button', {
      type: 'button', class: 'btn btn-sm btn-outline-secondary', title: 'Editar datos de la clase',
      onclick: () => editClass(row),
    }, icon('pencil')),
    el('button', {
      type: 'button',
      class: `btn btn-sm ${row.is_published ? 'btn-outline-secondary' : 'btn-outline-brand'}`,
      disabled: !canPublish,
      title: canPublish ? '' : 'El video todavía no está listo.',
      onclick: (e) => togglePublish(row, e.currentTarget),
    }, row.is_published ? 'Despublicar' : 'Publicar'),
  ];
  if (NEEDS_VIDEO.has(row.video_status)) {
    actions.push(session.canUpload()
      ? el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-brand',
        onclick: () => retryUpload(row),
      }, row.video_status === 'failed' ? 'Reintentar video' : 'Subir video')
      : el('span', { class: 'text-muted small align-self-center', title: 'Subir videos lo hace el equipo técnico.' }, 'Falta el video'));
  }
  if (row.video_status === 'processing' || row.video_status === 'uploading') {
    actions.push(el('button', {
      type: 'button', class: 'btn btn-sm btn-outline-secondary', title: 'Consultar a R2 el estado actual',
      onclick: (e) => refreshStatus(row, e.currentTarget),
    }, icon('arrow-repeat')));
  }
  actions.push(el('button', {
    type: 'button', class: 'btn btn-sm btn-outline-danger', title: 'Eliminar',
    onclick: () => removeClass(row),
  }, icon('trash')));

  return el('tr', {},
    el('td', {}, el('strong', {}, row.title), row.category ? el('div', { class: 'text-muted small' }, row.category) : null),
    el('td', {}, levelLabel(row.level)),
    el('td', {}, statusBadge(row.video_status)),
    el('td', {}, el('span', { class: `badge ${row.is_published ? 'text-bg-success' : 'text-bg-secondary'}` }, row.is_published ? 'Publicada' : 'Sin publicar')),
    el('td', { class: 'text-muted small' }, formatDate(row.updated_at)),
    el('td', { class: 'text-end' }, el('div', { class: 'd-flex gap-1 justify-content-end flex-wrap' }, ...actions)));
}

function newClassButton() {
  // El admin no sube videos: en vez del botón, un aviso que explica quién lo hace (el servidor y la base lo impiden igual).
  if (!session.canUpload()) {
    return el('p', { class: 'text-muted small mb-3' }, icon('info-circle'),
      ' Podés editar, publicar, despublicar y eliminar clases. Subir videos nuevos lo hace el equipo técnico.');
  }
  return el('button', {
    type: 'button', class: 'btn btn-brand mb-3',
    onclick: async () => { if (await openClassForm({ mode: 'create', categories: knownCategories(classes) })) loadClasses(); },
  }, icon('plus-lg'), ' Nueva clase');
}

const FILTERS = [
  ['all', 'Todas', () => true],
  ['published', 'Publicadas', (c) => c.is_published],
  ['draft', 'Borradores', (c) => !c.is_published],
  ['failed', 'Con error', (c) => c.video_status === 'failed'],
];

function filterBar() {
  return el('div', { class: 'd-flex gap-2 mb-3 flex-wrap', role: 'group', 'aria-label': 'Filtrar clases' },
    ...FILTERS.map(([key, label]) => el('button', {
      type: 'button',
      class: `btn btn-sm ${statusFilter === key ? 'btn-brand' : 'btn-outline-secondary'}`,
      'aria-pressed': String(statusFilter === key),
      onclick: () => { statusFilter = key; renderTable(); },
    }, label)));
}

function renderTable() {
  if (activeTab !== 'classes') return; // el usuario ya cambió de pestaña: no pisar lo que está viendo
  const visible = classes.filter(FILTERS.find(([key]) => key === statusFilter)[2]);
  if (classes.length === 0) {
    return mount(root, newClassButton(), emptyState('Todavía no hay clases',
      session.canUpload() ? 'Creá la primera con el botón de arriba.' : 'Cuando el equipo técnico suba la primera, la vas a ver acá.'));
  }
  if (visible.length === 0) {
    return mount(root, newClassButton(), filterBar(), emptyState('No hay clases en este filtro', 'Probá con otro filtro de arriba.'));
  }
  const scrollHint = el('p', { class: 'table-scroll-hint', hidden: true }, icon('arrow-left-right'), ' Desliza para ver más');
  const wrap = el('div', { class: 'table-responsive' },
    el('table', { class: 'table align-middle' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Clase'), el('th', {}, 'Nivel'), el('th', {}, 'Video'), el('th', {}, 'Estado'),
        el('th', {}, 'Actualizada'), el('th', { class: 'text-end' }, ''))),
      el('tbody', {}, ...visible.map(classRow))));
  mount(root, newClassButton(), filterBar(), scrollHint, wrap);

  // Aviso de scroll horizontal SOLO si la tabla no entra completa; desaparece en cuanto se usa.
  const syncHint = () => { scrollHint.hidden = wrap.scrollWidth <= wrap.clientWidth + 1; };
  syncHint();
  window.addEventListener('resize', syncHint);
  wrap.addEventListener('scroll', () => { scrollHint.hidden = true; }, { once: true });
}

async function loadClasses() {
  if (activeTab !== 'classes') return;
  mount(root, skeletonGrid(4));
  try {
    classes = await adminListClasses();
  } catch (err) {
    if (activeTab !== 'classes') return;
    return mount(root, errorState(messageFor(err), loadClasses));
  }
  renderTable();
}

const ALL_TABS = [
  ['classes', 'Clases', () => session.isStaff()],
  ['products', 'Productos', () => session.isStaff()],
  // Solo con PayPal configurado (js/config.js > PAYPAL.CLIENT_ID): sin pagos no hay nada que gestionar.
  ['payments', 'Pagos', () => session.isStaff() && paymentsEnabled],
  ['teachers', 'Profesores', () => session.isStaff()],
  ['agenda', 'Mi agenda', () => session.isTeacher()],
  ['profile', 'Mi perfil', () => session.isTeacher()],
];
/** Pestañas que le corresponden a quien está mirando (solo ordena la interfaz: la base decide los permisos). */
const availableTabs = () => ALL_TABS.filter(([, , allowed]) => allowed());

function renderTabs() {
  mount(tabsHost, el('ul', { class: 'nav nav-tabs mb-4', role: 'tablist' },
    ...availableTabs().map(([key, label]) => el('li', { class: 'nav-item', role: 'presentation' },
      el('button', {
        type: 'button', role: 'tab', class: `nav-link${activeTab === key ? ' active' : ''}`,
        'aria-selected': String(activeTab === key),
        onclick: () => selectTab(key),
      }, label)))));
}

function loadActiveTab() {
  const tab = activeTab;
  const isCurrent = () => activeTab === tab;
  const { teacher } = session.getState();
  if (tab === 'products') showProductsAdmin(root, { isCurrent });
  else if (tab === 'payments') showOrdersAdmin(root, { isCurrent });
  else if (tab === 'teachers') showTeachersAdmin(root, { isCurrent });
  else if (tab === 'agenda') showAgenda(root, { teacherId: teacher.profile_id, isCurrent });
  else if (tab === 'profile') showProfile(root, { teacher, isCurrent });
  else loadClasses();
}

function selectTab(key) {
  if (key === activeTab) return;
  activeTab = key;
  renderTabs();
  loadActiveTab();
}

function render() {
  if (!supabase) return mount(outer, emptyState('Panel no disponible', 'Falta configurar la conexión con Supabase (js/config.js).'));
  const { user } = session.getState();
  if (!user) {
    return mount(outer, emptyState('Iniciá sesión para ver el panel', '',
      el('button', { type: 'button', class: 'btn btn-brand', onclick: () => openAuth() }, 'Iniciar sesión')));
  }
  if (!session.canUsePanel()) {
    return mount(outer, emptyState('Acceso restringido', 'Esta sección es solo para el equipo de gestión y los profesores.'));
  }
  // Primera pestaña disponible si la actual no le corresponde (p. ej. un profesor nunca ve "Clases").
  if (!availableTabs().some(([key]) => key === activeTab)) activeTab = availableTabs()[0][0];
  mount(outer, tabsHost, root);
  renderTabs();
  loadActiveTab();
}

await boot('panel');
session.onChange((_s, event) => { if (event !== 'SESSION_REFRESHED') render(); });
render();
