import {
  adminListTeachers, createLiveSession, deleteLiveSession, deleteTeacherPhotoByUrl, resizeImage, setTeacherActive, setUserRoleByEmail,
  teacherAgenda, updateLiveSession, updateTeacherProfile, uploadTeacherPhoto,
} from '../lib/api.js';
import {
  arDay, arTime, buildSessionInput, buildTeacherProfileInput, isoToArFields, MODE_LABELS, SESSION_LEVELS, SESSION_MODES,
} from '../lib/agenda.js';
import * as session from '../lib/session.js';
import { messageFor } from '../lib/errors.js';
import { levelLabel } from '../lib/format.js';
import { el, icon, mount } from '../lib/dom.js';
import { toast } from './toast.js';
import { emptyState, errorState, skeletonGrid } from './states.js';

/**
 * Panel de profesores (Fases 28-30). Tres vistas dentro del panel de negocio:
 *   showAgenda          agenda de UN profesor: crear/editar/borrar clases en vivo y ver los alumnos anotados.
 *   showProfile         perfil público de UN profesor: nombre, presentación, especialidades y foto.
 *   showTeachersAdmin   equipo docente (gestión): editar el perfil o ver la agenda de cualquiera; el developer además da de alta y baja.
 * El permiso real lo decide la base (RLS); esto solo ordena la interfaz. Cada vista pregunta `isCurrent()` antes de
 * dibujar, porque el panel cambia de pestaña mientras las cargas siguen en vuelo.
 */
const DAYS_AHEAD = 180;

const field = (id, label, control, hint) => el('div', { class: 'mb-3' },
  el('label', { class: 'form-label', for: id }, label), control, hint ? el('div', { class: 'form-text' }, hint) : null);

// ------------------------------------------------------------------ agenda
function sessionForm({ initial = null, onSave, onCancel }) {
  const init = initial ? { ...isoToArFields(initial.starts_at), ...initial } : { level: 'todos', mode: 'live', duration_minutes: 60, is_published: true };
  const levelSel = el('select', { class: 'form-select', id: 'sfLevel' },
    ...SESSION_LEVELS.map((l) => el('option', { value: l, selected: l === init.level }, levelLabel(l))));
  const modeSel = el('select', { class: 'form-select', id: 'sfMode' },
    ...SESSION_MODES.map((m) => el('option', { value: m, selected: m === init.mode }, MODE_LABELS[m])));
  const published = el('input', { class: 'form-check-input', type: 'checkbox', id: 'sfPub', checked: init.is_published });
  published.checked = init.is_published !== false;
  const err = el('p', { class: 'text-danger small', role: 'alert', hidden: true });
  const form = el('form', { class: 'yp-card mb-4', novalidate: true },
    el('h2', { class: 'yp-block-title' }, initial ? 'Editar clase' : 'Nueva clase en vivo'),
    el('div', { class: 'row g-3' },
      el('div', { class: 'col-md-6' }, field('sfTitle', 'Título', el('input', { class: 'form-control', id: 'sfTitle', maxlength: 100, value: init.title ?? '', placeholder: 'Ej.: Vinyasa Flow' }))),
      el('div', { class: 'col-md-3' }, field('sfDate', 'Fecha', el('input', { class: 'form-control', id: 'sfDate', type: 'date', value: init.date ?? '' }))),
      el('div', { class: 'col-md-3' }, field('sfTime', 'Hora (Argentina)', el('input', { class: 'form-control', id: 'sfTime', type: 'time', value: init.time ?? '' }))),
      el('div', { class: 'col-md-3' }, field('sfLevel', 'Nivel', levelSel)),
      el('div', { class: 'col-md-3' }, field('sfMode', 'Modalidad', modeSel)),
      el('div', { class: 'col-md-3' }, field('sfDur', 'Duración (min)', el('input', { class: 'form-control', id: 'sfDur', type: 'number', min: 15, max: 240, value: init.duration_minutes ?? 60 }))),
      el('div', { class: 'col-md-3' }, field('sfCap', 'Cupo', el('input', { class: 'form-control', id: 'sfCap', type: 'number', min: 1, max: 500, value: init.capacity ?? '' }), 'Vacío = sin límite'))),
    el('div', { class: 'form-check mb-3' }, published, el('label', { class: 'form-check-label', for: 'sfPub' }, 'Visible en la home (si lo destildás queda como borrador)')),
    err,
    el('div', { class: 'd-flex gap-2' },
      el('button', { type: 'submit', class: 'btn btn-brand' }, initial ? 'Guardar cambios' : 'Agendar clase'),
      onCancel ? el('button', { type: 'button', class: 'btn btn-soft', onclick: onCancel }, 'Cancelar') : null));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    let input;
    try {
      input = buildSessionInput({
        title: form.sfTitle.value, date: form.sfDate.value, time: form.sfTime.value, level: levelSel.value, mode: modeSel.value,
        duration: form.sfDur.value, capacity: form.sfCap.value, is_published: published.checked,
      }, { allowPast: !!initial && new Date(initial.starts_at) <= new Date() }); // editar una clase ya dada no obliga a cambiar la fecha
    } catch (ex) { err.textContent = messageFor(ex); err.hidden = false; return; }
    btn.disabled = true;
    try { await onSave(input); } catch (ex) { err.textContent = messageFor(ex); err.hidden = false; btn.disabled = false; }
  });
  return form;
}

