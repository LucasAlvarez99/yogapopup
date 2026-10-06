import assert from "node:assert/strict";
import {
  addItem,
  cartCount,
  createCartStore,
  emptyCart,
  MAX_QTY_PER_ITEM,
  parseCart,
  qtyOf,
  removeItem,
  serializeCart,
  setQty,
  validateCart,
} from "../../js/lib/cart.js";
import { addFeedback, canIncrease, isRemovableOnly, lineNotice } from "../../js/lib/cart-view.js";

const P = "10000000-0000-4000-8000-000000000001";
const Q = "10000000-0000-4000-8000-000000000002";
const S = "20000000-0000-4000-8000-000000000001";
const M = "20000000-0000-4000-8000-000000000002";
const L = "20000000-0000-4000-8000-000000000003";

const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
};
const remera = (variants, over = {}) => ({
  id: P,
  title: "Remera",
  price_cents: 3500,
  stock: 99,
  tax_rate_bps: 2100,
  product_variants: variants,
  ...over,
});
const sizes = [{ id: S, size: "S", stock: 3, sort_order: 0 }, { id: M, size: "M", stock: 1, sort_order: 1 }, {
  id: L,
  size: "L",
  stock: 0,
  sort_order: 2,
}];

// ------------------------------------------------------------------ lectura y escritura
Deno.test("carrito con talles: el mismo producto en dos talles son dos líneas, y cada talle suma lo suyo", () => {
  let c = emptyCart();
  c = addItem(c, P, 1, { variant: S, stock: 3 });
  c = addItem(c, P, 2, { variant: M, stock: 5 });
  c = addItem(c, P, 1, { variant: S, stock: 3 });
  assert.deepEqual(c.items, [{ id: P, variant: S, qty: 2 }, { id: P, variant: M, qty: 2 }]);
  assert.equal(qtyOf(c, P, S), 2);
  assert.equal(qtyOf(c, P, M), 2);
  assert.equal(qtyOf(c, P), 0, "sin talle es otra línea: no hay");
  assert.equal(qtyOf(c, P, L), 0);
  assert.equal(cartCount(c), 4);
});

Deno.test("carrito con talles: el tope es el stock DEL TALLE, no el del producto", () => {
  let c = addItem(emptyCart(), P, 5, { variant: M, stock: 1 });
  assert.equal(qtyOf(c, P, M), 1);
  c = addItem(c, P, 1, { variant: M, stock: 1 });
  assert.equal(qtyOf(c, P, M), 1, "ya no deja pasar de 1");
  assert.equal(addItem(emptyCart(), P, 1, { variant: L, stock: 0 }).items.length, 0, "un talle agotado no se agrega");
  assert.equal(
    qtyOf(addItem(emptyCart(), P, 99, { variant: S, stock: null }), P, S),
    MAX_QTY_PER_ITEM,
    "sin control, el tope por línea",
  );
});

Deno.test("carrito con talles: cambiar y quitar afecta solo al talle indicado", () => {
  let c = addItem(addItem(emptyCart(), P, 2, { variant: S, stock: 3 }), P, 1, { variant: M, stock: 5 });
  c = setQty(c, P, 3, { variant: S, stock: 3 });
  assert.equal(qtyOf(c, P, S), 3);
  assert.equal(qtyOf(c, P, M), 1, "el otro talle no cambió");
  c = setQty(c, P, 9, { variant: S, stock: 3 });
  assert.equal(qtyOf(c, P, S), 3, "limitado al stock del talle");
  c = removeItem(c, P, S);
  assert.deepEqual(c.items, [{ id: P, variant: M, qty: 1 }]);
  assert.equal(removeItem(c, P, S), c, "quitar lo que no está no cambia nada");
  assert.equal(removeItem(c, P), c, "ni 'sin talle' toca la línea con talle");
  c = setQty(c, P, 0, { variant: M });
  assert.equal(c.items.length, 0);
});

Deno.test("carrito con talles: un id de talle inválido es un error de programación, no se ignora", () => {
  for (const bad of ["x", "123", {}, 5, ""]) {
    assert.throws(() => addItem(emptyCart(), P, 1, { variant: bad }), TypeError, String(bad));
    assert.throws(() => removeItem(emptyCart(), P, bad), TypeError);
  }
  assert.doesNotThrow(() => addItem(emptyCart(), P, 1, { variant: null }));
  assert.doesNotThrow(() => addItem(emptyCart(), P, 1, { variant: undefined }));
});

