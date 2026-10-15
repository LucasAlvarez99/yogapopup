import assert from "node:assert/strict";
import { accessFromEntitlements, classOffer, daysLeft, daysLeftLabel } from "../../js/lib/class-shop.js";
import {
  addClassItem,
  addItem,
  cartCount,
  createCartStore,
  emptyCart,
  isClassLine,
  parseCart,
  serializeCart,
  setQty,
  validateCart,
} from "../../js/lib/cart.js";
import { canCheckout, cartToItems, outcomeMessage } from "../../js/lib/checkout.js";
import { isRemovableOnly, lineNotice } from "../../js/lib/cart-view.js";

const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-14T12:00:00Z");
const future = (days) => new Date(NOW + days * 86_400_000).toISOString();
const past = (days) => new Date(NOW - days * 86_400_000).toISOString();

const video = (over = {}) => ({
  id: V1,
  title: "Vinyasa",
  access_level: "restricted",
  price_cents: 1000,
  tax_rate_bps: 2100,
  min_tier: 1,
  ...over,
});
const product = (over = {}) => ({
  id: P1,
  title: "Mat",
  price_cents: 3000,
  stock: 5,
  tax_rate_bps: 2100,
  ...over,
});

Deno.test("videos: un video en el carrito es una sola unidad y se guarda marcado", () => {
  const c = addClassItem(emptyCart(), V1);
  assert.deepEqual(c.items, [{ id: V1, qty: 1, t: "c" }]);
  assert.equal(addClassItem(c, V1), c, "repetido: igual");
  assert.equal(setQty(c, V1, 5), c, "no se le sube la cantidad");
  assert.equal(addItem(c, V1, 3), c, "tampoco con addItem");
  assert.equal(cartCount(c), 1);
  assert.equal(setQty(c, V1, 0).items.length, 0, "quitarlo funciona");
  assert.deepEqual(
    parseCart(serializeCart(c)).items,
    c.items,
    "sobrevive a guardar y leer",
  );
  assert.ok(isClassLine(c.items[0]));
});

Deno.test("videos: lo guardado en el navegador no se cree (qty enorme, talle, duplicados)", () => {
  const raw = JSON.stringify({
    v: 1,
    items: [{ id: V1, qty: 9, t: "c", variant: P1, price_cents: 1 }, {
      id: V1,
      qty: 1,
      t: "c",
    }],
  });
  assert.deepEqual(parseCart(raw).items, [{ id: V1, qty: 1, t: "c" }]);
});

Deno.test("videos: el carrito puede mezclar videos y productos y el store los agrega", () => {
  const store = createCartStore({ storage: null });
  store.addClass(V1);
  store.add(P1, 2, { stock: 5 });
  assert.equal(store.count(), 3);
  store.remove(V1);
  assert.deepEqual(store.get().items.map((i) => i.id), [P1]);
});

Deno.test("validateCart: videos ok / ya tiene acceso / ya no se vende, y se mezclan con productos", () => {
  const cart = { items: [{ id: V1, qty: 1, t: "c" }, { id: P1, qty: 2 }] };
  const v = validateCart(cart, [product()], { classes: [video()] });
  assert.equal(v.ok, true);
  assert.equal(v.subtotalCents, 1000 + 6000);
  assert.equal(v.hasProducts && v.hasClasses, true);
  assert.deepEqual(cartToItems(v), [{ type: "class", id: V1 }, {
    type: "product",
    id: P1,
    variant_id: null,
    qty: 2,
  }], "no viaja ningún precio");
  assert.equal(canCheckout(v), true);

  const owned = validateCart({ items: [{ id: V1, qty: 1, t: "c" }] }, [], {
    classes: [video()],
    ownedIds: [V1],
  });
  assert.equal(owned.lines[0].status, "owned");
  assert.equal(owned.ok, false);
  assert.match(lineNotice(owned.lines[0]), /acceso/i);
  assert.equal(isRemovableOnly(owned.lines[0]), true);
  assert.deepEqual(owned.fixedCart.items, [], "al actualizar se quita");

  for (
    const bad of [
      null,
      video({ access_level: "free" }),
      video({ price_cents: null }),
      video({ price_cents: 0 }),
    ]
  ) {
    const l = validateCart({ items: [{ id: V1, qty: 1, t: "c" }] }, [], {
      classes: bad ? [bad] : [],
    }).lines[0];
    assert.equal(l.status, "unavailable", JSON.stringify(bad));
    assert.equal(l.lineCents, 0, "un precio ausente no es 'gratis'");
  }
  // un video del carrito que se corrompe en un producto (mismo id en productos) no se cuela
  const mixedFixed = validateCart(cart, [product()], { classes: [video()] }).fixedCart;
  assert.deepEqual(mixedFixed.items, [{ id: V1, qty: 1, t: "c" }, {
    id: P1,
    qty: 2,
  }]);
});

