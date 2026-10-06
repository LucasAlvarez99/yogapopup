/**
 * Lógica PURA de la agenda de clases en vivo (sin DOM ni red): calendario, horarios en hora de Argentina y validación
 * del formulario de una clase. Se prueba en Deno (tests/web/agenda.test.js).
 *
 * Zona horaria: las clases se dictan en horario de Argentina (GMT-3, sin horario de verano). La base guarda el instante
 * exacto (timestamptz); acá se muestra SIEMPRE en hora argentina, y si el navegador está en otra zona se avisa la hora local.
 */
import { AppError } from './errors.js';

export const AR_TZ = 'America/Argentina/Buenos_Aires';
const AR_OFFSET = '-03:00';
export const AR_OFFSET_HOURS = 3;

export const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
/** Semana que empieza en lunes (como la referencia de diseño). */
export const WEEKDAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
export const SESSION_LEVELS = ['principiante', 'intermedio', 'avanzado', 'todos'];
export const SESSION_MODES = ['live', 'virtual'];
export const MODE_LABELS = { live: 'En vivo', virtual: 'Virtual' };

const pad = (n) => String(n).padStart(2, '0');
const toDate = (v) => (v instanceof Date ? v : new Date(v));

function partsIn(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(toDate(date));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return { y: get('year'), m: get('month'), d: get('day'), hh: get('hour'), mm: get('minute') };
}

/** "2026-09-24" del día en que cae el instante, EN HORA ARGENTINA. */
export function arDay(date) {
  const p = partsIn(date, AR_TZ);
  return `${p.y}-${p.m}-${p.d}`;
}
/** "18:30" en hora argentina. */
export function arTime(date) {
  const p = partsIn(date, AR_TZ);
  return `${p.hh}:${p.mm}`;
}
/** Hora local del navegador ("21:30") SOLO si difiere de la argentina; si es la misma, null. */
export function localTimeIfDifferent(date, localZone = undefined) {
  const p = partsIn(date, localZone);
  const local = `${p.hh}:${p.mm}`;
  const ar = arTime(date);
  const sameDay = `${p.y}-${p.m}-${p.d}` === arDay(date);
  if (local === ar && sameDay) return null;
  return sameDay ? local : `${local} (${p.d}/${p.m})`;
}

/** Instante en que empieza el día `y-m-d` en Argentina (medianoche GMT-3). m = 0..11. */
export const arMidnight = (y, m, d = 1) => new Date(Date.UTC(y, m, d, AR_OFFSET_HOURS, 0, 0));

/** Rango [from, to) de un mes calendario, en instantes ISO, para pedirle a la base. */
export function monthRange(year, month) {
  return { from: arMidnight(year, month, 1).toISOString(), to: arMidnight(year, month + 1, 1).toISOString() };
}

export const monthLabel = (year, month) => `${MONTHS[month]} ${year}`;
export function shiftMonth(year, month, delta) {
  const t = year * 12 + month + delta;
  return { year: Math.floor(t / 12), month: ((t % 12) + 12) % 12 };
}

