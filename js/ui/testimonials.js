import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { deleteMyTestimonial, getMySuspension, getMyTestimonial, listPublicTestimonials, saveMyTestimonial } from '../lib/api.js';
import { BODY_MAX, formatSuspensionEnd, initials, MY_STATUS, SUSPENSION_HOURS, validateTestimonial } from '../lib/testimonials.js';
import { messageFor } from '../lib/errors.js';
import { el, icon, mount } from '../lib/dom.js';
import { openAuth } from './auth-modal.js';
import { toast } from './toast.js';

/**
 * "Lo que dice nuestra comunidad" (Fases 26-27) en la sección Sobre nosotros de la home.
 *  - Lista: comentarios APROBADOS. Si todavía no hay ninguno se dejan las tarjetas de ejemplo del HTML.
 *  - Formulario: se abre en un pop up desde el botón "Dejá tu comentario"; requiere sesión; uno por persona.
 *    Se publica al instante (sin aprobación). Al enviar se muestra un mensaje y el pop up se cierra solo.
 *    Si trae una palabra prohibida la base lo deja oculto y suspende la cuenta 168 h: se le explica y se cierra su sesión.
 * Quién puede qué lo decide la base (RLS); esto solo ordena la interfaz.
 */
const stars = (n) => (n ? el('div', { class: 'stars', role: 'img', 'aria-label': `${n} de 5` },
  ...Array.from({ length: n }, () => icon('star-fill'))) : null);

