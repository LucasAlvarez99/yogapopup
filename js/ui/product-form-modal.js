import { CATEGORY_HINT_PRODUCT, SORT_HINT } from '../lib/catalog-fields.js';
import { el, mount } from '../lib/dom.js';
import { messageFor } from '../lib/errors.js';
import { buildProductInput, centsToEurosInput } from '../lib/product-form.js';
import { sizesEditor } from './sizes-editor.js';
import { TAX_OPTIONS } from '../lib/tax.js';
import {
  adminCreateProduct,
  adminSaveProductVariants,
  adminUpdateProduct,
  deleteProductImageByUrl,
  resizeImage,
  uploadProductImage,
} from '../lib/api.js';
import { toast } from './toast.js';

/**
 * Fase 14 (panel administrativo): alta y edición de un producto de la tienda.
 * La validación y la conversión euros -> céntimos viven en lib/product-form.js (con pruebas);
 * el permiso real lo decide la base (RLS + privilegio por columna).
 *
 * La imagen sigue el mismo patrón que las miniaturas de clases: se reduce en el navegador,
 * se sube a Storage y recién con el cambio ya guardado se borra la anterior (mejor esfuerzo).
 */
let modalEl, bsModal, bodyEl, titleEl;

function build() {
  titleEl = el('h2', { class: 'modal-title', id: 'productFormTitle' });
  bodyEl = el('div', { class: 'modal-body' });
  modalEl = el('div', { class: 'modal fade', id: 'productFormModal', tabindex: -1, 'aria-labelledby': 'productFormTitle', 'aria-hidden': 'true' },
    el('div', { class: 'modal-dialog modal-dialog-centered' },
      el('div', { class: 'modal-content' },
        el('div', { class: 'modal-header' }, titleEl,
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
        bodyEl)));
  document.body.append(modalEl);
  bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
}

/** Opciones de IVA; si el producto tiene un tipo fuera de la lista (p. ej. 5 %), se conserva para no cambiarlo sin querer. */
function taxChoices(current) {
  return TAX_OPTIONS.some((o) => o.bps === current) || !Number.isInteger(current)
    ? TAX_OPTIONS
    : [...TAX_OPTIONS, { bps: current, label: `${current / 100} %` }];
}

function showError(form, message) {
  let box = form.querySelector('.yp-form-error');
  if (!box) box = form.insertBefore(el('div', { class: 'alert alert-danger yp-form-error', role: 'alert' }), form.firstChild);
  box.textContent = message;
}

function field(id, label, node, hint) {
  return el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: id }, label), node,
    hint ? el('div', { class: 'form-text' }, hint) : null);
}

/**
 * @param {{ row?: object|null }} opts row = producto a editar; sin row se crea uno nuevo.
 * @returns {Promise<boolean>} true si se guardó algo (conviene refrescar la lista).
 */
