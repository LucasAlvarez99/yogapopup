import assert from "node:assert/strict";
import { describeOrder, describeSubscription, groupProgress, partitionOrders } from "../../js/lib/account-view.js";

const cls = (id, extra = {}) => ({
  id,
  title: `Clase ${id}`,
  duration_seconds: 1000,
  access_level: "free",
  ...extra,
});
const row = (id, seconds, completed, at, extra) => ({
  progress_seconds: seconds,
  completed,
  last_watched_at: at,
  classes: cls(id, extra),
});

Deno.test("progreso: agrupa en progreso/completadas, la más reciente primero, y omite clases no visibles", () => {
  const g = groupProgress([
    row("a", 250, false, "2026-01-01T10:00:00Z"),
    row("b", 900, true, "2026-01-03T10:00:00Z"),
    row("c", 100, false, "2026-01-02T10:00:00Z", {
      access_level: "restricted",
    }),
    row("d", 3, false, "2026-01-04T10:00:00Z"), // menos de 5 s: no cuenta como empezada
    {
      progress_seconds: 500,
      completed: false,
      last_watched_at: "2026-01-05T10:00:00Z",
      classes: null,
    },
  ]);
  assert.deepEqual(g.inProgress.map((r) => r.classId), ["c", "a"]);
  assert.deepEqual(g.completed.map((r) => r.classId), ["b"]);
  assert.equal(g.inProgress[1].percent, 25);
  assert.equal(g.inProgress[1].resumeLabel, "Continuar desde 4:10");
  assert.equal(g.inProgress[0].locked, true);
  assert.equal(g.completed[0].percent, 100);
  assert.equal(g.completed[0].resumeLabel, "Volver a verla");
  assert.deepEqual(groupProgress(null), { inProgress: [], completed: [] });
});

Deno.test("compras: separa lo importante de los intentos sin completar y ordena por fecha", () => {
  const p = partitionOrders([
    { id: 1, status: "created", created_at: "2026-01-05T00:00:00Z" },
    { id: 2, status: "paid", created_at: "2026-01-01T00:00:00Z" },
    { id: 3, status: "refunded", created_at: "2026-01-03T00:00:00Z" },
    { id: 4, status: "failed", created_at: "2026-01-04T00:00:00Z" },
    { id: 5, status: "pending", created_at: "2026-01-06T00:00:00Z" },
  ]);
  assert.deepEqual(p.main.map((o) => o.id), [5, 3, 2]);
  assert.deepEqual(p.incomplete.map((o) => o.id), [1, 4]);
});

Deno.test("compras: describeOrder resume renglones y solo ofrece 'ver clase' si está pagada", () => {
  const base = {
    id: "o1",
    kind: "shop",
    status: "paid",
    total_cents: 2500,
    refunded_cents: 0,
    created_at: "2026-01-01T12:00:00Z",
    paid_at: "2026-01-01T12:05:00Z",
    order_items: [{ title: "Mat", size: "M", qty: 2, class_id: null }, {
      title: "Bloque",
      size: null,
      qty: 1,
      class_id: null,
    }],
  };
  const d = describeOrder(base);
  assert.equal(d.kind, "Tienda");
  assert.equal(d.summary, "2 × Mat (talle M), 1 × Bloque");
  assert.equal(d.status.label, "Pagado");
  assert.equal(d.classId, null);
  const c = {
    ...base,
    kind: "class",
    order_items: [{ title: "Yoga", qty: 1, class_id: "k1" }],
  };
  assert.equal(describeOrder(c).classId, "k1");
  assert.equal(describeOrder(c).kind, "Clase");
  assert.equal(describeOrder({ ...c, status: "refunded" }).classId, null);
  assert.equal(describeOrder({ ...c, status: "pending" }).classId, null);
  assert.match(
    describeOrder({ ...base, refunded_cents: 500 }).refundNote,
    /^Reembolsado parcialmente/,
  );
  assert.equal(
    describeOrder({ ...base, status: "refunded", refunded_cents: 2500 })
      .refundNote,
    "",
  );
  assert.equal(describeOrder({ ...base, order_items: [] }).summary, "Pedido");
});

Deno.test("suscripción: cada estado dice lo que corresponde y ofrece lo que corresponde", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const future = "2026-03-01T00:00:00Z";
  const past = "2026-01-01T00:00:00Z";
  const none = describeSubscription(null, { now });
  assert.equal(none.state, "none");
  assert.equal(none.canSubscribe, true);
  assert.equal(none.canCancel, false);
  assert.equal(
    describeSubscription({ status: "approval_pending" }, { now }).state,
    "none",
  );
  assert.equal(
    describeSubscription({ status: "expired" }, { now }).state,
    "ended",
  );
  assert.equal(
    describeSubscription({ status: "cancelled", current_period_end: past }, {
      now,
    }).state,
    "ended",
  );

  const active = describeSubscription({
    status: "active",
    current_period_end: future,
    last_payment_at: past,
  }, { now, planLabel: "Mensual" });
  assert.equal(active.state, "active");
  assert.equal(active.headline, "Suscripción activa.");
  assert.equal(active.canCancel, true);
  assert.equal(active.canSubscribe, false);
  assert.ok(active.details.includes("Plan: Mensual"));
  assert.ok(active.details.some((d) => d.startsWith("Próximo cobro: ")));
  assert.ok(active.details.some((d) => d.startsWith("Último pago: ")));
  // sin fecha informada por PayPal no se inventa un próximo cobro
  assert.equal(
    describeSubscription({ status: "active" }, { now }).details.some((d) => d.startsWith("Próximo cobro")),
    false,
  );

  const cancelled = describeSubscription({
    status: "cancelled",
    current_period_end: future,
  }, { now });
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.canCancel, false);
  assert.ok(
    cancelled.details[0].startsWith("Seguís teniendo acceso hasta el "),
  );

  const suspended = describeSubscription({
    status: "suspended",
    current_period_end: future,
  }, { now });
  assert.equal(suspended.state, "suspended");
  assert.equal(suspended.canCancel, true);
  assert.equal(suspended.tone, "warning");
});
