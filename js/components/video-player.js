import { el, icon } from '../lib/dom.js';
import { formatClock } from '../lib/format.js';
import { messageFor } from '../lib/errors.js';

/**
 * Reproductor de YogaPop Up sobre <video>, con controles propios y el estilo de la web.
 *
 *  - Los videos se sirven directo desde Cloudflare R2: progresivos (sin adaptación de
 *    calidad), con soporte de Range requests nativo del navegador para buscar/adelantar.
 *    Si algún día una fuente sí es HLS (.m3u8), se sigue reproduciendo con hls.js o el
 *    HLS nativo de Safari, con selector de calidad.
 *  - Retoma desde `resumeAt` (con opción "Empezar de cero").
 *  - Velocidad, volumen, pantalla completa, teclado.
 *  - La URL firmada vence: se renueva sola antes de que ocurra (y si el servidor responde 401/403).
 *
 * El reproductor NO sabe nada de Supabase ni de R2: recibe la fuente ya resuelta y una función
 * `getSource()` para renovarla. Avisa de lo que pasa con callbacks (onTime, onPause, onSeek, onEnded).
 */

const SPEEDS = [0.75, 1, 1.25, 1.5];
const SEEK_STEP = 10;
const IDLE_MS = 2800;
const SEEK_RANGE = 1000;

/** R2 sirve archivos progresivos (mp4); esto es por si alguna vez una fuente sí es HLS. */
function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(url);
}

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`yp-${key}`);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`yp-${key}`, JSON.stringify(value)); } catch { /* modo privado */ }
  },
};

export class VideoPlayer {
  #o; #root; #video; #hls = null; #ui = {};
  #idleTimer = null; #refreshTimer = null; #refreshing = null;
  #expiresAt = 0; #scrubbing = false; #started = false; #destroyed = false;
  #errors = { network: 0, media: 0, auth: 0, since: 0 };
  #bound = [];

  /**
   * @param {HTMLElement} container
   * @param {object} options
   * @param {{url:string, expiresAt:number}} options.source   fuente inicial (URL firmada)
   * @param {() => Promise<{url:string, expiresAt:number}>} options.getSource   renueva la URL firmada
   * @param {string} [options.title]
   * @param {string} [options.poster]
   * @param {number} [options.resumeAt]      segundos donde retomar
   * @param {number} [options.durationHint]  duración conocida (se usa hasta que el video informa la real)
   * @param {(time:number, duration:number, playing:boolean) => void} [options.onTime]
   * @param {() => void} [options.onPause]
   * @param {() => void} [options.onSeek]
   * @param {() => void} [options.onEnded]
   * @param {object} [options.Hls]           inyectable (por defecto window.Hls)
   */
  constructor(container, options) {
    this.#o = { resumeAt: 0, Hls: window.Hls, ...options };
    this.#build(container);
    this.#bindMedia();
    this.#bindUi();
    this.#attach(this.#o.source.url, this.#o.resumeAt);
    this.#expiresAt = this.#o.source.expiresAt;
    this.#scheduleRefresh();
  }