Deno.test("carrito guardado: los talles sobreviven; lo manipulado se descarta; los carritos viejos siguen valiendo", () => {
  const stored = serializeCart({ items: [{ id: P, variant: S, qty: 2 }, { id: Q, qty: 1 }] });
  assert.deepEqual(JSON.parse(stored), { v: 1, items: [{ id: P, variant: S, qty: 2 }, { id: Q, qty: 1 }] });
  assert.ok(!stored.includes('"variant":null'), "sin talle no se escribe la clave");
  assert.deepEqual(parseCart(stored).items, [{ id: P, variant: S, qty: 2 }, { id: Q, qty: 1 }]);

  // un carrito de antes de los talles (sin variant) se lee igual
  assert.deepEqual(parseCart({ v: 1, items: [{ id: P, qty: 2 }] }).items, [{ id: P, qty: 2 }]);
  // mayúsculas se normalizan; duplicados del mismo talle se suman; distinto talle = otra línea
  const c = parseCart({
    v: 1,
    items: [{ id: P.toUpperCase(), variant: S.toUpperCase(), qty: 1 }, { id: P, variant: S, qty: 2 }, {
      id: P,
      variant: M,
      qty: 1,
    }],
  });
  assert.deepEqual(c.items, [{ id: P, variant: S, qty: 3 }, { id: P, variant: M, qty: 1 }]);
  // un talle que no es un id descarta la línea; campos ajenos se tiran
  assert.deepEqual(
    parseCart({ v: 1, items: [{ id: P, variant: "no-es-id", qty: 1 }, { id: Q, variant: 5, qty: 1 }] }).items,
    [],
  );
  assert.deepEqual(parseCart({ v: 1, items: [{ id: P, variant: S, qty: 1, price_cents: 1, size: "XXL" }] }).items, [{
    id: P,
    variant: S,
    qty: 1,
  }]);
});

Deno.test("carrito con talles: persiste y se recupera en otra 'pestaña'", () => {
  const storage = memory();
  const a = createCartStore({ storage });
  a.add(P, 2, { variant: S, stock: 3 });
  a.add(P, 1, { variant: M, stock: 1 });
  a.remove(P, S);
  const b = createCartStore({ storage });
  assert.deepEqual(b.get().items, [{ id: P, variant: M, qty: 1 }]);
});

// ------------------------------------------------------------------ validación contra los productos reales
Deno.test("validateCart con talles: usa el stock de cada talle y no el del producto", () => {
  const cart = { items: [{ id: P, variant: S, qty: 5 }, { id: P, variant: M, qty: 1 }, { id: P, variant: L, qty: 1 }] };
  const v = validateCart(cart, [remera(sizes)]);
  assert.deepEqual(v.lines.map((l) => [l.size, l.status, l.qty]), [["S", "reduced", 3], ["M", "ok", 1], [
    "L",
    "soldout",
    0,
  ]]);
  assert.deepEqual(
    v.lines.map((l) => l.stock),
    [3, 1, 0],
    "el stock de la línea es el del talle (el del producto era 99)",
  );
  assert.equal(v.subtotalCents, 3500 * 4);
  assert.equal(v.issues, 2);
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.fixedCart.items,
    [{ id: P, variant: S, qty: 3 }, { id: P, variant: M, qty: 1 }],
    "lo agotado se quita, con sus talles",
  );
});

Deno.test("validateCart con talles: sin talle elegido, talle que ya no existe y producto que dejó de tener talles", () => {
  const legacy = validateCart({ items: [{ id: P, qty: 1 }] }, [remera(sizes)]);
  assert.equal(legacy.lines[0].status, "needs_size", "carrito de antes de los talles: hay que elegir uno");
  assert.equal(legacy.lines[0].lineCents, 0);
  assert.equal(legacy.ok, false);
  assert.deepEqual(legacy.fixedCart.items, []);

  const removed = validateCart({ items: [{ id: P, variant: "20000000-0000-4000-8000-0000000000ff", qty: 1 }] }, [
    remera(sizes),
  ]);
  assert.equal(removed.lines[0].status, "unavailable");
  assert.equal(removed.lines[0].lineCents, 0);

  const noSizesNow = validateCart({ items: [{ id: P, variant: S, qty: 1 }] }, [remera([])]);
  assert.equal(noSizesNow.lines[0].status, "unavailable", "el producto ya no tiene talles");

  const noSizes = validateCart({ items: [{ id: P, qty: 2 }] }, [remera([], { stock: 5 })]);
  assert.deepEqual(
    noSizes.lines.map((l) => [l.status, l.qty, l.stock]),
    [["ok", 2, 5]],
    "sin talles todo como siempre",
  );
});