function sessionRow(s, { onEdit, onDelete }) {
  const students = s.students ?? [];
  return el('div', { class: 'yp-card mb-3' },
    el('div', { class: 'd-flex flex-wrap justify-content-between gap-2' },
      el('div', {},
        el('strong', {}, `${arDay(s.starts_at).split('-').reverse().join('/')} · ${arTime(s.starts_at)}`),
        el('span', { class: 'ms-2' }, s.title),
        !s.is_published ? el('span', { class: 'badge text-bg-secondary ms-2' }, 'Borrador') : null,
        el('div', { class: 'text-muted small' }, `${levelLabel(s.level)} · ${MODE_LABELS[s.mode]} · ${s.duration_minutes} min · `
          + `${students.length}${s.capacity ? ` de ${s.capacity}` : ''} ${students.length === 1 ? 'alumno anotado' : 'alumnos anotados'}`)),
      el('div', { class: 'd-flex gap-2 align-items-start' },
        el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: onEdit }, icon('pencil'), ' Editar'),
        el('button', { type: 'button', class: 'btn btn-sm btn-outline-danger', onclick: onDelete }, icon('trash'), ' Borrar'))),
    students.length ? el('ul', { class: 'tp-student-list' }, ...students.map((x) => el('li', {}, x.name))) : null);
}

/** Agenda de un profesor. `teacherId` es SU id (el propio, o el de cualquiera si quien mira es gestión). */
export async function showAgenda(root, { teacherId, isCurrent = () => true, title = 'Mi agenda' }) {
  const alive = () => isCurrent();
  async function load() {
    if (!alive()) return;
    mount(root, skeletonGrid(2));
    let rows;
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    try { rows = await teacherAgenda(teacherId, from, new Date(Date.now() + DAYS_AHEAD * 86400000).toISOString()); }
    catch (err) { if (alive()) mount(root, errorState(messageFor(err), load)); return; }
    if (alive()) draw(rows);
  }
  function draw(rows, editing = null) {
    const form = sessionForm({
      initial: editing,
      onCancel: editing ? () => draw(rows) : null,
      onSave: async (input) => {
        if (editing) await updateLiveSession(editing.id, input); else await createLiveSession(teacherId, input);
        toast(editing ? 'Clase actualizada.' : 'Clase agendada.', { type: 'success' });
        await load();
      },
    });
    const list = rows.length === 0
      ? emptyState('Todavía no tenés clases agendadas', 'Creá la primera con el formulario de arriba: aparece en la home apenas la publiques.')
      : el('div', {}, ...rows.map((s) => sessionRow(s, {
        onEdit: () => { draw(rows, s); root.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); },
        onDelete: async () => {
          const n = (s.students ?? []).length;
          if (!confirm(`¿Borrar "${s.title}"?${n ? ` Tiene ${n} ${n === 1 ? 'alumno anotado' : 'alumnos anotados'}: se cancelan sus reservas.` : ''} No se puede deshacer.`)) return;
          try { await deleteLiveSession(s.id); toast('Clase borrada.', { type: 'success' }); await load(); }
          catch (err) { toast(messageFor(err), { type: 'error' }); }
        },
      })));
    mount(root, el('h2', { class: 'h4 mb-3' }, title), form, el('h3', { class: 'h5 mb-3' }, 'Próximas clases'), list);
  }
  await load();
}

