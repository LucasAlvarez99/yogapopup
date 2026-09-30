import assert from "node:assert/strict";
import { ProgressReporter } from "../../js/lib/progress-reporter.js";

/** Reloj y guardado simulados: el reporter es lógica pura, se prueba sin navegador ni red. */
function setup(opts = {}) {
  let now = 1_000_000;
  const saved = [];
  const unloaded = [];
  const errors = [];
  let failNext = 0;
  const reporter = new ProgressReporter({
    save: (s) => {
      if (failNext > 0) {
        failNext--;
        return Promise.reject(new Error("red caída"));
      }
      saved.push(s);
      return Promise.resolve();
    },
    saveOnUnload: (s) => unloaded.push(s),
    onError: (_e, n) => errors.push(n),
    now: () => now,
    intervalMs: 15000,
    minGapMs: 3000,
    minSeconds: 5,
    ...opts,
  });
  return {
    reporter,
    saved,
    unloaded,
    errors,
    advance: (ms) => {
      now += ms;
    },
    failNext: (n) => {
      failNext = n;
    },
    tick: (t, playing = true) => reporter.update(t, 2700, playing),
  };
}
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

Deno.test("no guarda antes del intervalo; guarda al cumplirse 15 s de reproducción", async () => {
  const c = setup();
  c.tick(1); // arranca el reloj
  c.advance(14_000);
  c.tick(15);
  await flushMicrotasks();
  assert.deepEqual(c.saved, []);
  c.advance(1_000);
  c.tick(16);
  await flushMicrotasks();
  assert.deepEqual(c.saved, [16]);
});

Deno.test("con la clase en pausa (playing=false) nunca guarda por intervalo", async () => {
  const c = setup();
  c.tick(100, false);
  c.advance(60_000);
  c.tick(100, false);
  await flushMicrotasks();
  assert.deepEqual(c.saved, []);
});

Deno.test("no hay una petición por segundo: 45 min continuos producen ~180 guardados como máximo", async () => {
  const c = setup();
  let t = 0;
  for (let s = 0; s < 45 * 60; s++) {
    t++;
    c.advance(1000);
    c.tick(t);
    await flushMicrotasks();
  }
  assert.ok(c.saved.length <= 181, `guardó ${c.saved.length} veces`);
  assert.ok(c.saved.length >= 170, `guardó solo ${c.saved.length} veces`);
});

Deno.test('ignora un "play" accidental de menos de 5 s', async () => {
  const c = setup();
  c.tick(2);
  c.advance(500);
  c.tick(3);
  c.reporter.flush("pause");
  c.reporter.flush("hidden");
  await flushMicrotasks();
  assert.deepEqual(c.saved, []);
  assert.deepEqual(c.unloaded, []);
});

Deno.test("al pausar guarda SIEMPRE, aunque se haya guardado hace menos del mínimo", async () => {
  const c = setup();
  c.tick(30);
  c.advance(15_000);
  c.tick(45);
  await flushMicrotasks();
  assert.deepEqual(c.saved, [45]);
  c.advance(500);
  c.tick(46);
  c.reporter.flush("pause");
  await flushMicrotasks();
  assert.deepEqual(c.saved, [45, 46]);
});

Deno.test("buscar en la barra respeta el mínimo entre guardados (no satura al arrastrar)", async () => {
  const c = setup();
  c.tick(30);
  c.advance(15_000);
  c.tick(45);
  await flushMicrotasks();
  c.advance(500);
  c.tick(900);
  c.reporter.flush("seek"); // dentro de los 3 s: se descarta
  await flushMicrotasks();
  assert.deepEqual(c.saved, [45]);
  c.advance(3_000);
  c.reporter.flush("seek");
  await flushMicrotasks();
  assert.deepEqual(c.saved, [45, 900]);
});

Deno.test("no repite la misma posición", async () => {
  const c = setup({ initialSeconds: 120 });
  c.tick(120, false);
  c.reporter.flush("pause");
  await flushMicrotasks();
  assert.deepEqual(c.saved, [], "la posición ya guardada no se reenvía");
});

Deno.test("al terminar guarda la DURACIÓN completa", async () => {
  const c = setup();
  c.tick(2690);
  c.reporter.flush("ended");
  await flushMicrotasks();
  assert.deepEqual(c.saved, [2700]);
});

Deno.test("al ocultar o cerrar la pestaña usa el guardado de salida (síncrono), no el normal", async () => {
  const c = setup();
  c.tick(600);
  c.reporter.flush("hidden");
  c.advance(10);
  c.tick(601);
  c.reporter.flush("unload");
  await flushMicrotasks();
  assert.deepEqual(c.unloaded, [600, 601]);
  assert.deepEqual(c.saved, []);
});

Deno.test("si el guardado falla no se rompe: cuenta el fallo, avisa y reintenta en el siguiente ciclo", async () => {
  const c = setup();
  c.tick(30);
  c.failNext(1); // el próximo guardado (el del intervalo) falla
  c.advance(15_000);
  c.tick(45);
  await flushMicrotasks();
  assert.equal(c.reporter.failures, 1);
  assert.deepEqual(c.errors, [1]);
  assert.deepEqual(c.saved, []);
  assert.equal(c.reporter.lastSavedSeconds, null, "una posición que no se pudo guardar no cuenta como guardada");
  c.advance(15_000);
  c.tick(60);
  await flushMicrotasks();
  assert.deepEqual(c.saved, [60]);
  assert.equal(c.reporter.failures, 0, "un guardado exitoso reinicia el contador");
});

Deno.test("nunca hay dos peticiones en paralelo: se envía solo la última posición pendiente", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const saved = [];
  let calls = 0;
  const r = new ProgressReporter({
    save: async (s) => {
      calls++;
      if (calls === 1) await gate;
      saved.push(s);
    },
    now: () => 1e6,
    intervalMs: 1e9,
    minGapMs: 0,
    minSeconds: 5,
  });
  r.update(100, 2700, false);
  r.flush("pause"); // 1.ª: queda en vuelo
  r.update(200, 2700, false);
  r.flush("pause"); // en vuelo → se anota como pendiente
  r.update(300, 2700, false);
  r.flush("pause"); // reemplaza a la pendiente
  assert.equal(calls, 1);
  release();
  await flushMicrotasks();
  await flushMicrotasks();
  assert.deepEqual(saved, [100, 300], "la posición intermedia (200) se descarta");
});
