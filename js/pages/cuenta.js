import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { el, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { openAuth } from '../ui/auth-modal.js';
import { toast } from '../ui/toast.js';
import { emptyState } from '../ui/states.js';

/** Mi cuenta: editar el nombre, cambiar la contraseña y cerrar sesión. */
const root = document.getElementById('account');

async function saveName(name) {
  const { user } = session.getState();
  const { error } = await supabase.from('profiles').update({ display_name: name || null }).eq('id', user.id);
  if (error) throw error;
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

  mount(root, el('div', { class: 'row g-4' }, el('div', { class: 'col-lg-6' }, nameForm), el('div', { class: 'col-lg-6' }, passForm)),
    el('button', { type: 'button', class: 'btn btn-soft mt-4', onclick: async () => { await session.signOut(); location.href = 'index.html'; } }, 'Cerrar sesión'));
}

await boot('cuenta');
session.onChange((_s, event) => { if (event !== 'INITIAL_SESSION') render(); });
render();
