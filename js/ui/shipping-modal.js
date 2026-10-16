import { el, icon, mount } from '../lib/dom.js';
import { PROVINCES, SHIP_COUNTRY_NAME, validateShipTo } from '../lib/shipping.js';

/**
 * Pop up del domicilio de envío: se abre al "Finalizar compra" cuando hay productos físicos.
 *   askShipTo({ email, initial }) -> Promise<shipTo | null>   (null = lo cerró sin completar)
 * Recuerda el último domicilio en este navegador (solo comodidad: se guarda en el pedido, en el servidor, al pagar).
 * El servidor vuelve a validar todo: esto solo evita viajes de ida y vuelta.
 */
const KEY = 'yp.shipTo';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* sin almacenamiento: no pasa nada */ } };

let modalEl, bsModal, bodyEl, pending = null;

function build() {
  bodyEl = el('div', { class: 'modal-body' });
  modalEl = el('div', { class: 'modal fade yp-auth shipping-modal', id: 'shipModal', tabindex: -1, 'aria-labelledby': 'shipTitle', 'aria-hidden': 'true' },
    el('div', { class: 'modal-dialog modal-dialog-centered modal-dialog-scrollable' },
      el('div', { class: 'modal-content' },
        el('div', { class: 'modal-header' },
          el('span', { class: 'brand-mark' }, icon('truck')), el('h2', { class: 'modal-title', id: 'shipTitle' }, 'Datos de envío'),
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
        bodyEl)));
  document.body.append(modalEl);
  bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
  // Cerrar sin enviar (X, Esc o clic afuera) = cancelar.
  modalEl.addEventListener('hidden.bs.modal', () => { const p = pending; pending = null; p?.(null); });
}

function field(name, label, value, attrs = {}) {
  const id = `ship_${name}`;
  return el('div', { class: attrs.col ?? 'col-12' },
    el('label', { class: 'form-label', for: id }, label),
    el('input', { class: 'form-control', id, name, value: value ?? '', autocomplete: attrs.autocomplete, inputmode: attrs.inputmode, type: attrs.type ?? 'text', maxlength: attrs.maxlength ?? 120 }),
    el('div', { class: 'invalid-feedback', id: `${id}_err` }));
}

function form(initial, onSubmit) {
  const f = (k) => initial?.[k] ?? '';
  const region = el('select', { class: 'form-select', id: 'ship_region', name: 'region', autocomplete: 'address-level1' },
    el('option', { value: '' }, 'Elegí la provincia'),
    ...PROVINCES.map((p) => el('option', { value: p, selected: p === f('region') }, p)));
  const node = el('form', { novalidate: true, class: 'row g-3', id: 'shipForm' },
    el('p', { class: 'col-12 mb-0' }, 'Llená el formulario con tu domicilio para hacer el envío.'),
    field('name', 'Nombre y apellido', f('name'), { autocomplete: 'name', maxlength: 100 }),
    field('address_line_1', 'Calle y número', f('address_line_1'), { autocomplete: 'address-line1' }),
    field('address_line_2', 'Piso, puerta, referencias (opcional)', f('address_line_2'), { autocomplete: 'address-line2' }),
    field('postal_code', 'Código postal', f('postal_code'), { col: 'col-6', autocomplete: 'postal-code', inputmode: 'numeric', maxlength: 5 }),
    field('city', 'Ciudad', f('city'), { col: 'col-6', autocomplete: 'address-level2', maxlength: 80 }),
    el('div', { class: 'col-12' }, el('label', { class: 'form-label', for: 'ship_region' }, 'Provincia'), region,
      el('div', { class: 'invalid-feedback', id: 'ship_region_err' })),
    el('div', { class: 'col-12' }, el('label', { class: 'form-label' }, 'País'),
      el('input', { class: 'form-control', value: SHIP_COUNTRY_NAME, disabled: true, 'aria-label': 'País' }),
      el('div', { class: 'form-text' }, 'Por ahora solo enviamos a España.')),
    field('phone', 'Teléfono de contacto', f('phone'), { col: 'col-12', type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 20 }),
    field('email', 'Correo electrónico', f('email'), { type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 }),
    el('div', { class: 'col-12 d-grid gap-2' },
      el('button', { type: 'submit', class: 'btn btn-brand' }, 'Continuar al pago ', icon('arrow-right')),
      el('button', { type: 'button', class: 'btn btn-soft', 'data-bs-dismiss': 'modal' }, 'Cancelar')));
  node.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = Object.fromEntries(new FormData(node));
    const res = validateShipTo(raw);
    for (const name of ['name', 'address_line_1', 'address_line_2', 'postal_code', 'city', 'region', 'phone', 'email']) {
      const input = node.querySelector(`[name="${name}"]`);
      const msg = res.errors[name];
      input.classList.toggle('is-invalid', !!msg);
      input.setAttribute('aria-invalid', String(!!msg));
      node.querySelector(`#ship_${name}_err`).textContent = msg ?? '';
    }
    if (!res.ok) { node.querySelector('.is-invalid')?.focus(); return; }
    onSubmit(res.value);
  });
  return node;
}

/** Abre el pop up. Resuelve con el domicilio validado o null si se cerró sin completar. */
export function askShipTo({ email = '' } = {}) {
  if (!window.bootstrap?.Modal) return Promise.resolve(null);
  if (!modalEl) build();
  if (pending) return Promise.resolve(null);
  const saved = read() ?? {};
  const initial = { ...saved, email: saved.email || email };
  return new Promise((resolve) => {
    pending = resolve;
    mount(bodyEl, form(initial, (value) => {
      write(value);
      const p = pending; pending = null; // se resuelve acá: el 'hidden' que sigue ya no cancela
      bsModal.hide();
      p?.(value);
    }));
    bsModal.show();
    modalEl.addEventListener('shown.bs.modal', () => modalEl.querySelector('#ship_name')?.focus(), { once: true });
  });
}