function quoteCard(t) {
  return el('figure', { class: 'col-md-4' }, el('blockquote', { class: 'quote-card' },
    el('header', {}, el('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(t.author_name)),
      el('div', {}, el('strong', { translate: 'no' }, t.author_name), stars(t.rating))),
    // Texto escrito por una persona: SIEMPRE como texto (nunca como HTML).
    el('p', { translate: 'no' }, t.body)));
}

export async function loadPublicTestimonials(list) {
  if (!list || !supabase) return;
  try {
    const items = await listPublicTestimonials(6);
    if (items.length > 0) mount(list, ...items.map(quoteCard));
  } catch { /* se quedan las tarjetas de ejemplo: la home no se rompe por esto */ }
}

const CLOSE_DELAY_MS = 2400; // lo que se ve el mensaje de "enviado" antes de cerrarse solo

export function mountTestimonialModal(trigger, { onChange = () => {} } = {}) {
  if (!trigger) return;
  if (!supabase || !window.bootstrap?.Modal) { trigger.hidden = true; return; }
  let modalEl, bsModal, titleEl, bodyEl, closeTimer = null, isOpen = false, token = 0, signOutOnClose = false;

  function build() {
    titleEl = el('h2', { class: 'modal-title', id: 'tmModalTitle' }, 'Dejá tu comentario');
    bodyEl = el('div', { class: 'modal-body' });
    modalEl = el('div', { class: 'modal fade yp-auth testimonial-modal', id: 'tmModal', tabindex: -1, 'aria-labelledby': 'tmModalTitle', 'aria-hidden': 'true' },
      el('div', { class: 'modal-dialog modal-dialog-centered' },
        el('div', { class: 'modal-content' },
          el('div', { class: 'modal-header' },
            el('span', { class: 'brand-mark' }, icon('chat-heart')), titleEl,
            el('button', { type: 'button', class: 'btn-close', 'data-bs-dismiss': 'modal', 'aria-label': 'Cerrar' })),
          bodyEl)));
    document.body.append(modalEl);
    bsModal = window.bootstrap.Modal.getOrCreateInstance(modalEl);
    modalEl.addEventListener('shown.bs.modal', () => { modalEl.querySelector('#tmBody')?.focus(); });
    modalEl.addEventListener('hidden.bs.modal', () => {
      isOpen = false; clearTimeout(closeTimer); closeTimer = null;
      // Cuenta suspendida: al cerrar el aviso se cierra también su sesión (la base ya no le renueva el acceso).
      if (signOutOnClose) { signOutOnClose = false; session.signOut().catch(() => {}); }
    });
  }

  const whenHidden = () => new Promise((resolve) => {
    modalEl.addEventListener('hidden.bs.modal', resolve, { once: true });
    bsModal.hide();
  });

  function showSuccess(existing) {
    titleEl.textContent = existing ? 'Tu comentario' : 'Dejá tu comentario';
    mount(bodyEl, el('div', { class: 'tm-success', id: 'tmSuccess', role: 'status' },
      icon('check-circle-fill', 'yp-auth-ok'),
      el('h3', { class: 'h4 mt-2' }, existing ? '¡Cambios guardados!' : '¡Comentario enviado!'),
      el('p', { class: 'yp-auth-note mb-0' }, existing
        ? 'Tu comentario vuelve a revisión y se publica cuando el equipo lo apruebe.'
        : '¡Gracias por compartir tu experiencia! Se publica en la home cuando el equipo lo apruebe.')));
    closeTimer = setTimeout(() => { if (isOpen) bsModal.hide(); }, CLOSE_DELAY_MS);
  }

  /** Comentario no publicado por una palabra prohibida: se explica la suspensión (o, si no hay, que sigue sin publicarse). */
  function showBlocked(until) {
    titleEl.textContent = 'Tu comentario no se publicó';
    signOutOnClose = Boolean(until);
    mount(bodyEl, el('div', { class: 'tm-success tm-blocked', id: 'tmBlocked', role: 'alert' },
      icon('exclamation-octagon-fill', 'yp-auth-ok'),
      el('p', { class: 'mt-2 mb-2' }, until
        ? `Incluye palabras que no permitimos en nuestra comunidad. Por eso tu cuenta quedó suspendida por ${SUSPENSION_HOURS} horas (7 días).`
        : 'Tu comentario no se muestra en la página.'),
      until ? el('p', { class: 'yp-auth-note mb-3', id: 'tmBlockedUntil' }, `Podés volver a ingresar el ${formatSuspensionEnd(until)}.`) : null,
      el('button', { type: 'button', class: 'btn btn-brand', id: 'tmBlockedOk', onclick: () => bsModal.hide() }, 'Entendido')));
  }

  async function afterSave(existing, saved) {
    if (saved?.status === 'hidden') return showBlocked(await getMySuspension());
    showSuccess(existing);
  }

  async function render() {
    const mine = ++token;
    const { user } = session.getState();
    if (!user) {
      titleEl.textContent = '¿Practicaste con nosotros?';
      return mount(bodyEl, el('div', { class: 'testimonial-box' },
        el('p', { class: 'yp-auth-note' }, 'Contanos cómo te fue. Tu comentario se publica después de que el equipo lo revise.'),
        el('button', {
          type: 'button', class: 'btn btn-brand w-100', id: 'tmLogin',
          onclick: async () => { await whenHidden(); if (await openAuth()) open(); },
        }, 'Iniciar sesión para comentar')));
    }
    titleEl.textContent = 'Dejá tu comentario';
    mount(bodyEl, el('div', { class: 'testimonial-box', 'aria-busy': 'true' }, el('p', { class: 'text-muted small mb-0' }, 'Cargando…')));
    let existing = null, until = null;
    try { [existing, until] = await Promise.all([getMyTestimonial(user.id), getMySuspension()]); }
    catch (err) { if (mine === token) mount(bodyEl, el('p', { class: 'text-danger small mb-0', role: 'alert' }, messageFor(err))); return; }
    if (mine !== token) return;
    if (until) return showBlocked(until);   // todavía suspendida (conserva un token vivo): no se ofrece el formulario
    mount(bodyEl, form(existing));
    titleEl.textContent = existing ? 'Tu comentario' : 'Dejá tu comentario';
    modalEl.querySelector('#tmBody')?.focus();
  }

  function form(existing) {
    const info = existing ? MY_STATUS[existing.status] : null;
    const body = el('textarea', { class: 'form-control', id: 'tmBody', rows: 5, maxlength: BODY_MAX, required: true, 'aria-describedby': 'tmCount tmError' });
    body.value = existing?.body ?? '';
    const rating = el('select', { class: 'form-select', id: 'tmRating' },
      el('option', { value: '' }, 'Sin puntuación'),
      ...[5, 4, 3, 2, 1].map((n) => el('option', { value: String(n) }, `${n} ${n === 1 ? 'estrella' : 'estrellas'}`)));
    rating.value = existing?.rating ? String(existing.rating) : '';
    const count = el('span', { class: 'small text-muted', id: 'tmCount' }, `${body.value.length} / ${BODY_MAX}`);
    body.addEventListener('input', () => { count.textContent = `${body.value.length} / ${BODY_MAX}`; });
    const error = el('p', { class: 'small text-danger mb-2', id: 'tmError', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn-brand' }, existing ? 'Guardar cambios' : 'Enviar comentario');

    const f = el('form', { class: 'testimonial-box', id: 'tmForm', novalidate: true },
      info ? el('p', { class: 'small mb-3', id: 'tmStatus', 'data-status': existing.status }, el('span', { class: `badge text-bg-${info.tone} me-2` }, info.label), info.note) : null,
      el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'tmBody' }, 'Tu experiencia'), body,
        el('div', { class: 'd-flex justify-content-between mt-1' }, el('span', { class: 'small text-muted' }, 'Se muestra con el nombre de tu cuenta.'), count)),
      el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'tmRating' }, 'Puntuación (opcional)'), rating),
      error,
      el('div', { class: 'd-flex gap-2 flex-wrap' }, submit,
        existing ? el('button', {
          type: 'button', class: 'btn btn-outline-secondary', id: 'tmDelete',
          onclick: async (e) => {
            if (!confirm('¿Borrar tu comentario?')) return;
            e.currentTarget.disabled = true;
            try { await deleteMyTestimonial(existing.id); toast('Borraste tu comentario.', { type: 'info' }); onChange(); bsModal.hide(); }
            catch (err) { toast(messageFor(err), { type: 'error' }); e.currentTarget.disabled = false; }
          },
        }, 'Borrar') : null));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = validateTestimonial({ body: body.value, rating: rating.value });
      error.hidden = v.ok;
      if (!v.ok) { error.textContent = v.error; (v.field === 'body' ? body : rating).focus(); return; }
      submit.disabled = true;
      try {
        const saved = await saveMyTestimonial(v.value, existing?.id ?? null);
        onChange();
        await afterSave(existing, saved);
      } catch (err) {
        if (err?.code === 'account_suspended') return showBlocked(await getMySuspension());
        toast(messageFor(err), { type: 'error' }); submit.disabled = false;
      }
    });
    return f;
  }

  function open() {
    if (!modalEl) build();
    clearTimeout(closeTimer);
    isOpen = true;
    bsModal.show();
    render();
  }

  trigger.addEventListener('click', open);
  // Si inicia o cierra sesión con el pop up abierto, se ajusta lo que muestra (salvo el mensaje de "enviado").
  session.onChange((_s, event) => {
    if (event !== 'SESSION_REFRESHED' && isOpen && !modalEl.querySelector('#tmSuccess')) render();
  });
}
