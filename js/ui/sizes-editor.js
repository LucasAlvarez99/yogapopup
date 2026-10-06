import { el, icon } from '../lib/dom.js';
import { SIZE_PRESETS, sortedVariants } from '../lib/sizes.js';

/**
 * Editor de talles del formulario de producto: botones rápidos (S, M, L, XL, 2XL…), una fila por talle con su
 * stock, y "Otro talle" para escribir uno propio. La validación vive en lib/sizes.js (validateSizeRows).
 *
 * @param {object[]} variants talles actuales del producto (los de la base)
 * @param {{ onChange?: (count: number) => void }} opts
 * @returns {{ node: HTMLElement, read: () => Array<{size: string, stock: string}>, count: () => number }}
 */
export function sizesEditor(variants = [], { onChange = () => {} } = {}) {
  const rowsBox = el('div', { class: 'size-rows', id: 'pfSizeRows' });
  const presetsBox = el('div', { class: 'size-presets', role: 'group', 'aria-label': 'Agregar talle' });

  const names = () => [...rowsBox.querySelectorAll('[data-size-name]')].map((i) => i.value.trim().toLowerCase());
  const changed = () => {
    // Solo los atajos (tienen data-preset); "Otro talle" no es un atajo y siempre queda activo.
    for (const b of presetsBox.querySelectorAll('button[data-preset]')) b.disabled = names().includes(b.dataset.preset.toLowerCase());
    onChange(rowsBox.children.length);
  };

  function addRow(size = '', stock = '', { focus = false } = {}) {
    const nameInput = el('input', {
      class: 'form-control form-control-sm', type: 'text', maxlength: 20, placeholder: 'Talle', 'aria-label': 'Nombre del talle',
      'data-size-name': true, value: size, oninput: changed,
    });
    const stockInput = el('input', {
      class: 'form-control form-control-sm', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Stock (vacío = sin control)',
      'aria-label': 'Stock del talle', 'data-size-stock': true, value: stock === null || stock === undefined ? '' : String(stock),
    });
    const row = el('div', { class: 'size-row' }, nameInput, stockInput,
      el('button', {
        type: 'button', class: 'btn btn-sm btn-outline-danger', 'aria-label': 'Quitar este talle',
        onclick: () => { row.remove(); changed(); },
      }, icon('x-lg')));
    rowsBox.append(row);
    changed();
    if (focus) (size ? stockInput : nameInput).focus();
  }

  for (const preset of SIZE_PRESETS) {
    presetsBox.append(el('button', {
      type: 'button', class: 'btn btn-sm btn-outline-secondary', 'data-preset': preset, onclick: () => addRow(preset, '', { focus: true }),
    }, preset));
  }
  presetsBox.append(el('button', { type: 'button', class: 'btn btn-sm btn-soft', onclick: () => addRow('', '', { focus: true }) },
    icon('plus-lg'), ' Otro talle'));

  for (const v of sortedVariants({ product_variants: variants })) addRow(v.size, v.stock);

  const node = el('div', { class: 'mb-3 size-editor' },
    el('label', { class: 'form-label' }, 'Talles (opcional)'),
    presetsBox,
    rowsBox,
    el('div', { class: 'form-text' }, 'Si el producto tiene talles, el stock se controla en cada uno (el stock general se ignora). Déjalo vacío si un talle no tiene límite.'));
  changed();

  return {
    node,
    count: () => rowsBox.children.length,
    read: () => [...rowsBox.children].map((row) => ({
      size: row.querySelector('[data-size-name]').value,
      stock: row.querySelector('[data-size-stock]').value,
    })),
  };
}
