import * as session from '../lib/session.js';
import { supabase } from '../lib/supabase.js';
import { getClass, getPlayback, listPublishedClasses, saveProgress, saveProgressOnUnload } from '../lib/api.js';
import { AppError, messageFor } from '../lib/errors.js';
import { formatClock, formatMinutes, isUuid, levelLabel, percent } from '../lib/format.js';
import { cfg, page } from '../lib/env.js';
import { el, icon, mount } from '../lib/dom.js';
import { boot } from '../ui/boot.js';
import { openAuth } from '../ui/auth-modal.js';
import { toast } from '../ui/toast.js';
import { VideoPlayer } from '../components/video-player.js';
import { ProgressReporter } from '../lib/progress-reporter.js';
import { classCard } from '../components/class-card.js';

/**
 * Detalle de clase + reproductor de un video.
 * Estados del escenario: cargando · sin sesión · sin acceso · video en preparación · no encontrada · error · reproduciendo.
 * El permiso lo decide SIEMPRE la función `playback` en el servidor; aquí solo se muestra el resultado.
 */
const stage = document.getElementById('stage');
const info = document.getElementById('info');
const side = document.getElementById('side');
const classId = new URLSearchParams(location.search).get('id');

let player = null;
let reporter = null;
let seekTimer = null;

const $gate = ({ ico, title, text, action }) =>
  mount(stage, el('div', { class: 'clase-gate', role: 'status' }, icon(ico), el('h2', { class: 'h5 text-white m-0' }, title), text ? el('p', {}, text) : null, action));

const goVideoteca = () => el('a', { class: 'btn btn-outline-light-pill btn-sm', href: page('videoteca.html') }, 'Ver otras clases');

function stopPlayer() {
  clearTimeout(seekTimer);
  reporter?.flush('unload');
  player?.destroy();
  player = null;
  reporter = null;
}

function renderInfo(c, resume) {
  document.title = `${c.title} · Yoga Pop Up`;
  const tags = [
    el('span', { class: 'tag tag-light', style: 'position:static' }, levelLabel(c.level)),
    c.category ? el('span', { class: 'tag tag-mint', style: 'position:static' }, c.category) : null,
    c.duration_seconds ? el('span', { class: 'tag tag-light', style: 'position:static' }, formatMinutes(c.duration_seconds)) : null,
  ];
  mount(info,
    el('h1', { class: 'clase-title' }, c.title),
    el('div', { class: 'clase-meta' }, ...tags),
    resume > 0 && c.duration_seconds
      ? el('p', { class: 'text-muted' }, icon('clock-history'), ` Llevas ${percent(resume, c.duration_seconds)} % · retomas en ${formatClock(resume)}`) : null,
    c.description ? el('p', { class: 'clase-desc' }, c.description) : null);
}

async function renderMore() {
  try {
    const others = (await listPublishedClasses({ limit: 4 })).filter((x) => x.id !== classId).slice(0, 3);
    if (others.length === 0) return;
    mount(side, el('h2', { class: 'yp-block-title' }, 'Más clases'), ...others.map((c) => classCard(c, { col: 'col-12' })));
  } catch { /* sección opcional */ }
}

