import { el, icon, mount } from '../lib/dom.js';
import {
  arDay, arTime, groupByDay, isFull, localTimeIfDifferent, MODE_LABELS, monthGrid, monthLabel, monthRange, seatsLeft, shiftMonth,
  WEEKDAYS,
} from '../lib/agenda.js';
import { levelLabel } from '../lib/format.js';
import { messageFor } from '../lib/errors.js';
import { emptyState, errorState } from '../ui/states.js';

/**
 * "Practicá acompañado": carrusel de profesores + agenda de clases en vivo (calendario del mes, horarios del día y reserva).
 *
 * Todo lo que viene de la base entra como TEXTO (`el()`), nunca como HTML. Los datos externos se piden por `api`
 * (inyectable para probar el componente sin red) y la sesión por `auth`. El permiso de reservar lo decide la base:
 * esto solo ordena la interfaz.
 *
 * @param {HTMLElement} root
 * @param {{ api: object, auth: { isLoggedIn: () => boolean, openLogin: () => void, onChange?: Function }, notify?: Function, now?: () => Date }} deps
 */
export function mountTeachersAgenda(root, { api, auth, notify = () => {}, now = () => new Date() }) {
  const today = now();
  const [ty, tm] = arDay(today).split('-').map(Number);
  const st = {
    teachers: [], idx: 0, year: ty, month: tm - 1, sessions: [], day: null, sessionId: null, busy: false, token: 0,
  };

  const teacher = () => st.teachers[st.idx];
  const daySessions = () => groupByDay(st.sessions).get(st.day) ?? [];
  const selected = () => st.sessions.find((s) => s.id === st.sessionId) ?? null;

  async function loadTeachers() {
    root.setAttribute('aria-busy', 'true');
    mount(root, el('div', { class: 'yp-skeleton' }));
    try {
      st.teachers = await api.listTeachers();
    } catch (err) {
      root.setAttribute('aria-busy', 'false');
      return mount(root, errorState(messageFor(err), loadTeachers));
    }
    root.setAttribute('aria-busy', 'false');
    if (st.teachers.length === 0) {
      return mount(root, emptyState('Muy pronto, nuestras clases en vivo', 'Estamos sumando profesores y horarios. Volvé en unos días.'));
    }
    await loadMonth();
  }

  /** Trae el mes del profesor elegido. `token` descarta respuestas viejas si la persona ya cambió de profesor o de mes. */
  async function loadMonth({ keepDay = false } = {}) {
    const token = ++st.token;
    const { from, to } = monthRange(st.year, st.month);
    let rows = [];
    let failed = null;
    try {
      rows = await api.liveAgenda({ teacher: teacher().profile_id, from, to });
    } catch (err) { failed = err; }
    if (token !== st.token) return;
    st.sessions = rows;
    const days = [...groupByDay(rows).keys()].sort();
    if (!keepDay || !days.includes(st.day)) st.day = days[0] ?? null;
    if (!daySessions().some((s) => s.id === st.sessionId)) st.sessionId = daySessions().find((s) => !isFull(s))?.id ?? daySessions()[0]?.id ?? null;
    render(failed);
  }

  function pickTeacher(i) {
    st.idx = (i + st.teachers.length) % st.teachers.length;
    st.day = null; st.sessionId = null;
    loadMonth();
  }

  // ------------------------------------------------------------------ tarjeta del profesor
  function teacherCard() {
    const t = teacher();
    const photo = t.photo_url
      ? el('img', { src: t.photo_url, alt: '', loading: 'lazy', 'data-hide-on-error': true })
      : el('span', { class: 'ag-photo-ph', 'aria-hidden': 'true' }, icon('person-circle'));
    const many = st.teachers.length > 1;
    return el('div', { class: 'ag-card ag-teacher' },
      el('div', { class: 'ag-photo' },
        photo,
        el('span', { class: 'tag tag-live' }, icon('broadcast'), ' En vivo'),
        many ? el('button', { type: 'button', class: 'ag-nav ag-prev', 'aria-label': 'Profesor anterior', onclick: () => pickTeacher(st.idx - 1) }, icon('chevron-left')) : null,
        many ? el('button', { type: 'button', class: 'ag-nav ag-next', 'aria-label': 'Profesor siguiente', onclick: () => pickTeacher(st.idx + 1) }, icon('chevron-right')) : null,
        many ? el('div', { class: 'ag-dots', role: 'tablist', 'aria-label': 'Profesores' },
          ...st.teachers.map((x, i) => el('button', {
            type: 'button', class: `ag-dot${i === st.idx ? ' is-active' : ''}`, role: 'tab', 'aria-selected': String(i === st.idx),
            'aria-label': x.public_name, onclick: () => pickTeacher(i),
          }))) : null),
      el('div', { class: 'ag-teacher-info' },
        el('h3', { translate: 'no' }, t.public_name),
        el('p', { class: 'ag-role' }, icon('person-badge'), ' Profesor/a de yoga'),
        t.bio ? el('p', { class: 'ag-bio', translate: 'no' }, t.bio) : null,
        t.specialties?.length ? el('ul', { class: 'ag-chips', translate: 'no' }, ...t.specialties.map((s) => el('li', {}, s))) : null));
  }

  // ------------------------------------------------------------------ calendario + horarios
  function calendar() {
    const byDay = groupByDay(st.sessions);
    const todayYmd = arDay(today);
    const prevDisabled = st.year === ty && st.month === tm - 1; // no se navega al pasado
    const head = el('div', { class: 'ag-cal-head' },
      el('button', { type: 'button', class: 'ag-cal-nav', 'aria-label': 'Mes anterior', disabled: prevDisabled, onclick: () => goMonth(-1) }, icon('chevron-left')),
      el('strong', { 'aria-live': 'polite' }, monthLabel(st.year, st.month)),
      el('button', { type: 'button', class: 'ag-cal-nav', 'aria-label': 'Mes siguiente', onclick: () => goMonth(1) }, icon('chevron-right')));
    const grid = el('table', { class: 'ag-cal', role: 'grid' },
      el('thead', {}, el('tr', {}, ...WEEKDAYS.map((d) => el('th', { scope: 'col' }, d)))),
      el('tbody', {}, ...monthGrid(st.year, st.month).map((week) => el('tr', {}, ...week.map((c) => {
        if (!c.inMonth) return el('td', {});
        const has = byDay.has(c.ymd);
        const cls = ['ag-day', has ? 'has-sessions' : '', c.ymd === st.day ? 'is-selected' : '', c.ymd === todayYmd ? 'is-today' : ''].filter(Boolean).join(' ');
        return el('td', {}, el('button', {
          type: 'button', class: cls, disabled: !has, 'aria-pressed': has ? String(c.ymd === st.day) : null,
          'aria-label': has ? `${c.day}, con clases` : String(c.day),
          onclick: () => { st.day = c.ymd; st.sessionId = daySessions().find((s) => !isFull(s))?.id ?? daySessions()[0]?.id ?? null; render(); },
        }, String(c.day)));
      })))));
    return el('div', { class: 'ag-cal-wrap' }, head, grid);
  }

  function slots() {
    const list = daySessions();
    if (list.length === 0) {
      return el('p', { class: 'ag-empty', role: 'status' }, st.sessions.length === 0
        ? `Todavía no hay clases agendadas este mes con ${teacher().public_name}.` : 'Elegí un día marcado en el calendario.');
    }
    return el('ul', { class: 'ag-slots', role: 'listbox', 'aria-label': 'Horarios disponibles' }, ...list.map((s) => {
      const full = isFull(s);
      const left = seatsLeft(s);
      const local = localTimeIfDifferent(s.starts_at);
      return el('li', {}, el('button', {
        type: 'button', role: 'option', class: `ag-slot${s.id === st.sessionId ? ' is-selected' : ''}${full ? ' is-full' : ''}`,
        'aria-selected': String(s.id === st.sessionId), disabled: full && !s.mine,
        onclick: () => { st.sessionId = s.id; render(); },
      },
      el('span', { class: 'ag-slot-time' }, arTime(s.starts_at)),
      el('span', { class: 'ag-slot-meta' },
        el('span', { class: 'ag-slot-title', translate: 'no' }, s.title),
        el('small', {}, el('span', {}, levelLabel(s.level)),
          local ? [' · ', el('span', {}, `${local} hora local`)] : null,
          left !== null && !full ? [' · ', el('span', {}, `${left} ${left === 1 ? 'lugar' : 'lugares'}`)] : null)),
      s.mine ? el('span', { class: 'ag-badge' }, icon('check2'), ' Reservada') : full ? el('span', { class: 'ag-badge is-full' }, 'Completa') : null));
    }));
  }

  async function reserve() {
    const s = selected();
    if (!s || st.busy) return;
    if (!auth.isLoggedIn()) return auth.openLogin();
    st.busy = true; render();
    try {
      if (s.mine) { await api.cancelLiveBooking(s.id); notify('Cancelaste tu reserva.', { type: 'info' }); }
      else { await api.bookLiveSession(s.id); notify('¡Listo! Tu lugar está reservado.', { type: 'success' }); }
    } catch (err) { notify(messageFor(err), { type: 'error' }); }
    st.busy = false;
    await loadMonth({ keepDay: true });
  }

  function bookingPanel() {
    const s = selected();
    const full = s && isFull(s) && !s.mine;
    const label = !s ? 'Reservar clase' : s.mine ? 'Cancelar mi reserva' : full ? 'Clase completa' : 'Reservar clase';
    return el('div', { class: 'ag-side' },
      el('h4', {}, 'Horarios disponibles'),
      slots(),
      s ? el('div', { class: 'ag-info' },
        icon(s.mode === 'virtual' ? 'camera-video' : 'broadcast'),
        el('div', {}, el('strong', {}, MODE_LABELS[s.mode] === 'Virtual' ? 'Clase virtual' : 'Clase en vivo'), el('small', {}, `Duración: ${s.duration_minutes} minutos`))) : null,
      el('button', {
        type: 'button', class: `btn ${s?.mine ? 'btn-outline-brand' : 'btn-brand'} w-100 ag-reserve`, disabled: !s || full || st.busy, onclick: reserve,
      }, icon(s?.mine ? 'x-circle' : 'calendar-check'), ` ${label}`));
  }

  function goMonth(delta) {
    ({ year: st.year, month: st.month } = shiftMonth(st.year, st.month, delta));
    st.day = null; st.sessionId = null;
    loadMonth();
  }

  function schedule(failed) {
    const picker = st.teachers.length > 1
      ? el('select', { class: 'ag-select', 'aria-label': 'Profesor', onchange: (e) => pickTeacher(Number(e.target.value)) },
        ...st.teachers.map((t, i) => el('option', { value: i, selected: i === st.idx, translate: 'no' }, t.public_name)))
      : null;
    return el('div', { class: 'ag-card ag-schedule' },
      el('div', { class: 'ag-schedule-head' }, el('h3', {}, icon('calendar3'), ' Agendar clase en vivo'), picker),
      failed ? el('p', { class: 'ag-empty', role: 'alert' }, messageFor(failed)) : null,
      el('div', { class: 'ag-schedule-body' }, calendar(), bookingPanel()),
      el('p', { class: 'ag-tz' }, icon('calendar-event'), ' Las clases en vivo se dictan en horario de Argentina (GMT-3).'));
  }

  function render(failed = null) {
    if (st.teachers.length === 0) return;
    // Se conserva el foco del botón activo (el teclado no se pierde al redibujar).
    const focused = document.activeElement?.className && root.contains(document.activeElement) ? document.activeElement : null;
    const key = focused ? { cls: focused.className, label: focused.getAttribute('aria-label'), text: focused.textContent } : null;
    mount(root, el('div', { class: 'ag-layout' }, teacherCard(), schedule(failed)));
    if (key) {
      const candidates = [...root.querySelectorAll('button, select')].filter((n) => n.className === key.cls && n.getAttribute('aria-label') === key.label && n.textContent === key.text);
      candidates[0]?.focus?.();
    }
  }

  auth.onChange?.(() => { if (st.teachers.length) loadMonth({ keepDay: true }); });
  loadTeachers();
  return { reload: loadTeachers, state: st };
}
