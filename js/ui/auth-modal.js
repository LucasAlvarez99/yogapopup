import { el, icon, mount } from '../lib/dom.js';
import { cfg } from '../lib/env.js';
import { supabase } from '../lib/supabase.js';
import * as session from '../lib/session.js';
import { toast } from './toast.js';

/**
 * Modal de acceso: iniciar sesión, crear cuenta, recuperar y cambiar contraseña.
 * `openAuth()` devuelve una promesa que resuelve true si al cerrarse hay sesión iniciada.
 */
const MIN_PASSWORD = 8;
let modalEl, bsModal, bodyEl, titleEl, view = 'login', notice = '', busy = false, isShown = false, isHiding = false, lastInput = null;

const TITLES = {
  login: 'Iniciá sesión', register: 'Creá tu cuenta', forgot: 'Recuperar contraseña',
  recovery: 'Elegí una contraseña nueva', 'confirm-sent': 'Revisá tu correo', 'reset-sent': 'Revisá tu correo',
};

function build() {
  titleEl = el('h2', { class: 'modal-title', id: 'authTitle' });
  bodyEl = el('div', { class: 'modal-body' });
  modalEl = el('div', { class: 'modal fade yp-auth', id: 'authModal', tabindex: -1, 'aria-labelledby': 'authTitle', 'aria-hidden': 'true' },
    el('div', { class: 'modal-dialog modal-dialog-centered' },
      el('div', { class: 'modal-content' },
        el('div', { class: 'modal-header' },
          el('span', { class: 'brand-mark' }, icon('flower1')), titleEl,
          el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
        bodyEl)));
  document.body.append(modalEl);
  bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
  modalEl.addEventListener('focusin', (e) => { if (e.target instanceof HTMLInputElement) lastInput = e.target; });
  modalEl.addEventListener('shown.bs.modal', () => { isShown = true; });
  modalEl.addEventListener('hide.bs.modal', () => { isHiding = true; });
  modalEl.addEventListener('hidden.bs.modal', () => { isShown = false; isHiding = false; });
}

/**
 * Cierra el modal. Bootstrap ignora hide() mientras la animación de apertura no terminó (pasa si se envía
 * el formulario muy rápido, p. ej. con el autocompletado): en ese caso se espera a que termine de abrirse.
 */
function closeModal() {
  if (isShown) return bsModal.hide();
  modalEl.addEventListener('shown.bs.modal', () => bsModal.hide(), { once: true });
}

function field(id, label, attrs) {
  return el('div', { class: 'mb-3' },
    el('label', { class: 'form-label', for: id }, label),
    el('input', { class: 'form-control', id, required: true, ...attrs }));
}

function setBusy(form, on, text) {
  busy = on;
  const b = form.querySelector('button[type=submit]');
  b.disabled = on;
  b.replaceChildren(on ? el('span', { class: 'spinner-border spinner-border-sm me-2', 'aria-hidden': 'true' }) : '', on ? 'Un momento…' : text);
}

function showError(form, message) {
  let box = form.querySelector('.yp-form-error');
  if (!box) box = form.insertBefore(el('div', { class: 'alert alert-danger yp-form-error', role: 'alert' }), form.firstChild);
  box.textContent = message;
}

const tab = (label, target) =>
  el('button', { type: 'button', class: `yp-tab${view === target ? ' active' : ''}`, 'aria-pressed': String(view === target), onclick: () => go(target) }, label);

function go(next, msg = '') {
  view = next;
  notice = msg;
  render();
}

function render() {
  titleEl.textContent = TITLES[view];
  const kids = [];
  if (notice) kids.push(el('p', { class: 'yp-auth-note' }, notice));

  if (view === 'login' || view === 'register') kids.push(el('div', { class: 'yp-tabs' }, tab('Iniciar sesión', 'login'), tab('Crear cuenta', 'register')));

  if (view === 'login') {
    const f = el('form', { novalidate: true },
      field('authEmail', 'Correo electrónico', { type: 'email', autocomplete: 'email', inputmode: 'email' }),
      field('authPass', 'Contraseña', { type: 'password', autocomplete: 'current-password' }),
      el('button', { type: 'submit', class: 'btn btn-brand w-100' }, 'Entrar'),
      el('button', { type: 'button', class: 'yp-link d-block mx-auto mt-3', onclick: () => go('forgot') }, '¿Olvidaste tu contraseña?'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const email = f.authEmail.value.trim(), pass = f.authPass.value;
      if (!email || !pass) return showError(f, 'Completá tu correo y contraseña.');
      setBusy(f, true, 'Entrar');
      try { await session.signIn(email, pass); closeModal(); toast('Sesión iniciada.', { type: 'success', ms: 2500 }); }
      catch (err) { showError(f, session.authMessage(err)); setBusy(f, false, 'Entrar'); }
    });
    kids.push(f);
  }

  if (view === 'register') {
    const consent = cfg.PRIVACY_URL
      ? el('div', { class: 'form-check mb-3' },
        el('input', { class: 'form-check-input', type: 'checkbox', id: 'authConsent', required: true }),
        el('label', { class: 'form-check-label', for: 'authConsent' }, 'He leído y acepto la ',
          el('a', { href: cfg.PRIVACY_URL, target: '_blank', rel: 'noopener' }, 'política de privacidad')))
      : null;
    const f = el('form', { novalidate: true },
      field('authName', 'Nombre', { type: 'text', autocomplete: 'name', maxlength: 80 }),
      field('authEmail', 'Correo electrónico', { type: 'email', autocomplete: 'email', inputmode: 'email' }),
      field('authPass', `Contraseña (mínimo ${MIN_PASSWORD} caracteres)`, { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD }),
      consent,
      el('button', { type: 'submit', class: 'btn btn-brand w-100' }, 'Crear cuenta'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const name = f.authName.value.trim(), email = f.authEmail.value.trim(), pass = f.authPass.value;
      if (!name || !email) return showError(f, 'Completá tu nombre y correo.');
      if (pass.length < MIN_PASSWORD) return showError(f, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      if (consent && !f.authConsent.checked) return showError(f, 'Necesitamos que aceptes la política de privacidad.');
      setBusy(f, true, 'Crear cuenta');
      try {
        const { needsConfirmation } = await session.signUp(email, pass, name);
        if (needsConfirmation) return go('confirm-sent', `Enviamos un enlace de confirmación a ${email}.`);
        closeModal();
        toast('¡Bienvenida/o a Yoga Pop Up!', { type: 'success' });
      } catch (err) { showError(f, session.authMessage(err)); setBusy(f, false, 'Crear cuenta'); }
    });
    kids.push(f);
  }

  if (view === 'forgot') {
    const f = el('form', { novalidate: true },
      el('p', { class: 'yp-auth-note' }, 'Te enviamos un enlace para elegir una contraseña nueva.'),
      field('authEmail', 'Correo electrónico', { type: 'email', autocomplete: 'email', inputmode: 'email' }),
      el('button', { type: 'submit', class: 'btn btn-brand w-100' }, 'Enviar enlace'),
      el('button', { type: 'button', class: 'yp-link d-block mx-auto mt-3', onclick: () => go('login') }, 'Volver'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const email = f.authEmail.value.trim();
      if (!email) return showError(f, 'Ingresá tu correo.');
      setBusy(f, true, 'Enviar enlace');
      try { await session.sendPasswordReset(email); go('reset-sent', `Si ${email} tiene una cuenta, le llegará un enlace en unos minutos.`); }
      catch (err) { showError(f, session.authMessage(err)); setBusy(f, false, 'Enviar enlace'); }
    });
    kids.push(f);
  }

  if (view === 'recovery') {
    const f = el('form', { novalidate: true },
      field('authPass', `Contraseña nueva (mínimo ${MIN_PASSWORD} caracteres)`, { type: 'password', autocomplete: 'new-password', minlength: MIN_PASSWORD }),
      el('button', { type: 'submit', class: 'btn btn-brand w-100' }, 'Guardar contraseña'));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      if (f.authPass.value.length < MIN_PASSWORD) return showError(f, `La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`);
      setBusy(f, true, 'Guardar contraseña');
      try { await session.updatePassword(f.authPass.value); closeModal(); toast('Contraseña actualizada.', { type: 'success' }); history.replaceState(null, '', location.pathname + location.search); }
      catch (err) { showError(f, session.authMessage(err)); setBusy(f, false, 'Guardar contraseña'); }
    });
    kids.push(f);
  }

  if (view === 'confirm-sent' || view === 'reset-sent') {
    kids.push(el('div', { class: 'text-center' }, el('div', { class: 'yp-auth-ok' }, icon('envelope-check')),
      el('button', { type: 'button', class: 'btn btn-soft mt-2', 'data-bs-dismiss': 'modal' }, 'Entendido')));
  }
  mount(bodyEl, ...kids);
}

