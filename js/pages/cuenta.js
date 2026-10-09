import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { cancelLiveBooking, getMySubscription, myLiveBookings, paypalCancelSubscription } from '../lib/api.js';
import { arDay, arTime, MODE_LABELS } from '../lib/agenda.js';
import { formatDate, levelLabel } from '../lib/format.js';
import { paymentsEnabled } from '../lib/env.js';
import { messageFor } from '../lib/errors.js';
import { el, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { openAuth } from '../ui/auth-modal.js';
import { toast } from '../ui/toast.js';
import { emptyState } from '../ui/states.js';
import { subscribeBox, subscriptionOffered } from '../ui/subscribe-box.js';

/** Mi cuenta: datos, mi suscripción, mis próximas clases en vivo, cambiar la contraseña y cerrar sesión. */
const root = document.getElementById('account');

async function saveName(name) {
  const { user } = session.getState();
  const { error } = await supabase.from('profiles').update({ display_name: name || null }).eq('id', user.id);
  if (error) throw error;
}

/** "Mis próximas clases en vivo": las reservas de la persona, con opción de cancelar antes de que empiecen. */
function bookingsCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card' }, el('h2', { class: 'yp-block-title' }, 'Mis próximas clases en vivo'), body);
  async function load() {
    let rows;
    try { rows = await myLiveBookings(); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    if (rows.length === 0) {
      return mount(body, el('p', { class: 'text-muted' }, 'Todavía no reservaste ninguna clase.'),
        el('a', { class: 'btn btn-outline-brand btn-sm', href: 'index.html#clases' }, 'Ver clases en vivo'));
    }
    mount(body, el('ul', { class: 'list-unstyled mb-0' }, ...rows.map((r) => el('li', { class: 'd-flex justify-content-between align-items-center gap-2 py-2 border-bottom' },
      el('div', {},
        el('strong', { translate: 'no' }, r.title),
        el('div', { class: 'small text-muted' },
          `${arDay(r.starts_at).split('-').reverse().join('/')} · ${arTime(r.starts_at)} `, el('span', {}, '(hora de Argentina)'),
          ' · ', el('span', {}, levelLabel(r.level)), ' · ', el('span', {}, MODE_LABELS[r.mode])),
        el('div', { class: 'small text-muted', translate: 'no' }, r.teacher_name)),
      new Date(r.starts_at) > new Date()
        ? el('button', {
          type: 'button', class: 'btn btn-sm btn-outline-secondary',
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try { await cancelLiveBooking(r.session_id); toast('Cancelaste tu reserva.', { type: 'info' }); await load(); }
            catch (err) { toast(messageFor(err), { type: 'error' }); e.currentTarget.disabled = false; }
          },
        }, 'Cancelar') : null))));
  }
  load();
  return card;
}

/**
 * "Mi suscripción" (Fases 19-20). Muestra el estado que informa el servidor y permite cancelar. Cancelar NO corta el
 * acceso: dura hasta el final del período ya pagado.
 */