  // ------------------------------------------------------------------ API pública
  get element() { return this.#root; }
  get video() { return this.#video; }
  get currentTime() { return this.#video.currentTime || 0; }
  get duration() { return this.#duration(); }
  get playing() { return !this.#video.paused && !this.#video.ended; }

  play() { return this.#video.play().catch(() => this.#setState('paused')); }
  pause() { this.#video.pause(); }
  seek(seconds) {
    const d = this.#duration();
    this.#video.currentTime = Math.max(0, d ? Math.min(seconds, d) : seconds);
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#refreshTimer);
    for (const [target, type, fn, opts] of this.#bound) target.removeEventListener(type, fn, opts);
    this.#hls?.destroy();
    this.#hls = null;
    this.#video.removeAttribute('src');
    this.#video.load();
    this.#root.remove();
  }

  // ------------------------------------------------------------------ construcción del DOM
  #build(container) {
    const btn = (cls, label, ic, onclick) =>
      el('button', { type: 'button', class: `yp-btn ${cls}`, 'aria-label': label, title: label, onclick }, icon(ic));

    const ui = this.#ui;
    this.#video = el('video', {
      class: 'yp-video', playsinline: true, preload: 'metadata', poster: this.#o.poster || null,
      'aria-label': this.#o.title || 'Video de la clase',
    });

    ui.big = el('button', { type: 'button', class: 'yp-bigplay', 'aria-label': 'Reproducir' }, icon('play-fill'));
    ui.spinner = el('div', { class: 'yp-spinner', role: 'status', 'aria-label': 'Cargando' }, el('span', { class: 'spinner-border' }));
    ui.errorMsg = el('p', { class: 'yp-error-msg' });
    ui.retry = el('button', { type: 'button', class: 'btn btn-brand btn-sm' }, icon('arrow-repeat'), ' Reintentar');
    ui.error = el('div', { class: 'yp-error', role: 'alert' }, icon('exclamation-triangle', 'yp-error-ico'), ui.errorMsg, ui.retry);
    ui.resumeTxt = el('span', {});
    ui.restart = el('button', { type: 'button', class: 'yp-link' }, 'Empezar de cero');
    ui.resume = el('div', { class: 'yp-resume' }, icon('clock-history'), ui.resumeTxt, ui.restart);

    ui.buffered = el('div', { class: 'yp-buffered' });
    ui.played = el('div', { class: 'yp-played' });
    ui.seek = el('input', {
      type: 'range', class: 'yp-seek', min: 0, max: SEEK_RANGE, step: 1, value: 0, 'aria-label': 'Posición del video', disabled: true,
    });
    const seekwrap = el('div', { class: 'yp-seekwrap' }, el('div', { class: 'yp-track' }, ui.buffered, ui.played), ui.seek);

    ui.play = btn('yp-play', 'Reproducir', 'play-fill', () => this.#toggle());
    const back = btn('yp-back', `Retroceder ${SEEK_STEP} segundos`, 'arrow-counterclockwise', () => this.seek(this.currentTime - SEEK_STEP));
    const fwd = btn('yp-fwd', `Adelantar ${SEEK_STEP} segundos`, 'arrow-clockwise', () => this.seek(this.currentTime + SEEK_STEP));
    ui.mute = btn('yp-mute', 'Silenciar', 'volume-up-fill', () => this.#toggleMute());
    ui.volume = el('input', { type: 'range', class: 'yp-volume', min: 0, max: 1, step: 0.05, value: 1, 'aria-label': 'Volumen' });
    ui.cur = el('span', { class: 'yp-cur' }, '0:00');
    ui.dur = el('span', { class: 'yp-dur' }, '0:00');
    const time = el('span', { class: 'yp-time' }, ui.cur, ' / ', ui.dur);

    ui.speedBtn = el('button', { type: 'button', class: 'yp-btn yp-text-btn', 'aria-label': 'Velocidad', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, '1×');
    ui.speedMenu = el('div', { class: 'yp-menu', role: 'menu', hidden: true });
    ui.qualityBtn = el('button', { type: 'button', class: 'yp-btn yp-text-btn', 'aria-label': 'Calidad', 'aria-haspopup': 'true', 'aria-expanded': 'false', hidden: true },
      icon('gear-fill'), ui.qualityLabel = el('span', { class: 'yp-qlabel' }, 'Auto'));
    ui.qualityMenu = el('div', { class: 'yp-menu yp-menu-quality', role: 'menu', hidden: true });
    ui.full = btn('yp-full', 'Pantalla completa', 'fullscreen', () => this.#toggleFullscreen());

    const bar = el('div', { class: 'yp-bar' },
      el('div', { class: 'yp-left' }, ui.play, back, fwd, el('div', { class: 'yp-vol' }, ui.mute, ui.volume), time),
      el('div', { class: 'yp-right' },
        el('div', { class: 'yp-menuwrap' }, ui.speedBtn, ui.speedMenu),
        el('div', { class: 'yp-menuwrap' }, ui.qualityBtn, ui.qualityMenu),
        ui.full));

    this.#root = el('div', { class: 'yp-player', tabindex: 0, 'data-state': 'loading', role: 'group', 'aria-label': `Reproductor: ${this.#o.title || 'clase'}` },
      this.#video, ui.spinner, ui.big, ui.resume, ui.error, el('div', { class: 'yp-controls' }, seekwrap, bar));
    container.replaceChildren(this.#root);

    for (const s of SPEEDS) {
      ui.speedMenu.append(this.#menuItem(`${s}×`, s === 1, () => { this.#setRate(s); this.#closeMenus(); }, s));
    }
    this.#video.volume = store.get('volume', 1);
    this.#video.muted = store.get('muted', false);
    ui.volume.value = String(this.#video.muted ? 0 : this.#video.volume);
    this.#setRate(store.get('rate', 1), false);
    this.#syncVolumeIcon();

    const hint = this.#o.durationHint;
    if (hint) ui.dur.textContent = formatClock(hint);
    if (this.#o.resumeAt >= 5) {
      ui.resumeTxt.textContent = `Continuás en ${formatClock(this.#o.resumeAt)}`;
      ui.resume.hidden = false;
    } else ui.resume.hidden = true;
    ui.error.hidden = true;
  }

  #menuItem(label, checked, onclick, value) {
    return el('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(checked), class: 'yp-menu-item', dataset: { value: String(value ?? label) }, onclick }, label);
  }

  // ------------------------------------------------------------------ eventos
  #on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.#bound.push([target, type, fn, opts]);
  }

  #bindMedia() {
    const v = this.#video;
    this.#on(v, 'loadedmetadata', () => { this.#syncTime(); this.#ui.seek.disabled = false; if (this.#state() === 'loading') this.#setState('paused'); });
    this.#on(v, 'durationchange', () => this.#syncTime());
    this.#on(v, 'timeupdate', () => { this.#syncTime(); this.#o.onTime?.(this.currentTime, this.#duration(), this.playing); });
    this.#on(v, 'progress', () => this.#syncBuffered());
    this.#on(v, 'play', () => { this.#started = true; this.#ui.resume.hidden = true; });
    this.#on(v, 'playing', () => { this.#setState('playing'); this.#armIdle(); });
    this.#on(v, 'pause', () => { if (v.ended) return; this.#setState('paused'); this.#showControls(); this.#o.onPause?.(); });
    this.#on(v, 'waiting', () => { if (!v.paused) this.#root.classList.add('yp-buffering'); });
    this.#on(v, 'canplay', () => this.#root.classList.remove('yp-buffering'));
    this.#on(v, 'playing', () => this.#root.classList.remove('yp-buffering'));
    this.#on(v, 'seeked', () => this.#o.onSeek?.());
    this.#on(v, 'ended', () => { this.#setState('ended'); this.#showControls(); this.#o.onEnded?.(); });
    this.#on(v, 'volumechange', () => this.#syncVolumeIcon());
    this.#on(v, 'error', () => { if (!this.#hls) this.#handleVideoError(); });
  }

  #bindUi() {
    const ui = this.#ui;
    this.#on(ui.big, 'click', () => (this.#state() === 'ended' ? (this.seek(0), this.play()) : this.play()));
    this.#on(ui.retry, 'click', () => this.#retry());
    this.#on(ui.restart, 'click', () => { this.seek(0); ui.resume.hidden = true; this.play(); });
    this.#on(this.#video, 'click', () => {
      if (this.#root.classList.contains('yp-idle')) return this.#showControls();
      this.#toggle();
    });
    this.#on(this.#video, 'dblclick', () => this.#toggleFullscreen());

    this.#on(ui.seek, 'pointerdown', () => { this.#scrubbing = true; });
    this.#on(ui.seek, 'input', () => {
      const d = this.#duration();
      if (!d) return;
      const t = (Number(ui.seek.value) / SEEK_RANGE) * d;
      ui.cur.textContent = formatClock(t);
      ui.played.style.width = `${(Number(ui.seek.value) / SEEK_RANGE) * 100}%`;
    });
    this.#on(ui.seek, 'change', () => {
      const d = this.#duration();
      this.#scrubbing = false;
      if (d) this.seek((Number(ui.seek.value) / SEEK_RANGE) * d);
    });
    this.#on(ui.volume, 'input', () => {
      const v = Number(ui.volume.value);
      this.#video.volume = v;
      this.#video.muted = v === 0;
      store.set('volume', v || store.get('volume', 1));
      store.set('muted', this.#video.muted);
    });

    this.#on(ui.speedBtn, 'click', (e) => { e.stopPropagation(); this.#toggleMenu('speed'); });
    this.#on(ui.qualityBtn, 'click', (e) => { e.stopPropagation(); this.#toggleMenu('quality'); });
    this.#on(document, 'click', () => this.#closeMenus());
    this.#on(document, 'fullscreenchange', () => this.#syncFullscreen());
    this.#on(document, 'webkitfullscreenchange', () => this.#syncFullscreen());

    this.#on(this.#root, 'pointermove', () => this.#showControls());
    this.#on(this.#root, 'focusin', () => this.#showControls());
    this.#on(this.#root, 'keydown', (e) => this.#onKey(e));

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: this.#o.title || 'Yoga Pop Up', artist: 'Yoga Pop Up' });
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('seekbackward', () => this.seek(this.currentTime - SEEK_STEP));
        navigator.mediaSession.setActionHandler('seekforward', () => this.seek(this.currentTime + SEEK_STEP));
      } catch { /* no soportado */ }
    }
  }

  #onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const onRange = e.target instanceof HTMLInputElement && e.target.type === 'range';
    const k = e.key.toLowerCase();
    const handled = () => { e.preventDefault(); this.#showControls(); };
    if (k === ' ' || k === 'k') { if (e.target instanceof HTMLButtonElement) return; handled(); return this.#toggle(); }
    if (k === 'm') { handled(); return this.#toggleMute(); }
    if (k === 'f') { handled(); return this.#toggleFullscreen(); }
    if (onRange) return; // en las barras deslizantes, las flechas conservan su función nativa
    if (k === 'arrowright' || k === 'l') { handled(); return this.seek(this.currentTime + SEEK_STEP); }
    if (k === 'arrowleft' || k === 'j') { handled(); return this.seek(this.currentTime - SEEK_STEP); }
    if (k === 'arrowup') { handled(); this.#video.volume = Math.min(1, this.#video.volume + 0.05); this.#video.muted = false; }
    if (k === 'arrowdown') { handled(); this.#video.volume = Math.max(0, this.#video.volume - 0.05); }
  }

  // ------------------------------------------------------------------ fuente del video
  #attach(url, startAt) {
    const Hls = this.#o.Hls;
    const v = this.#video;
    if (isHlsUrl(url) && Hls && Hls.isSupported()) {
      this.#hls?.destroy();
      const hls = new Hls({
        startPosition: startAt > 0 ? startAt : -1,
        capLevelToPlayerSize: true, // no descarga más resolución de la que el reproductor puede mostrar (ahorra tráfico)
        maxBufferLength: 40,
      });
      this.#hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => this.#buildQuality(hls));
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this.#syncQualityLabel());
      hls.on(Hls.Events.ERROR, (_e, data) => this.#onHlsError(data));
      hls.attachMedia(v);
      hls.loadSource(url);
    } else if (isHlsUrl(url) && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; // HLS nativo (Safari en iPhone): sin selector de calidad
      if (startAt > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt; }, { once: true });
    } else {
      // R2: archivo progresivo (mp4). El navegador reproduce con Range requests, sin hls.js.
      v.src = url;
      if (startAt > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt; }, { once: true });
    }
  }

  /** Video progresivo (sin hls.js): reintenta renovando la URL firmada antes de rendirse. */
  #handleVideoError() {
    if (this.#destroyed) return;
    const now = Date.now();
    if (now - this.#errors.since > 60_000) this.#errors = { network: 0, media: 0, auth: 0, since: now };
    if (++this.#errors.auth <= 2) return void this.#refreshSource();
    this.#showError('No pudimos reproducir el video. Revisá tu conexión e intentá de nuevo.');
  }

  #onHlsError(data) {
    if (!data.fatal || this.#destroyed) return;
    const Hls = this.#o.Hls;
    const now = Date.now();
    if (now - this.#errors.since > 60_000) this.#errors = { network: 0, media: 0, auth: 0, since: now };
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      const code = data.response?.code;
      if ([401, 403, 410].includes(code)) { // la URL firmada venció o fue rechazada
        if (++this.#errors.auth <= 2) return void this.#refreshSource();
      } else if (++this.#errors.network <= 3) {
        return void this.#hls.startLoad();
      }
    } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && ++this.#errors.media <= 2) {
      return void this.#hls.recoverMediaError();
    }
    this.#showError('No pudimos reproducir el video. Revisá tu conexión e intentá de nuevo.');
  }

  /** Pide una URL firmada nueva y sigue reproduciendo desde el mismo punto, sin cortar la sesión. */
  #refreshSource() {
    this.#refreshing ??= (async () => {
      try {
        const src = await this.#o.getSource();
        if (this.#destroyed) return;
        const t = this.currentTime;
        const wasPlaying = this.playing;
        this.#expiresAt = src.expiresAt;
        this.#scheduleRefresh();
        if (this.#hls) {
          this.#hls.config.startPosition = t; // vuelve a cargar desde la posición actual, no desde el principio
          this.#hls.loadSource(src.url);
        } else {
          this.#video.src = src.url;
          this.#video.currentTime = t;
        }
        if (wasPlaying) this.play();
        this.#hideError();
      } catch (err) {
        if (!this.#destroyed) this.#showError(messageFor(err));
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }

  #scheduleRefresh() {
    clearTimeout(this.#refreshTimer);
    if (!this.#expiresAt) return;
    const left = this.#expiresAt * 1000 - Date.now();
    const wait = Math.max(5000, left - Math.min(5 * 60_000, left * 0.25)); // 5 min antes (o el 25 % final)
    this.#refreshTimer = setTimeout(() => this.#refreshSource(), wait);
  }

  #retry() {
    this.#hideError();
    this.#setState('loading');
    this.#errors = { network: 0, media: 0, auth: 0, since: 0 };
    this.#refreshSource();
  }

  // ------------------------------------------------------------------ calidad y velocidad
  #buildQuality(hls) {
    const ui = this.#ui;
    const levels = hls.levels.map((l, index) => ({ index, height: l.height })).filter((l) => l.height)
      .sort((a, b) => b.height - a.height);
    if (levels.length < 2) { ui.qualityBtn.hidden = true; return; }
    ui.qualityMenu.replaceChildren(
      this.#menuItem('Automática', true, () => this.#setQuality(-1), -1),
      ...levels.map((l) => this.#menuItem(`${l.height}p`, false, () => this.#setQuality(l.index), l.index)),
    );
    ui.qualityBtn.hidden = false;
  }

  #setQuality(index) {
    if (!this.#hls) return;
    this.#hls.currentLevel = index; // -1 = automática
    for (const item of this.#ui.qualityMenu.children) item.setAttribute('aria-checked', String(item.dataset.value === String(index)));
    this.#syncQualityLabel();
    this.#closeMenus();
  }

  #syncQualityLabel() {
    const hls = this.#hls;
    if (!hls) return;
    const cur = hls.levels[hls.currentLevel];
    this.#ui.qualityLabel.textContent = hls.autoLevelEnabled ? (cur?.height ? `Auto · ${cur.height}p` : 'Auto') : `${cur?.height ?? ''}p`;
  }

  #setRate(rate, persist = true) {
    this.#video.playbackRate = rate;
    this.#ui.speedBtn.textContent = `${rate}×`;
    for (const item of this.#ui.speedMenu.children) item.setAttribute('aria-checked', String(Number(item.dataset.value) === rate));
    if (persist) store.set('rate', rate);
  }

  #toggleMenu(which) {
    const menu = which === 'speed' ? this.#ui.speedMenu : this.#ui.qualityMenu;
    const btn = which === 'speed' ? this.#ui.speedBtn : this.#ui.qualityBtn;
    const open = menu.hidden;
    this.#closeMenus();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  }

  #closeMenus() {
    for (const [m, b] of [[this.#ui.speedMenu, this.#ui.speedBtn], [this.#ui.qualityMenu, this.#ui.qualityBtn]]) {
      m.hidden = true;
      b.setAttribute('aria-expanded', 'false');
    }
  }

  // ------------------------------------------------------------------ acciones y estado visual
  #toggle() { return this.playing ? this.pause() : (this.#state() === 'ended' ? (this.seek(0), this.play()) : this.play()); }

  #toggleMute() {
    this.#video.muted = !this.#video.muted;
    store.set('muted', this.#video.muted);
    this.#ui.volume.value = String(this.#video.muted ? 0 : this.#video.volume || 1);
  }

  #toggleFullscreen() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsEl) return (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    const r = this.#root;
    if (r.requestFullscreen) return r.requestFullscreen().catch(() => {});
    if (r.webkitRequestFullscreen) return r.webkitRequestFullscreen();
    if (this.#video.webkitEnterFullscreen) this.#video.webkitEnterFullscreen(); // iPhone
  }

  #syncFullscreen() {
    const on = (document.fullscreenElement || document.webkitFullscreenElement) === this.#root;
    this.#root.classList.toggle('yp-fullscreen', on);
    this.#ui.full.firstChild.className = `bi bi-${on ? 'fullscreen-exit' : 'fullscreen'}`;
    this.#ui.full.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Pantalla completa');
  }

  #duration() {
    const d = this.#video.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.#o.durationHint || 0);
  }

  #syncTime() {
    const d = this.#duration();
    const t = this.currentTime;
    if (!this.#scrubbing) {
      this.#ui.cur.textContent = formatClock(t);
      this.#ui.seek.value = d ? String(Math.round((t / d) * SEEK_RANGE)) : '0';
      this.#ui.played.style.width = d ? `${(t / d) * 100}%` : '0%';
    }
    this.#ui.dur.textContent = formatClock(d);
    this.#ui.seek.setAttribute('aria-valuetext', `${formatClock(t)} de ${formatClock(d)}`);
    this.#syncBuffered();
  }

  #syncBuffered() {
    const v = this.#video, d = this.#duration();
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
    this.#ui.buffered.style.width = d ? `${Math.min(100, (end / d) * 100)}%` : '0%';
  }

  #syncVolumeIcon() {
    const v = this.#video;
    const name = v.muted || v.volume === 0 ? 'volume-mute-fill' : v.volume < 0.5 ? 'volume-down-fill' : 'volume-up-fill';
    this.#ui.mute.firstChild.className = `bi bi-${name}`;
    this.#ui.mute.setAttribute('aria-label', v.muted ? 'Activar sonido' : 'Silenciar');
  }

  #state() { return this.#root.dataset.state; }

  #setState(state) {
    this.#root.dataset.state = state;
    const playing = state === 'playing';
    this.#ui.play.firstChild.className = `bi bi-${playing ? 'pause-fill' : 'play-fill'}`;
    this.#ui.play.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    this.#ui.big.firstChild.className = `bi bi-${state === 'ended' ? 'arrow-counterclockwise' : 'play-fill'}`;
    this.#ui.big.setAttribute('aria-label', state === 'ended' ? 'Ver de nuevo' : 'Reproducir');
    if (!playing) this.#root.classList.remove('yp-idle');
  }

  #showControls() {
    this.#root.classList.remove('yp-idle');
    this.#armIdle();
  }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    if (this.#state() !== 'playing') return;
    this.#idleTimer = setTimeout(() => {
      if (this.#state() !== 'playing') return;
      this.#root.classList.add('yp-idle'); // oculta los controles; volver a mover el puntero o el foco los muestra
      this.#closeMenus();
    }, IDLE_MS);
  }

  #showError(message) {
    this.#ui.errorMsg.textContent = message;
    this.#ui.error.hidden = false;
    this.#setState('error');
  }

  #hideError() { this.#ui.error.hidden = true; if (this.#state() === 'error') this.#setState('paused'); }
}
