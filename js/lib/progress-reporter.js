/**
 * Decide CUÁNDO guardar el progreso de una clase (sin una petición por segundo).
 * Lógica pura, sin DOM ni red: recibe funciones para guardar y para medir el tiempo.
 *
 * Se guarda:
 *  - cada `intervalMs` de reproducción efectiva (por defecto 15 s),
 *  - al pausar y al terminar (siempre), y al soltar una búsqueda en la barra (con un mínimo entre guardados),
 *  - al ocultar/cerrar la pestaña (con una petición `keepalive` que sobrevive al cierre).
 * No se guarda: la misma posición dos veces, ni un "play" accidental de menos de `minSeconds`.
 * Si un guardado falla, se reintenta en el próximo ciclo; nunca se apilan peticiones en paralelo.
 */
export class ProgressReporter {
  #save; #saveOnUnload; #onError; #now;
  #intervalMs; #minGapMs; #minSeconds;
  #time = 0; #duration = 0;
  #lastSeconds; #lastAt = 0;
  #inFlight = false; #queued = null;
  #failures = 0;

  /**
   * @param {object} o
   * @param {(seconds:number)=>Promise<void>} o.save            guardado normal
   * @param {(seconds:number)=>void} [o.saveOnUnload]           guardado síncrono al cerrar (keepalive)
   * @param {number} [o.initialSeconds]                         posición ya guardada (para no repetirla)
   */
  constructor({ save, saveOnUnload, onError, initialSeconds = null, intervalMs = 15000, minGapMs = 3000, minSeconds = 5, now = () => Date.now() }) {
    this.#save = save;
    this.#saveOnUnload = saveOnUnload;
    this.#onError = onError;
    this.#lastSeconds = initialSeconds;
    this.#intervalMs = intervalMs;
    this.#minGapMs = minGapMs;
    this.#minSeconds = minSeconds;
    this.#now = now;
  }

  get failures() { return this.#failures; }
  get lastSavedSeconds() { return this.#lastSeconds; }

  /** Llamar en cada `timeupdate`. */
  update(time, duration, playing) {
    this.#time = Number(time) || 0;
    this.#duration = Number(duration) || 0;
    if (!playing) return;
    if (this.#lastAt === 0) { this.#lastAt = this.#now(); return; } // arranca el reloj al empezar a reproducir
    if (this.#now() - this.#lastAt >= this.#intervalMs) this.flush('interval');
  }

  /** reason: 'interval' | 'pause' | 'seek' | 'ended' | 'hidden' | 'unload' */
  flush(reason) {
    const force = reason === 'ended' || reason === 'hidden' || reason === 'unload' || reason === 'pause';
    let seconds = Math.floor(this.#time);
    if (reason === 'ended' && this.#duration > 0) seconds = Math.floor(this.#duration);
    if (!Number.isFinite(seconds) || seconds < 0) return;

    if (!force && this.#lastAt !== 0 && this.#now() - this.#lastAt < this.#minGapMs) return;
    if (seconds < this.#minSeconds && this.#lastSeconds === null && reason !== 'ended') return;
    if (seconds === this.#lastSeconds) return;

    if (reason === 'unload' || reason === 'hidden') {
      if (this.#saveOnUnload) {
        this.#saveOnUnload(seconds);
        this.#lastSeconds = seconds;
        this.#lastAt = this.#now();
        return;
      }
    }
    return this.#send(seconds);
  }

  async #send(seconds) {
    if (this.#inFlight) { this.#queued = seconds; return; } // se coalesce: solo importa la última posición
    this.#inFlight = true;
    try {
      await this.#save(seconds);
      this.#lastSeconds = seconds;
      this.#lastAt = this.#now();
      this.#failures = 0;
    } catch (err) {
      this.#failures += 1;
      this.#lastAt = this.#now(); // evita reintentar en cada timeupdate: se espera al próximo ciclo
      this.#onError?.(err, this.#failures);
    } finally {
      this.#inFlight = false;
      const next = this.#queued;
      this.#queued = null;
      if (next !== null && next !== this.#lastSeconds) await this.#send(next);
    }
  }
}
