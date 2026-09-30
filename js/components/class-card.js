import { el, icon } from '../lib/dom.js';
import { formatMinutes, formatClock, levelLabel, percent } from '../lib/format.js';
import { page } from '../lib/env.js';

/**
 * Tarjeta de clase con el mismo marcado que las de la home (.video-card), más:
 * barra de avance, marca de "vista", candado si la clase es restringida y etiqueta de "continuar".
 * @param {object} c  fila de classes (o {id,title,thumbnail_url,duration_seconds,level,category,access_level})
 * @param {{progress?: {progress_seconds:number, completed:boolean}, cont?: boolean, col?: string}} [opts]
 */
export function classCard(c, { progress, cont = false, col = 'col-lg-4 col-md-6' } = {}) {
  const pct = progress ? percent(progress.progress_seconds, c.duration_seconds) : 0;
  const media = c.thumbnail_url
    ? el('img', { src: c.thumbnail_url, alt: '', loading: 'lazy', 'data-hide-on-error': true })
    : el('span', { class: 'video-card-ph', 'aria-hidden': 'true' }, icon('flower1'));

  const label = c.category || levelLabel(c.level);
  const link = el('a', { class: 'video-card', href: `${page('clase.html')}?id=${encodeURIComponent(c.id)}`, 'aria-label': `${c.title}${c.duration_seconds ? `, ${formatMinutes(c.duration_seconds)}` : ''}` },
    media,
    cont ? el('span', { class: 'tag tag-mint' }, `Continuar · ${formatClock(progress.progress_seconds)}`) : null,
    !cont && progress?.completed ? el('span', { class: 'tag tag-light' }, icon('check2'), ' Vista') : null,
    c.access_level === 'restricted' ? el('span', { class: 'video-lock', title: 'Contenido restringido' }, icon('lock-fill')) : null,
    el('span', { class: 'play' }, icon('play-fill')),
    c.duration_seconds ? el('span', { class: 'duration' }, formatMinutes(c.duration_seconds)) : null,
    el('div', { class: 'video-info' }, el('small', {}, label), el('h3', {}, c.title)),
    pct > 0 && !progress?.completed ? el('span', { class: 'video-progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': `${pct}% visto` },
      Object.assign(el('span', {}), { style: `width:${pct}%` })) : null);
  return el('article', { class: col }, link);
}
