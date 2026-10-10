import assert from "node:assert/strict";
import {
  BODY_MAX,
  BODY_MIN,
  countByStatus,
  initials,
  moderationActions,
  MY_STATUS,
  sortForModeration,
  validateTestimonial,
} from "../../js/lib/testimonials.js";

Deno.test("comentarios: el texto se recorta y debe tener entre 10 y 600 caracteres", () => {
  const ok = validateTestimonial({ body: "   Me encantaron las clases   ", rating: "5" });
  assert.deepEqual(ok, { ok: true, value: { body: "Me encantaron las clases", rating: 5 } });
  assert.equal(validateTestimonial({ body: "corto" }).ok, false);
  assert.equal(validateTestimonial({ body: " ".repeat(30) }).ok, false, "solo espacios no cuenta");
  assert.equal(validateTestimonial({ body: "a".repeat(BODY_MIN) }).ok, true);
  assert.equal(validateTestimonial({ body: "a".repeat(BODY_MAX) }).ok, true);
  const long = validateTestimonial({ body: "a".repeat(BODY_MAX + 1) });
  assert.equal(long.ok, false);
  assert.equal(long.field, "body");
  assert.equal(validateTestimonial({}).ok, false);
  assert.equal(validateTestimonial().ok, false);
});

Deno.test("comentarios: la puntuación es opcional, entera y de 1 a 5", () => {
  const body = "Un comentario suficientemente largo";
  for (const empty of ["", null, undefined]) {
    assert.equal(validateTestimonial({ body, rating: empty }).value.rating, null);
  }
  for (const n of [1, 2, 3, 4, 5, "3"]) assert.equal(validateTestimonial({ body, rating: n }).ok, true);
  for (const bad of [0, 6, -1, 2.5, "x", NaN]) {
    const r = validateTestimonial({ body, rating: bad });
    assert.equal(r.ok, false, `rating ${bad}`);
    assert.equal(r.field, "rating");
  }
});

Deno.test("comentarios: iniciales para el avatar", () => {
  assert.equal(initials("María Sol"), "MS");
  assert.equal(initials("Ana"), "A");
  assert.equal(initials("  ana   maría  pérez "), "AP");
  assert.equal(initials(""), "?");
  assert.equal(initials(null), "?");
});

Deno.test("comentarios: cada estado tiene su texto para la persona y sus acciones para la gestión", () => {
  for (const s of ["pending", "approved", "hidden"]) {
    assert.ok(MY_STATUS[s].label && MY_STATUS[s].note && MY_STATUS[s].tone);
  }
  assert.deepEqual(moderationActions("pending"), ["approve", "hide"]);
  assert.deepEqual(moderationActions("approved"), ["hide"], "lo aprobado solo se puede ocultar");
  assert.deepEqual(moderationActions("hidden"), ["approve"]);
});

Deno.test("comentarios: conteo y orden para moderar (los pendientes, del más antiguo al más nuevo)", () => {
  const rows = [
    { id: 1, status: "pending", created_at: "2026-01-03T00:00:00Z" },
    { id: 2, status: "pending", created_at: "2026-01-01T00:00:00Z" },
    { id: 3, status: "approved", created_at: "2026-01-02T00:00:00Z" },
    { id: 4, status: "approved", created_at: "2026-01-05T00:00:00Z" },
    { id: 5, status: "hidden", created_at: "2026-01-04T00:00:00Z" },
    { id: 6, status: "raro", created_at: "2026-01-04T00:00:00Z" },
  ];
  assert.deepEqual(countByStatus(rows), { pending: 2, approved: 2, hidden: 1 });
  assert.deepEqual(countByStatus(null), { pending: 0, approved: 0, hidden: 0 });
  assert.deepEqual(sortForModeration(rows, "pending").map((r) => r.id), [2, 1]);
  assert.deepEqual(sortForModeration(rows, "approved").map((r) => r.id), [4, 3]);
  assert.deepEqual(sortForModeration(rows, "hidden").map((r) => r.id), [5]);
});