function subscriptionCard() {
  const body = el('div', { 'aria-busy': 'true' }, el('p', { class: 'text-muted small' }, 'Cargando…'));
  const card = el('section', { class: 'yp-card' }, el('h2', { class: 'yp-block-title' }, 'Mi suscripción'), body);

  async function load() {
    let sub;
    try { sub = await getMySubscription(); }
    catch (err) { return mount(body, el('p', { class: 'text-danger small', role: 'alert' }, messageFor(err))); }
    body.setAttribute('aria-busy', 'false');

    const until = sub?.current_period_end ? formatDate(sub.current_period_end) : '';
    const stillPaid = sub?.current_period_end && new Date(sub.current_period_end) > new Date();
    const offer = () => (subscriptionOffered()
      ? subscribeBox({ onActive: () => load() })
      : el('p', { class: 'small text-muted mb-0' }, paymentsEnabled ? 'Pronto vas a poder suscribirte.' : 'Las suscripciones llegan muy pronto.'));

    if (!sub || (sub.status === 'cancelled' && !stillPaid)) {
      return mount(body, el('p', { class: 'text-muted' }, 'No tenés una suscripción activa.'), offer());
    }
    if (sub.status === 'cancelled') {
      return mount(body,
        el('p', {}, el('strong', {}, 'Suscripción cancelada.'), ` Seguís teniendo acceso hasta el ${until}.`),
        el('p', { class: 'small text-muted' }, 'Después de esa fecha no se te cobra ni se renueva.'), offer());
    }
    const cancel = el('button', {
      type: 'button', class: 'btn btn-sm btn-outline-secondary',
      onclick: async (e) => {
        const btn = e.currentTarget;
        if (!confirm(`¿Cancelar tu suscripción? Mantenés el acceso hasta el ${until || 'final del período pagado'} y después no se te vuelve a cobrar.`)) return;
        btn.disabled = true;
        try { await paypalCancelSubscription(); toast('Cancelaste tu suscripción.', { type: 'info' }); await load(); }
        catch (err) { toast(messageFor(err), { type: 'error' }); btn.disabled = false; }
      },
    }, 'Cancelar suscripción');
    mount(body,
      el('p', {}, el('strong', {}, sub.status === 'suspended' ? 'Suscripción con el pago pendiente.' : 'Suscripción activa.')),
      until ? el('p', { class: 'small text-muted' }, sub.status === 'suspended'
        ? `PayPal no pudo cobrar la renovación. Tenés acceso hasta el ${until}; actualizá tu medio de pago en PayPal para no perderlo.`
        : `Próxima renovación: ${until}.`) : null,
      cancel);
  }
  load();
  return card;
}

function render() {
  const { user, profile } = session.getState();
  if (!supabase) return mount(root, emptyState('Cuenta no disponible', 'Falta configurar la conexión con Supabase (js/config.js).'));
  if (!user) {
    return mount(root, emptyState('Inicia sesión para ver tu cuenta', '',
      el('button', { type: 'button', class: 'btn btn-brand', onclick: () => openAuth() }, 'Iniciar sesión')));
  }

  const nameForm = el('form', { class: 'yp-card', novalidate: true },
    el('h2', { class: 'yp-block-title' }, 'Tus datos'),
    el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'accEmail' }, 'Correo electrónico'),
      el('input', { class: 'form-control', id: 'accEmail', value: user.email, readonly: true })),
    el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'accName' }, 'Nombre'),
      el('input', { class: 'form-control', id: 'accName', maxlength: 80, value: profile?.display_name || '', autocomplete: 'name' })),
    el('button', { type: 'submit', class: 'btn btn-brand' }, 'Guardar cambios'));
  nameForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = nameForm.querySelector('button');
    btn.disabled = true;
    try { await saveName(nameForm.accName.value.trim()); toast('Datos actualizados.', { type: 'success' }); setTimeout(() => location.reload(), 700); }
    catch { toast('No se pudieron guardar los cambios.', { type: 'error' }); btn.disabled = false; }
  });

  const passForm = el('form', { class: 'yp-card', novalidate: true },
    el('h2', { class: 'yp-block-title' }, 'Cambiar contraseña'),
    el('div', { class: 'mb-3' }, el('label', { class: 'form-label', for: 'accPass' }, 'Contraseña nueva (mínimo 8 caracteres)'),
      el('input', { class: 'form-control', id: 'accPass', type: 'password', minlength: 8, autocomplete: 'new-password' })),
    el('button', { type: 'submit', class: 'btn btn-outline-brand' }, 'Actualizar contraseña'));
  passForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (passForm.accPass.value.length < 8) return toast('La contraseña debe tener al menos 8 caracteres.', { type: 'error' });
    try { await session.updatePassword(passForm.accPass.value); passForm.reset(); toast('Contraseña actualizada.', { type: 'success' }); }
    catch (err) { toast(session.authMessage(err), { type: 'error' }); }
  });

  mount(root, el('div', { class: 'row g-4' }, el('div', { class: 'col-lg-6' }, nameForm), el('div', { class: 'col-lg-6' }, passForm),
    el('div', { class: 'col-lg-6' }, subscriptionCard()), el('div', { class: 'col-lg-6' }, bookingsCard())),
    el('button', { type: 'button', class: 'btn btn-soft mt-4', onclick: async () => { await session.signOut(); location.href = 'index.html'; } }, 'Cerrar sesión'));
}

await boot('cuenta');
session.onChange((_s, event) => { if (event !== 'INITIAL_SESSION') render(); });
render();