// ------------------------------------------------------------------ perfil público
/** Editor del perfil público de un profesor (el propio o, si es gestión, el de cualquiera). */
export function showProfile(root, { teacher, isCurrent = () => true, onSaved = () => {}, title = 'Mi perfil' }) {
  let current = teacher;
  let newFile = null;
  const preview = el('div', { class: 'tp-photo' }, current.photo_url ? el('img', { src: current.photo_url, alt: '', width: 96, height: 96, class: 'tp-photo' }) : icon('person-circle'));
  const fileInput = el('input', { class: 'form-control', id: 'tpPhoto', type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0] ?? null;
    newFile = f;
    if (f) mount(preview, el('img', { src: URL.createObjectURL(f), alt: '', width: 96, height: 96, class: 'tp-photo' }));
  });
  const msg = el('p', { class: 'text-danger small', role: 'alert', hidden: true });
  const form = el('form', { class: 'yp-card', novalidate: true },
    el('div', { class: 'd-flex gap-3 align-items-center mb-3' }, preview,
      el('div', { class: 'flex-grow-1' }, field('tpPhoto', 'Foto de perfil', fileInput, 'La ven todas las personas en la home. JPG, PNG o WebP: se reduce sola.'))),
    field('tpName', 'Nombre que se muestra', el('input', { class: 'form-control', id: 'tpName', maxlength: 80, value: current.public_name })),
    field('tpBio', 'Presentación', el('textarea', { class: 'form-control', id: 'tpBio', rows: 4, maxlength: 600 }, current.bio ?? ''), 'Hasta 600 caracteres.'),
    field('tpSpec', 'Especialidades', el('input', { class: 'form-control', id: 'tpSpec', value: (current.specialties ?? []).join(', ') }), 'Separadas por coma. Hasta 8. Ej.: Hatha, Vinyasa, Yoga Flow'),
    msg,
    el('button', { type: 'submit', class: 'btn btn-brand' }, 'Guardar perfil'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msg.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    let patch;
    try { patch = buildTeacherProfileInput({ public_name: form.tpName.value, bio: form.tpBio.value, specialties: form.tpSpec.value }); }
    catch (ex) { msg.textContent = messageFor(ex); msg.hidden = false; return; }
    btn.disabled = true;
    let uploaded = null;
    try {
      if (newFile) { uploaded = await uploadTeacherPhoto(current.profile_id, await resizeImage(newFile)); patch.photo_url = uploaded; }
      const saved = await updateTeacherProfile(current.profile_id, patch);
      // La foto vieja se borra DESPUÉS de guardar la nueva: si algo falla antes, el perfil nunca queda sin foto.
      if (uploaded && current.photo_url) deleteTeacherPhotoByUrl(current.photo_url).catch(() => {});
      current = { ...current, ...saved };
      newFile = null;
      toast('Perfil guardado.', { type: 'success' });
      onSaved(current);
    } catch (ex) {
      if (uploaded) deleteTeacherPhotoByUrl(uploaded).catch(() => {}); // no dejar una foto huérfana si no se pudo guardar
      msg.textContent = messageFor(ex); msg.hidden = false;
    }
    btn.disabled = false;
  });
  if (isCurrent()) mount(root, el('h2', { class: 'h4 mb-3' }, title), form);
}