Deno.test("outcomeMessage: un pedido de videos habla de 30 días; con productos suma el envío", () => {
  assert.match(outcomeMessage("paid", "class").text, /30 días/);
  assert.match(
    outcomeMessage("paid", "shop", { withVideos: true }).text,
    /30 días/,
  );
  assert.match(
    outcomeMessage("paid", "shop", { withVideos: true }).text,
    /enviamos/i,
  );
  assert.doesNotMatch(outcomeMessage("paid", "shop").text, /30 días/);
});

Deno.test("accessFromEntitlements: suscripción, accesos manuales y compras; lo vencido no cuenta", () => {
  const a = accessFromEntitlements([
    { scope: "all", tier: 1, expires_at: future(10) },
    { scope: "all", tier: 2, expires_at: future(5) },
    { scope: "all", tier: 3, expires_at: past(1) },
    { scope: "class", class_id: V1, tier: null, expires_at: future(3) },
    { scope: "class", class_id: V2, tier: null, expires_at: past(1) },
  ], { now: NOW });
  assert.equal(a.tier, 2, "el nivel vigente más alto");
  assert.equal(a.allAccess, false);
  assert.deepEqual([...a.classes.keys()], [V1]);
  assert.equal(
    accessFromEntitlements([{ scope: "all", tier: null, expires_at: null }], {
      now: NOW,
    }).allAccess,
    true,
  );
  assert.equal(accessFromEntitlements(null).tier, null);
  // dos compras del mismo video: vale la que dura más
  const twice = accessFromEntitlements([
    { scope: "class", class_id: V1, expires_at: future(2) },
    { scope: "class", class_id: V1, expires_at: future(20) },
  ], { now: NOW });
  assert.equal(twice.classes.get(V1), future(20));
});

Deno.test("classOffer: qué botón corresponde a cada video", () => {
  const none = accessFromEntitlements([], { now: NOW });
  assert.equal(classOffer(video({ access_level: "free" }), null), "free");
  assert.equal(
    classOffer(video(), null),
    "buy",
    "sin sesión: se puede agregar al carrito",
  );
  assert.equal(
    classOffer(video({ price_cents: null }), null),
    "locked",
    "sin precio: solo con suscripción",
  );
  assert.equal(classOffer(video(), none), "buy");
  const sub2 = accessFromEntitlements([{
    scope: "all",
    tier: 2,
    expires_at: future(5),
  }], { now: NOW });
  assert.equal(
    classOffer(video({ min_tier: 2 }), sub2),
    "included",
    "el nivel 2 cubre un video de nivel 2",
  );
  assert.equal(
    classOffer(video({ min_tier: 3 }), sub2),
    "buy",
    "uno de nivel 3 se compra suelto",
  );
  assert.equal(
    classOffer(video({ min_tier: undefined }), sub2),
    "buy",
    "sin saber el nivel no se asume acceso",
  );
  const bought = accessFromEntitlements([{
    scope: "class",
    class_id: V1,
    expires_at: future(9),
  }], { now: NOW });
  assert.equal(classOffer(video(), bought), "owned");
  assert.equal(classOffer(video({ id: V2 }), bought), "buy");
  assert.equal(
    classOffer(
      video({ min_tier: 3 }),
      accessFromEntitlements([{ scope: "all", tier: null, expires_at: null }]),
    ),
    "included",
    "acceso manual: todo",
  );
});

Deno.test("daysLeft / daysLeftLabel", () => {
  assert.equal(daysLeft(future(12), { now: NOW }), 12);
  assert.equal(
    daysLeft(new Date(NOW + 3_600_000).toISOString(), { now: NOW }),
    1,
    "menos de un día = 1",
  );
  assert.equal(daysLeft(past(1), { now: NOW }), 0);
  assert.equal(daysLeft(null), null);
  assert.equal(daysLeftLabel(12), "Te quedan 12 días");
  assert.equal(daysLeftLabel(1), "Te queda 1 día");
  assert.equal(daysLeftLabel(0), "Vence hoy");
  assert.equal(daysLeftLabel(null), "");
});
