import assert from "node:assert/strict";
import { formatClock, formatMinutes, isUuid, levelLabel, percent } from "../../js/lib/format.js";
import { AppError, messageFor } from "../../js/lib/errors.js";

Deno.test("formatClock: minutos:segundos y horas", () => {
  assert.equal(formatClock(1663), "27:43"); // el ejemplo del encargo
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(59.9), "0:59");
  assert.equal(formatClock(3723), "1:02:03");
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatClock(NaN), "0:00");
  assert.equal(formatClock(undefined), "0:00");
});

Deno.test("formatMinutes: redondea hacia arriba y no inventa duraciones", () => {
  assert.equal(formatMinutes(2700), "45 min");
  assert.equal(formatMinutes(2701), "46 min");
  assert.equal(formatMinutes(20), "1 min");
  assert.equal(formatMinutes(0), "");
  assert.equal(formatMinutes(null), "");
  assert.equal(formatMinutes("x"), "");
});

Deno.test("percent: entero hacia abajo, acotado a 0-100", () => {
  assert.equal(percent(1663, 2700), 61); // 27:43 de 45:00
  assert.equal(percent(0, 2700), 0);
  assert.equal(percent(2700, 2700), 100);
  assert.equal(percent(9999, 2700), 100);
  assert.equal(percent(-3, 2700), 0);
  assert.equal(percent(10, 0), 0);
  assert.equal(percent(10, null), 0);
});

Deno.test("isUuid y levelLabel", () => {
  assert.equal(isUuid("0d8e5f3a-1b2c-4d6e-9f70-123456789abc"), true);
  for (const bad of ["", "abc", null, undefined, "../../x", "0d8e5f3a-1b2c-4d6e-9f70-123456789abc/x", 5]) {
    assert.equal(isUuid(bad), false);
  }
  assert.equal(levelLabel("principiante"), "Principiante");
  assert.equal(levelLabel("desconocido"), "desconocido");
  assert.equal(levelLabel(null), "");
});

Deno.test("messageFor: mensajes claros por código y sin filtrar detalles internos", () => {
  assert.match(messageFor(new AppError("no_access")), /no está incluida/);
  assert.match(messageFor(new AppError("network")), /conectar/);
  assert.match(messageFor(new AppError("video_not_ready")), /preparando/);
  assert.match(messageFor(new AppError("codigo_raro")), /error inesperado|codigo_raro/);
  assert.match(messageFor(new Error("SELECT * FROM secretos")), /inesperado/); // un Error cualquiera no muestra su texto
});