// ------------------------------------------------------------------ equipo docente (gestión)
export async function showTeachersAdmin(root, { isCurrent = () => true } = {}) {
  const alive = () => isCurrent();
  async function load() {
    if (!alive()) return;
    mount(root, skeletonGrid(2));
    let teachers;
    try { teachers = await adminListTeachers(); }
    catch (err) { if (alive()) mount(root, errorState(messageFor(err), load)); return; }
    if (alive()) draw(teachers);
  }

  function inviteCard() {
    const input = el('input', { class: 'form-control', id: 'inviteEmail', type: 'email', placeholder: 'correo@ejemplo.com', autocomplete: 'off' });
    const btn = el('button', { type: 'submit', class: 'btn btn-brand' }, icon('person-plus'), ' Dar de alta como profesor/a');
    const form = el('form', { class: 'yp-card mb-4', novalidate: true },
      el('h2', { class: 'yp-block-title' }, 'Dar de alta un profesor'),
      el('p', { class: 'text-muted small' }, 'La persona tiene que haberse registrado antes en el sitio. Al darla de alta pasa a tener rol profesor: gestiona su agenda y su perfil, y nada más.'),
      field('inviteEmail', 'Correo con el que se registró', input), btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Escribí un correo válido.', { type: 'error' });
      btn.disabled = true;
      try { await setUserRoleByEmail(email, 'profesor'); toast('Listo: ya es profesor/a. Puede completar su perfil desde el panel.', { type: 'success' }); await load(); }
      catch (err) { toast(messageFor(err), { type: 'error' }); btn.disabled = false; }
    });
    return form;
  }

  function row(t, teachers) {
    const photo = t.photo_url ? el('img', { src: t.photo_url, alt: '', class: 'tp-photo', width: 96, height: 96 }) : el('div', { class: 'tp-photo' }, icon('person-circle'));
    return el('div', { class: 'yp-card mb-3 d-flex flex-wrap gap-3 align-items-center' }, photo,
      el('div', { class: 'flex-grow-1' },
        el('strong', {}, t.public_name),
        !t.is_active ? el('span', { class: 'badge text-bg-secondary ms-2' }, 'De baja') : null,
        el('div', { class: 'text-muted small' }, t.bio ? t.bio.slice(0, 120) : 'Sin presentación todavía')),
      el('div', { class: 'd-flex flex-wrap gap-2' },
        el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: () => editProfile(t, teachers) }, icon('person-lines-fill'), ' Perfil y foto'),
        el('button', { type: 'button', class: 'btn btn-sm btn-outline-secondary', onclick: () => viewAgenda(t, teachers) }, icon('calendar3'), ' Agenda'),
        session.isDeveloper() ? el('button', {
          type: 'button', class: `btn btn-sm ${t.is_active ? 'btn-outline-danger' : 'btn-outline-success'}`,
          onclick: async () => {
            if (t.is_active && !confirm(`¿Dar de baja a ${t.public_name}? Deja de verse en la home. Sus clases ya agendadas dejan de mostrarse.`)) return;
            try { await setTeacherActive(t.profile_id, !t.is_active); toast(t.is_active ? 'Profesor/a dado de baja.' : 'Profesor/a reactivado.', { type: 'success' }); await load(); }
            catch (err) { toast(messageFor(err), { type: 'error' }); }
          },
        }, t.is_active ? 'Dar de baja' : 'Reactivar') : null));
  }

  const back = (teachers) => el('button', { type: 'button', class: 'btn btn-soft btn-sm mb-3', onclick: () => draw(teachers) }, icon('arrow-left'), ' Volver al equipo');
  function editProfile(t, teachers) {
    const host = el('div');
    mount(root, back(teachers), host);
    showProfile(host, { teacher: t, isCurrent: alive, title: `Perfil de ${t.public_name}`, onSaved: () => {} });
  }
  function viewAgenda(t, teachers) {
    const host = el('div');
    mount(root, back(teachers), host);
    showAgenda(host, { teacherId: t.profile_id, isCurrent: alive, title: `Agenda de ${t.public_name}` });
  }

  function draw(teachers) {
    mount(root,
      session.isDeveloper() ? inviteCard() : null,
      el('h2', { class: 'h4 mb-3' }, 'Equipo docente'),
      teachers.length === 0
        ? emptyState('Todavía no hay profesores', session.isDeveloper() ? 'Dá de alta al primero con el formulario de arriba.' : 'Cuando el equipo técnico dé de alta al primero, lo vas a ver acá.')
        : el('div', {}, ...teachers.map((t) => row(t, teachers))));
  }
  await load();
}