/**
 * Abre el modal. Resuelve true si al cerrarlo hay sesión iniciada.
 * @param {{view?: 'login'|'register'|'forgot'|'recovery', message?: string}} [opts]
 */
export function openAuth({ view: v = 'login', message = '' } = {}) {
  if (!supabase) {
    toast('Falta configurar la conexión con Supabase (js/config.js).', { type: 'error', ms: 7000 });
    return Promise.resolve(false);
  }
  if (!modalEl) build();
  busy = false;
  go(v, message);
  return new Promise((resolve) => {
    const onHidden = () => { modalEl.removeEventListener('hidden.bs.modal', onHidden); resolve(session.isLoggedIn()); };
    modalEl.addEventListener('hidden.bs.modal', onHidden);
    // Al terminar de abrirse, Bootstrap enfoca el contenedor del modal (trampa de foco). Si la persona ya venía
    // escribiendo (en un móvil lento la animación tarda), se le devuelve el foco al campo que estaba usando;
    // si no, se enfoca el primero. Así nunca se mezclan los datos entre campos.
    modalEl.addEventListener('shown.bs.modal', () => {
      const target = lastInput && modalEl.contains(lastInput) ? lastInput : modalEl.querySelector('input');
      target?.focus();
    }, { once: true });
    lastInput = null;
    // Bootstrap ignora show() mientras la animación de cierre no terminó: se espera a que acabe.
    if (isHiding) modalEl.addEventListener('hidden.bs.modal', () => bsModal.show(), { once: true });
    else bsModal.show();
  });
}

/** Debe llamarse una vez por página: abre el modal de "contraseña nueva" al volver del enlace del correo. */
export function initAuthUi() {
  session.onChange((_state, event) => { if (event === 'PASSWORD_RECOVERY') openAuth({ view: 'recovery' }); });
}
