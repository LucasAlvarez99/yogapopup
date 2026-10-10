import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { deleteMyTestimonial, getMyTestimonial, listPublicTestimonials, saveMyTestimonial } from '../lib/api.js';
import { BODY_MAX, initials, MY_STATUS, validateTestimonial } from '../lib/testimonials.js';
import { messageFor } from '../lib/errors.js';
import { el, icon, mount } from '../lib/dom.js';
import { openAuth } from './auth-modal.js';
import { toast } from './toast.js';

/**
 * "Lo que dice nuestra comunidad" (Fases 26-27) en la sección Sobre nosotros de la home.
 *  - Lista: comentarios APROBADOS. Si todavía no hay ninguno se dejan las tarjetas de ejemplo del HTML.
 *  - Formulario: requiere sesión; uno por persona; lo escrito queda "En revisión" hasta que el panel lo aprueba.
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

export function mountTestimonialForm(host, { onChange = () => {} } = {}) {
  if (!host || !supabase) return;
  let token = 0; // una respuesta tardía de una sesión anterior no pisa a la actual

  async function render() {
    const mine = ++token;
    const { user } = session.getState();
    if (!user) {
      return mount(host, el('div', { class: 'yp-card testimonial-box' },
        el('h3', { class: 'h5' }, '¿Practicaste con nosotros?'),
        el('p', { class: 'text-muted' }, 'Contanos cómo te fue. Tu comentario se publica después de que el equipo lo revise.'),
        el('button', { type: 'button', class: 'btn btn-brand', id: 'tmLogin', onclick: () => openAuth() }, 'Iniciar sesión para comentar')));
    }
    mount(host, el('div', { class: 'yp-card testimonial-box', 'aria-busy': 'true' }, el('p', { class: 'text-muted small mb-0' }, 'Cargando…')));
    let existing = null;
    try { existing = await getMyTestimonial(user.id); }
    catch (err) { if (mine === token) mount(host, el('div', { class: 'yp-card testimonial-box' }, el('p', { class: 'text-danger small mb-0', role: 'alert' }, messageFor(err)))); return; }
    if (mine !== token) return;
    mount(host, form(existing));
  }

  function form(existing) {
    const info = existing ? MY_STATUS[existing.status] : null;
    const body = el('textarea', { class: 'form-control', id: 'tmBody', rows: 4, maxlength: BODY_MAX, required: true, 'aria-describedby': 'tmCount tmError' });
    body.value = existing?.body ?? '';
    const rating = el('select', { class: 'form-select', id: 'tmRating' },
      el('option', { value: '' }, 'Sin puntuación'),
      ...[5, 4, 3, 2, 1].map((n) => el('option', { value: String(n) }, `${n} ${n === 1 ? 'estrella' : 'estrellas'}`)));
    rating.value = existing?.rating ? String(existing.rating) : '';
    const count = el('span', { class: 'small text-muted', id: 'tmCount' }, `${body.value.length} / ${BODY_MAX}`);
    body.addEventListener('input', () => { count.textContent = `${body.value.length} / ${BODY_MAX}`; });
    const error = el('p', { class: 'small text-danger mb-2', id: 'tmError', role: 'alert', hidden: true });
    const submit = el('button', { type: 'submit', class: 'btn btn-brand' }, existing ? 'Guardar cambios' : 'Enviar comentario');

    const f = el('form', { class: 'yp-card testimonial-box', id: 'tmForm', novalidate: true },
      el('h3', { class: 'h5' }, existing ? 'Tu comentario' : 'Dejá tu comentario'),
      info ? el('p', { class: 'small mb-2', id: 'tmStatus', 'data-status': existing.status }, el('span', { class: `badge text-bg-${info.tone} me-2` }, info.label), info.note) : null,
      el('div', { class: 'mb-2' }, el('label', { class: 'form-label', for: 'tmBody' }, 'Tu experiencia'), body,
        el('div', { class: 'd-flex justify-content-between' }, el('span', { class: 'small text-muted' }, 'Se muestra con el nombre de tu cuenta.'), count)),
      el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'tmRating' }, 'Puntuación (opcional)'), rating),
      error,
      el('div', { class: 'd-flex gap-2 flex-wrap' }, submit,
        existing ? el('button', {
          type: 'button', class: 'btn btn-outline-secondary', id: 'tmDelete',
          onclick: async (e) => {
            if (!confirm('¿Borrar tu comentario?')) return;
            e.currentTarget.disabled = true;
            try { await deleteMyTestimonial(existing.id); toast('Borraste tu comentario.', { type: 'info' }); onChange(); await render(); }
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
        await saveMyTestimonial(v.value, existing?.id ?? null);
        toast(existing ? 'Guardamos tu comentario. Vuelve a revisión.' : '¡Gracias! Tu comentario está en revisión.', { type: 'success' });
        onChange();
        await render();
      } catch (err) { toast(messageFor(err), { type: 'error' }); submit.disabled = false; }
    });
    return f;
  }

  session.onChange((_s, event) => { if (event !== 'SESSION_REFRESHED') render(); });
  render();
}
