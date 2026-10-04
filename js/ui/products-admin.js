import { knownCategories } from '../lib/catalog-fields.js';
import { adminDeleteProduct, adminListProducts, adminUpdateProduct, deleteProductImageByUrl } from '../lib/api.js';
import { messageFor } from '../lib/errors.js';
import { formatDate, formatPrice } from '../lib/format.js';
import { el, icon, mount } from '../lib/dom.js';
import { openProductForm } from './product-form-modal.js';
import { toast } from './toast.js';
import { emptyState, errorState, skeletonGrid } from './states.js';

/**
 * Fase 14: pestaña "Productos" del panel de negocio. Lista todos los productos (activos e inactivos),
 * los filtra, permite crear, editar, mostrar/ocultar en la tienda y borrar.
 * El permiso real lo decide la base (RLS); esto solo ordena la interfaz.
 *
 * Como el panel cambia de pestaña mientras las cargas y acciones siguen en vuelo, cada render
 * pregunta `isCurrent()` para no pisar la pestaña que el usuario ya eligió.
 */
let root = null;
let isCurrent = () => true;
let products = [];
let filter = 'all'; // 'all' | 'active' | 'hidden' | 'soldout'

const isSoldOut = (p) => p.stock !== null && p.stock !== undefined && p.stock <= 0;

const FILTERS = [
  ['all', 'Todos', () => true],
  ['active', 'Visibles', (p) => p.is_active],
  ['hidden', 'Ocultos', (p) => !p.is_active],
  ['soldout', 'Agotados', isSoldOut],
];

function stockCell(p) {
  if (p.stock === null || p.stock === undefined) return el('span', { class: 'text-muted small' }, 'Sin control');
  if (p.stock <= 0) return el('span', { class: 'badge text-bg-danger' }, 'Agotado');
  return el('span', {}, String(p.stock));
}

async function toggleActive(row, btn) {
  const next = !row.is_active;
  btn.disabled = true;
  try {
    Object.assign(row, await adminUpdateProduct(row.id, { is_active: next }));
    toast(next ? 'Producto visible en la tienda.' : 'Producto oculto de la tienda.', { type: 'success' });
    renderList();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
    btn.disabled = false;
  }
}

async function removeProduct(row) {
  if (!confirm(`¿Eliminar "${row.title}"? No se puede deshacer.`)) return;
  try {
    await adminDeleteProduct(row.id);
    // La fila ya no existe: recién ahora se borra su imagen (mejor esfuerzo, no bloquea).
    if (row.image_url) deleteProductImageByUrl(row.image_url).catch(() => {});
    products = products.filter((p) => p.id !== row.id);
    toast('Producto eliminado.', { type: 'success' });
    renderList();
  } catch (err) {
    toast(messageFor(err), { type: 'error' });
  }
}

async function editProduct(row) {
  if (await openProductForm({ row, categories: knownCategories(products) })) load();
}

function productRow(row) {
  const media = row.image_url
    ? el('img', { src: row.image_url, alt: '', width: 44, height: 44, class: 'rounded', style: 'object-fit:cover', loading: 'lazy', 'data-hide-on-error': true })
    : el('span', { class: 'text-muted' }, icon('bag-heart'));
  return el('tr', {},
    el('td', { class: 'text-center', style: 'width:64px' }, media),
    el('td', {}, el('strong', {}, row.title), row.category ? el('div', { class: 'text-muted small' }, row.category) : null),
    el('td', {}, formatPrice(row.price_cents)),
    el('td', {}, stockCell(row)),
    el('td', {}, el('span', { class: `badge ${row.is_active ? 'text-bg-success' : 'text-bg-secondary'}` }, row.is_active ? 'Visible' : 'Oculto')),
    el('td', { class: 'text-muted small' }, formatDate(row.updated_at)),
    el('td', { class: 'text-end' }, el('div', { class: 'd-flex gap-1 justify-content-end flex-wrap' },
      el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-secondary', title: 'Editar producto', 'aria-label': `Editar ${row.title}`,
        onclick: () => editProduct(row),
      }, icon('pencil')),
      el('button', {
        type: 'button', class: `btn btn-sm ${row.is_active ? 'btn-outline-secondary' : 'btn-outline-brand'}`,
        onclick: (e) => toggleActive(row, e.currentTarget),
      }, row.is_active ? 'Ocultar' : 'Publicar'),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-danger', title: 'Eliminar', 'aria-label': `Eliminar ${row.title}`,
        onclick: () => removeProduct(row),
      }, icon('trash')))));
}

function newProductButton() {
  return el('button', {
    type: 'button', class: 'btn btn-brand mb-3',
    onclick: async () => { if (await openProductForm({ categories: knownCategories(products) })) load(); },
  }, icon('plus-lg'), ' Nuevo producto');
}

function filterBar() {
  return el('div', { class: 'd-flex gap-2 mb-3 flex-wrap', role: 'group', 'aria-label': 'Filtrar productos' },
    ...FILTERS.map(([key, label]) => el('button', {
      type: 'button',
      class: `btn btn-sm ${filter === key ? 'btn-brand' : 'btn-outline-secondary'}`,
      'aria-pressed': String(filter === key),
      onclick: () => { filter = key; renderList(); },
    }, label)));
}

function renderList() {
  if (!root || !isCurrent()) return;
  if (products.length === 0) {
    return mount(root, newProductButton(), emptyState('Todavía no hay productos', 'Creá el primero con el botón de arriba.'));
  }
  const visible = products.filter(FILTERS.find(([key]) => key === filter)[2]);
  if (visible.length === 0) {
    return mount(root, newProductButton(), filterBar(), emptyState('No hay productos en este filtro', 'Probá con otro filtro de arriba.'));
  }
  mount(root, newProductButton(), filterBar(),
    el('div', { class: 'table-responsive' },
      el('table', { class: 'table align-middle' },
        el('thead', {}, el('tr', {},
          el('th', {}, ''), el('th', {}, 'Producto'), el('th', {}, 'Precio'), el('th', {}, 'Stock'),
          el('th', {}, 'Estado'), el('th', {}, 'Actualizado'), el('th', { class: 'text-end' }, ''))),
        el('tbody', {}, ...visible.map(productRow)))));
}

async function load() {
  if (!root || !isCurrent()) return;
  mount(root, skeletonGrid(4));
  let rows;
  try {
    rows = await adminListProducts();
  } catch (err) {
    if (root && isCurrent()) mount(root, errorState(messageFor(err), load));
    return;
  }
  products = rows;
  renderList();
}

/**
 * Muestra la pestaña de productos dentro de `target`.
 * @param {HTMLElement} target contenedor donde se dibuja.
 * @param {{ isCurrent?: () => boolean }} opts `isCurrent` dice si la pestaña sigue siendo la elegida.
 */
export function showProductsAdmin(target, { isCurrent: current = () => true } = {}) {
  root = target;
  isCurrent = current;
  load();
}