export function openProductForm({ row = null, categories = [] } = {}) {
  if (!modalEl) build();
  const editing = Boolean(row);
  titleEl.textContent = editing ? `Editar · ${row.title}` : 'Nuevo producto';

  // Talles: si hay alguno, el stock se controla en cada uno y el stock general se deshabilita.
  const sizes = sizesEditor(row?.product_variants ?? [], {
    onChange: (count) => {
      const stock = document.getElementById('pfStock');
      if (!stock) return;
      stock.disabled = count > 0;
      stock.placeholder = count > 0 ? 'Por talle' : '';
    },
  });
  const initialSizes = JSON.stringify(sizes.read());

  const form = el('form', { novalidate: true },
    field('pfTitle', 'Título', el('input', { class: 'form-control', id: 'pfTitle', required: true, maxlength: 150, value: row?.title ?? '' })),
    field('pfDescription', 'Descripción', el('textarea', { class: 'form-control', id: 'pfDescription', rows: 3, maxlength: 5000 }, row?.description ?? '')),
    el('div', { class: 'row' },
      el('div', { class: 'col-12 col-sm-6' }, field('pfPrice', 'Precio (€)',
        el('input', { class: 'form-control', id: 'pfPrice', inputmode: 'decimal', autocomplete: 'off', placeholder: '19,99', required: true, value: editing ? centsToEurosInput(row.price_cents) : '' }),
        'Con coma o punto y hasta 2 decimales. Sin separador de miles.')),
      el('div', { class: 'col-12 col-sm-6' }, field('pfStock', 'Stock',
        el('input', { class: 'form-control', id: 'pfStock', inputmode: 'numeric', autocomplete: 'off', value: row?.stock ?? '' }),
        'Vacío = no se controla stock (digital o a pedido). 0 = agotado.'))),
    el('div', { class: 'row' },
      el('div', { class: 'col-12 col-sm-6' }, field('pfTax', 'IVA incluido en el precio',
        el('select', { class: 'form-select', id: 'pfTax' },
          ...taxChoices(row?.tax_rate_bps).map((o) => el('option', { value: String(o.bps), selected: o.bps === (row?.tax_rate_bps ?? 2100) }, o.label))),
        'En la tienda se muestra el precio y, al lado, el precio sin IVA. Confirma el tipo con la gestoría.'))),
    el('div', { class: 'row' },
      el('div', { class: 'col-12 col-sm-6' }, field('pfCategory', 'Categoría',
        el('input', { class: 'form-control', id: 'pfCategory', maxlength: 60, list: 'pfCategoryList', autocomplete: 'off', placeholder: 'Ropa', value: row?.category ?? '' }),
        CATEGORY_HINT_PRODUCT),
      // Categorías ya usadas: se sugieren al escribir, para no crear "ropa" y "Ropa" por separado.
      el('datalist', { id: 'pfCategoryList' }, ...categories.map((c) => el('option', { value: c })))),
      el('div', { class: 'col-12 col-sm-6' }, field('pfSort', 'Orden',
        el('input', { class: 'form-control', id: 'pfSort', type: 'number', inputmode: 'numeric', step: '1', value: String(row?.sort_order ?? 0) }),
        SORT_HINT))),
    sizes.node,
    field('pfImage', editing ? 'Reemplazar imagen (opcional)' : 'Imagen (opcional)',
      el('input', { class: 'form-control', id: 'pfImage', type: 'file', accept: 'image/jpeg,image/png,image/webp' })),
    editing && row.image_url ? el('img', { src: row.image_url, alt: '', class: 'yp-cf-thumb-preview mb-2', width: 120 }) : null,
    editing && row.image_url
      ? el('div', { class: 'form-check mb-3' },
        el('input', { class: 'form-check-input', type: 'checkbox', id: 'pfRemoveImage' }),
        el('label', { class: 'form-check-label', for: 'pfRemoveImage' }, 'Quitar la imagen actual'))
      : null,
    el('div', { class: 'form-check form-switch mb-3' },
      el('input', { class: 'form-check-input', type: 'checkbox', role: 'switch', id: 'pfActive', checked: row?.is_active ?? false }),
      el('label', { class: 'form-check-label', for: 'pfActive' }, 'Visible en la tienda'),
      editing ? null : el('div', { class: 'form-text' }, 'Un producto nuevo queda oculto hasta que lo publiques.')),
    el('button', { type: 'submit', class: 'btn btn-brand w-100' }, editing ? 'Guardar cambios' : 'Crear producto'));

  let resolveOpen;
  const result = new Promise((resolve) => {
    resolveOpen = resolve;
    const onHidden = () => { modalEl.removeEventListener('hidden.bs.modal', onHidden); resolve(false); };
    modalEl.addEventListener('hidden.bs.modal', onHidden);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type=submit]');
    const parsed = buildProductInput({
      title: form.pfTitle.value,
      description: form.pfDescription.value,
      category: form.pfCategory.value,
      price: form.pfPrice.value,
      stock: form.pfStock.value,
      sort_order: form.pfSort.value,
      tax_rate_bps: form.pfTax.value,
      sizes: sizes.read(),
      is_active: form.pfActive.checked,
    }, { previousCategory: row?.category ?? null, knownCategories: categories });
    if (parsed.error) return showError(form, parsed.error);

    submitBtn.disabled = true;
    const imageFile = form.pfImage.files[0];
    const removeImage = Boolean(form.querySelector('#pfRemoveImage')?.checked) && !imageFile;
    let newImageUrl = null;
    try {
      if (editing) {
        const patch = { ...parsed.value };
        if (imageFile) {
          newImageUrl = await uploadProductImage(row.id, await resizeImage(imageFile));
          patch.image_url = newImageUrl;
        } else if (removeImage) {
          patch.image_url = null;
        }
        try {
          await adminUpdateProduct(row.id, patch);
        } catch (err) {
          // El cambio no se guardó: no dejar huérfana la imagen nueva que recién se subió.
          if (newImageUrl) deleteProductImageByUrl(newImageUrl).catch(() => {});
          throw err;
        }
        // Recién ahora, con el cambio ya guardado: borrar la imagen vieja (mejor esfuerzo, no bloquea).
        if ((imageFile || removeImage) && row.image_url) deleteProductImageByUrl(row.image_url).catch(() => {});
        let sizesFailed = null;
        if (JSON.stringify(sizes.read()) !== initialSizes) {
          try { await adminSaveProductVariants(row.id, parsed.sizes); } catch (err) { sizesFailed = err; }
        }
        if (sizesFailed) toast(`Los cambios se guardaron, pero los talles no: ${messageFor(sizesFailed)}`, { type: 'error', ms: 7000 });
        else toast('Cambios guardados.', { type: 'success' });
      } else {
        const created = await adminCreateProduct(parsed.value);
        if (imageFile) {
          try {
            const url = await uploadProductImage(created.id, await resizeImage(imageFile));
            try {
              await adminUpdateProduct(created.id, { image_url: url });
            } catch (err) {
              deleteProductImageByUrl(url).catch(() => {});
              throw err;
            }
          } catch (err) {
            toast(`El producto se creó, pero la imagen falló: ${messageFor(err)}`, { type: 'error', ms: 6000 });
          }
        }
        let sizesFailed = null;
        if (parsed.sizes.length > 0) {
          try { await adminSaveProductVariants(created.id, parsed.sizes); } catch (err) { sizesFailed = err; }
        }
        if (sizesFailed) toast(`El producto se creó, pero los talles fallaron: ${messageFor(sizesFailed)}. Ábrelo con «Editar» para cargarlos.`, { type: 'error', ms: 7000 });
        else toast('Producto creado.', { type: 'success' });
      }
      bsModal.hide();
      resolveOpen(true);
    } catch (err) {
      submitBtn.disabled = false;
      showError(form, messageFor(err));
    }
  });

  mount(bodyEl, form);
  bsModal.show();
  return result;
}