function mountPlayer(cls, pb) {
  const durationHint = pb.duration_seconds ?? cls.duration_seconds ?? 0;
  reporter = new ProgressReporter({
    save: (s) => saveProgress(classId, s),
    saveOnUnload: (s) => saveProgressOnUnload(classId, s),
    initialSeconds: pb.resume_seconds > 0 ? pb.resume_seconds : null,
    intervalMs: cfg.PROGRESS_INTERVAL_SECONDS * 1000,
    onError: (err, n) => {
      console.warn('No se pudo guardar el progreso:', err?.message);
      if (n === 3) toast('No estamos pudiendo guardar tu progreso. Comprueba tu conexión.', { type: 'error' });
    },
  });
  player = new VideoPlayer(stage, {
    title: cls.title,
    poster: cls.thumbnail_url || undefined,
    resumeAt: pb.resume_seconds,
    durationHint,
    source: { url: pb.video_url, expiresAt: pb.expires_at },
    // La URL firmada vence: el reproductor pide otra al servidor (que vuelve a comprobar el permiso).
    getSource: async () => {
      const fresh = await getPlayback(classId);
      return { url: fresh.video_url, expiresAt: fresh.expires_at };
    },
    onTime: (t, d, playing) => reporter?.update(t, d, playing),
    onPause: () => reporter?.flush('pause'),
    onSeek: () => { clearTimeout(seekTimer); seekTimer = setTimeout(() => reporter?.flush('seek'), 1500); },
    onEnded: () => reporter?.flush('ended'),
  });
}

async function start() {
  stopPlayer();
  if (!isUuid(classId)) return $gate({ ico: 'question-circle', title: 'No encontramos esta clase', action: goVideoteca() });
  if (!supabase) return $gate({ ico: 'gear', title: 'Falta configurar Supabase', text: 'Completa js/config.js para ver las clases.' });

  mount(stage, el('div', { class: 'clase-gate', role: 'status', 'aria-label': 'Cargando' }, el('span', { class: 'spinner-border text-light mx-auto' })));

  let cls;
  try {
    cls = await getClass(classId);
  } catch (err) {
    return $gate({ ico: 'exclamation-triangle', title: 'No pudimos cargar la clase', text: messageFor(err),
      action: el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: start }, icon('arrow-repeat'), ' Reintentar') });
  }
  if (!cls) return $gate({ ico: 'question-circle', title: 'No encontramos esta clase', text: 'Puede que ya no esté disponible.', action: goVideoteca() });
  renderInfo(cls, 0);
  renderMore();

  if (!session.isLoggedIn()) {
    return $gate({ ico: 'lock', title: 'Inicia sesión para ver esta clase', text: 'Es gratis crear tu cuenta y retomar donde lo dejaste.',
      action: el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: () => openAuth({ message: 'Necesitas una cuenta para ver las clases.' }) }, 'Iniciar sesión o crear cuenta') });
  }

  try {
    const pb = await getPlayback(classId);
    renderInfo(cls, pb.resume_seconds);
    mountPlayer(cls, pb);
  } catch (err) {
    const code = err instanceof AppError ? err.code : '';
    if (code === 'no_access') return $gate({ ico: 'lock-fill', title: 'Esta clase no está incluida en tu acceso', text: 'Es un contenido restringido. Explora las clases disponibles para ti.', action: goVideoteca() });
    if (code === 'video_not_ready') return $gate({ ico: 'hourglass-split', title: 'Estamos preparando este video', text: 'Vuelve en unos minutos.', action: el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: start }, 'Comprobar de nuevo') });
    if (code === 'class_not_found') return $gate({ ico: 'question-circle', title: 'No encontramos esta clase', action: goVideoteca() });
    if (code === 'unauthenticated') return $gate({ ico: 'lock', title: 'Tu sesión venció', text: 'Inicia sesión de nuevo para continuar.', action: el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: () => openAuth() }, 'Iniciar sesión') });
    $gate({ ico: 'exclamation-triangle', title: 'No pudimos preparar el video', text: messageFor(err),
      action: el('button', { type: 'button', class: 'btn btn-brand btn-sm', onclick: start }, icon('arrow-repeat'), ' Reintentar') });
  }
}

// Guardado al ocultar o cerrar la pestaña (y al navegar a otra página): keepalive, sobrevive al cierre.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reporter?.flush('hidden'); });
window.addEventListener('pagehide', () => reporter?.flush('unload'));

await boot('videoteca');
// Solo cambios reales de usuario reinician la página (no el refresco de token ni el foco de la pestaña).
session.onChange((_s, event) => { if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') start(); });
await start();