/**
 * Grilla del mes: filas de 7 celdas (lunes a domingo). Las celdas de otros meses vienen con `inMonth: false`
 * y los días del mes con su "YYYY-MM-DD".
 */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // lunes = 0
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push({ inMonth: false });
  for (let d = 1; d <= days; d++) cells.push({ inMonth: true, day: d, ymd: `${year}-${pad(month + 1)}-${pad(d)}` });
  while (cells.length % 7 !== 0) cells.push({ inMonth: false });
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Agrupa las clases por día argentino y las ordena por hora. @returns {Map<string, object[]>} */
export function groupByDay(sessions) {
  const map = new Map();
  for (const s of [...sessions].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))) {
    const key = arDay(s.starts_at);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

/** Lugares libres: null = sin cupo (ilimitado). */
export function seatsLeft(s) {
  if (s.capacity === null || s.capacity === undefined) return null;
  return Math.max(0, Number(s.capacity) - Number(s.booked ?? 0));
}
export const isFull = (s) => seatsLeft(s) === 0;

/** Primer día del mes en `sessions` con alguna clase (para abrir el calendario ya posicionado). */
export function firstDayWithSessions(sessions) {
  const days = [...groupByDay(sessions).keys()].sort();
  return days[0] ?? null;
}

// ------------------------------------------------------------------ formulario de una clase (profesor/admin)
/** "2026-09-24" + "18:30" (hora argentina) -> instante ISO. null si no es una fecha/hora real. */
export function arToIso(dateStr, timeStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr ?? '') || !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr ?? '')) return null;
  const d = new Date(`${dateStr}T${timeStr}:00${AR_OFFSET}`);
  if (Number.isNaN(d.getTime())) return null;
  return arDay(d) === dateStr ? d.toISOString() : null; // descarta "2026-02-30": JS lo corre al mes siguiente
}
/** ISO -> { date: "2026-09-24", time: "18:30" } en hora argentina (para rellenar el formulario al editar). */
export const isoToArFields = (iso) => ({ date: arDay(iso), time: arTime(iso) });

const intOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  return /^\d+$/.test(s) ? Number(s) : NaN;
};

/**
 * Valida el formulario y arma lo que se manda a la base. Lanza AppError('invalid_input', mensaje claro) si algo está mal.
 * @param {{title:string,date:string,time:string,level:string,mode:string,duration:string|number,capacity:string|number,is_published?:boolean}} f
 * @param {{ now?: Date, allowPast?: boolean }} [opts]
 */
export function buildSessionInput(f, { now = new Date(), allowPast = false } = {}) {
  const bad = (msg) => { throw new AppError('invalid_input', msg); };
  const title = String(f.title ?? '').trim();
  if (!title) bad('El título es obligatorio.');
  if (title.length > 100) bad('El título admite hasta 100 caracteres.');
  if (!SESSION_LEVELS.includes(f.level)) bad('Elegí un nivel válido.');
  if (!SESSION_MODES.includes(f.mode)) bad('Elegí si la clase es en vivo o virtual.');
  const starts_at = arToIso(f.date, f.time);
  if (!starts_at) bad('Elegí una fecha y una hora válidas (hora de Argentina).');
  if (!allowPast && new Date(starts_at) <= now) bad('La clase tiene que ser en el futuro.');
  const duration = intOrNull(f.duration ?? 60);
  if (duration === null || Number.isNaN(duration) || duration < 15 || duration > 240) bad('La duración debe estar entre 15 y 240 minutos.');
  const capacity = intOrNull(f.capacity);
  if (Number.isNaN(capacity) || (capacity !== null && (capacity < 1 || capacity > 500))) bad('El cupo debe ser un número entre 1 y 500, o quedar vacío si no hay límite.');
  return {
    title, level: f.level, mode: f.mode, starts_at, duration_minutes: duration, capacity,
    is_published: f.is_published !== false,
  };
}

/** Especialidades: "Hatha, Vinyasa , Yoga Flow" -> ['Hatha','Vinyasa','Yoga Flow'] (máx. 8, sin repetidas, 30 caracteres c/u). */
export function parseSpecialties(text) {
  const out = [];
  for (const raw of String(text ?? '').split(',')) {
    const s = raw.trim().slice(0, 30);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out.slice(0, 8);
}

/** Valida el perfil público del profesor. */
export function buildTeacherProfileInput({ public_name, bio, specialties }) {
  const name = String(public_name ?? '').trim();
  if (!name) throw new AppError('invalid_input', 'El nombre es obligatorio.');
  if (name.length > 80) throw new AppError('invalid_input', 'El nombre admite hasta 80 caracteres.');
  const b = String(bio ?? '').trim();
  if (b.length > 600) throw new AppError('invalid_input', 'La presentación admite hasta 600 caracteres.');
  return { public_name: name, bio: b || null, specialties: parseSpecialties(specialties) };
}