Deno.test("validateCart: precios e IVA salen de la base; el IVA incluido se calcula por línea", () => {
  const cart = { items: [{ id: P, variant: S, qty: 2 }, { id: Q, qty: 1 }] };
  const v = validateCart(cart, [
    remera(sizes),
    { id: Q, title: "Mat", price_cents: 1100, stock: null, tax_rate_bps: 1000, product_variants: [] },
  ]);
  assert.equal(v.subtotalCents, 7000 + 1100);
  assert.equal(v.taxCents, 1215 + 100, "7000 al 21 % = 1215 de IVA · 1100 al 10 % = 100");
  assert.equal(v.netCents + v.taxCents, v.subtotalCents, "base + IVA = subtotal, siempre");
  // un tipo ausente o inválido cae al 21 %
  assert.equal(
    validateCart({ items: [{ id: P, variant: S, qty: 1 }] }, [remera(sizes, { tax_rate_bps: undefined })]).lines[0]
      .taxRateBps,
    2100,
  );
  assert.equal(
    validateCart({ items: [{ id: P, variant: S, qty: 1 }] }, [remera(sizes, { tax_rate_bps: -5 })]).lines[0].taxRateBps,
    2100,
  );
  // un precio manipulado en el carrito no existe: solo cuenta el de la base
  const tampered = validateCart(parseCart({ v: 1, items: [{ id: P, variant: S, qty: 1, price_cents: 1 }] }), [
    remera(sizes),
  ]);
  assert.equal(tampered.subtotalCents, 3500);
});

// ------------------------------------------------------------------ textos y reglas de la vista
Deno.test("vista del carrito: avisos, tope y quitar para las líneas con talle", () => {
  const v = validateCart({ items: [{ id: P, qty: 1 }, { id: P, variant: S, qty: 5 }, { id: P, variant: L, qty: 1 }] }, [
    remera(sizes),
  ]);
  const [needs, reduced, soldout] = v.lines;
  assert.equal(lineNotice(needs), "Elige un talle");
  assert.equal(isRemovableOnly(needs), true);
  assert.equal(lineNotice(reduced), "Solo quedan 3 unidades");
  assert.equal(canIncrease(reduced), false, "ya está en el stock del talle");
  assert.equal(lineNotice(soldout), "Agotado");
  assert.equal(canIncrease({ product: { stock: 99 }, status: "ok", qty: 1, stock: 2 }), true);
  assert.equal(
    canIncrease({ product: { stock: 99 }, status: "ok", qty: 2, stock: 2 }),
    false,
    "manda el stock del talle, no el del producto",
  );
  assert.equal(
    canIncrease({ product: { stock: 3 }, status: "ok", qty: 2 }),
    true,
    "líneas sin 'stock' propio usan el del producto",
  );
  const gone =
    validateCart({ items: [{ id: P, variant: "20000000-0000-4000-8000-0000000000ff", qty: 1 }] }, [remera(sizes)])
      .lines[0];
  assert.equal(lineNotice(gone), "Ese talle ya no está disponible");
});

Deno.test("avisos al agregar: dicen el talle, y distinguen talle agotado de tope alcanzado", () => {
  const p = { id: P, title: "Remera", stock: 99 };
  const empty = emptyCart();
  const added = addItem(empty, P, 1, { variant: M, stock: 1 });
  assert.deepEqual(addFeedback(empty, added, p, { variant: M, size: "M", stock: 1 }), {
    kind: "success",
    text: "«Remera (talle M)» se agregó al carrito.",
  });
  assert.match(
    addFeedback(added, addItem(added, P, 1, { variant: M, stock: 1 }), p, { variant: M, size: "M", stock: 1 }).text,
    /máximo disponible de «Remera \(talle M\)»/,
  );
  assert.equal(addFeedback(empty, empty, p, { variant: L, size: "L", stock: 0 }).text, "Ese talle está agotado.");
  // sin talle, todo igual que antes
  assert.equal(addFeedback(empty, addItem(empty, P, 1), p).text, "«Remera» se agregó al carrito.");
});
