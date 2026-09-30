import assert from "node:assert/strict";
import {
  addItem,
  browserStorage,
  CART_KEY,
  cartCount,
  clearCart,
  createCartStore,
  emptyCart,
  limitFor,
  MAX_LINES,
  MAX_QTY_PER_ITEM,
  parseCart,
  qtyOf,
  removeItem,
  serializeCart,
  setQty,
  validateCart,
} from "../../js/lib/cart.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Almacenamiento falso con la misma interfaz que localStorage. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

// ------------------------------------------------------------------ operaciones puras

Deno.test("addItem: agrega, suma al repetir y no muta el carrito original", () => {
  const c0 = emptyCart();
  const c1 = addItem(c0, A);
  const c2 = addItem(c1, A, 2);
  assert.deepEqual(c0.items, []);
  assert.deepEqual(c1.items, [{ id: A, qty: 1 }]);
  assert.deepEqual(c2.items, [{ id: A, qty: 3 }]);
  assert.equal(cartCount(addItem(c2, B, 2)), 5);
});

Deno.test("addItem: respeta el tope por producto y el stock", () => {
  assert.equal(qtyOf(addItem(emptyCart(), A, 99), A), MAX_QTY_PER_ITEM);
  assert.equal(qtyOf(addItem(emptyCart(), A, 5, { stock: 3 }), A), 3);
  const c = addItem(emptyCart(), A, 3, { stock: 3 });
  assert.equal(addItem(c, A, 1, { stock: 3 }), c); // ya está al máximo: queda igual
  assert.equal(addItem(emptyCart(), A, 1, { stock: 0 }).items.length, 0); // agotado: no se agrega
  assert.equal(qtyOf(addItem(emptyCart(), A, 4, { stock: null }), A), 4); // null = sin control de stock
});

Deno.test("addItem: tope de productos distintos", () => {
  let c = emptyCart();
  for (let i = 1; i <= MAX_LINES + 5; i++) c = addItem(c, uuid(i));
  assert.equal(c.items.length, MAX_LINES);
});

Deno.test("addItem / setQty: cantidades e ids inválidos son un error de programación, no se ignoran", () => {
  for (const q of [0, -1, 1.5, NaN, "2", null, undefined === 1]) {
    assert.throws(() => addItem(emptyCart(), A, q), TypeError, `qty ${String(q)}`);
  }
  assert.throws(() => addItem(emptyCart(), "no-es-uuid"), TypeError);
  assert.throws(() => addItem(emptyCart(), null), TypeError);
  assert.throws(() => setQty(emptyCart(), A, -2), TypeError);
  assert.throws(() => setQty(emptyCart(), A, 1.2), TypeError);
});

Deno.test("setQty: fija la cantidad exacta, 0 quita la línea, y respeta el stock", () => {
  const c = addItem(addItem(emptyCart(), A, 2), B, 1);
  assert.equal(qtyOf(setQty(c, A, 5), A), 5);
  assert.equal(qtyOf(setQty(c, A, 99), A), MAX_QTY_PER_ITEM);
  assert.equal(qtyOf(setQty(c, A, 8, { stock: 4 }), A), 4);
  assert.deepEqual(setQty(c, A, 0).items, [{ id: B, qty: 1 }]);
  assert.equal(setQty(c, C, 2).items.length, 3); // fijar un producto que no estaba lo agrega
  assert.equal(setQty(c, A, 3, { stock: 0 }).items.some((i) => i.id === A), false); // agotado: se quita
});

Deno.test("removeItem / clearCart", () => {
  const c = addItem(addItem(emptyCart(), A), B);
  assert.deepEqual(removeItem(c, A).items, [{ id: B, qty: 1 }]);
  assert.equal(removeItem(c, C), c); // no estaba: queda igual
  assert.deepEqual(clearCart().items, []);
});

Deno.test("los ids se normalizan a minúsculas (no se duplica el mismo producto)", () => {
  const c = addItem(addItem(emptyCart(), A.toUpperCase()), A);
  assert.deepEqual(c.items, [{ id: A, qty: 2 }]);
  assert.equal(qtyOf(c, A.toUpperCase()), 2);
});

Deno.test("limitFor: null = tope general; 0 o inválido = agotado; nunca más que el tope", () => {
  assert.equal(limitFor(null), MAX_QTY_PER_ITEM);
  assert.equal(limitFor(undefined), MAX_QTY_PER_ITEM);
  assert.equal(limitFor(0), 0);
  assert.equal(limitFor(-4), 0);
  assert.equal(limitFor(NaN), 0);
  assert.equal(limitFor(3), 3);
  assert.equal(limitFor(500), MAX_QTY_PER_ITEM);
});

// ------------------------------------------------------------------ lectura de datos no confiables

Deno.test("parseCart: basura, JSON roto o versión desconocida dan un carrito vacío sin lanzar", () => {
  for (const raw of [null, undefined, "", "{", "no es json", "[]", "123", '"x"', {}, [], 7, true]) {
    assert.deepEqual(parseCart(raw), emptyCart(), String(raw));
  }
  assert.deepEqual(parseCart(JSON.stringify({ v: 99, items: [{ id: A, qty: 1 }] })), emptyCart());
  assert.deepEqual(parseCart(JSON.stringify({ v: 1, items: "x" })), emptyCart());
});

Deno.test("parseCart: descarta líneas inválidas y mantiene las buenas", () => {
  const raw = JSON.stringify({
    v: 1,
    items: [
      { id: A, qty: 2 },
      { id: "no-uuid", qty: 1 },
      { id: B, qty: 0 },
      { id: B, qty: -3 },
      { id: B, qty: 1.5 },
      { id: B, qty: "2" },
      null,
      "x",
      { qty: 1 },
      { id: C, qty: 1 },
    ],
  });
  assert.deepEqual(parseCart(raw).items, [{ id: A, qty: 2 }, { id: C, qty: 1 }]);
});

Deno.test("parseCart: junta duplicados, limita cantidades y cantidad de líneas", () => {
  const dup = parseCart({ v: 1, items: [{ id: A, qty: 4 }, { id: A.toUpperCase(), qty: 3 }] });
  assert.deepEqual(dup.items, [{ id: A, qty: 7 }]);
  assert.equal(parseCart({ v: 1, items: [{ id: A, qty: 999 }] }).items[0].qty, MAX_QTY_PER_ITEM);
  const many = { v: 1, items: Array.from({ length: 200 }, (_, i) => ({ id: uuid(i + 1), qty: 1 })) };
  assert.equal(parseCart(many).items.length, MAX_LINES);
});

Deno.test("seguridad: un precio o título inyectado en el almacenamiento se descarta, nunca viaja", () => {
  const tampered = JSON.stringify({
    v: 1,
    items: [{ id: A, qty: 1, price_cents: 1, title: "gratis", stock: 9999 }],
  });
  const parsed = parseCart(tampered);
  assert.deepEqual(parsed.items, [{ id: A, qty: 1 }]);
  assert.deepEqual(Object.keys(parsed.items[0]).sort(), ["id", "qty"]);
  // y lo que se vuelve a guardar tampoco lo trae
  assert.deepEqual(JSON.parse(serializeCart(parsed)), { v: 1, items: [{ id: A, qty: 1 }] });
});

Deno.test("serializeCart / parseCart: ida y vuelta", () => {
  const c = addItem(addItem(emptyCart(), A, 2), B, 3);
  assert.deepEqual(parseCart(serializeCart(c)), c);
});

// ------------------------------------------------------------------ persistencia

Deno.test("store: guarda en el almacenamiento y sobrevive a 'recargar' (un store nuevo sobre el mismo storage)", () => {
  const storage = fakeStorage();
  const s1 = createCartStore({ storage });
  s1.add(A, 2);
  s1.add(B);
  assert.equal(s1.count(), 3);
  assert.ok(storage.data.has(CART_KEY));

  const s2 = createCartStore({ storage }); // como abrir la página de nuevo
  assert.deepEqual(s2.get(), s1.get());
  assert.equal(s2.count(), 3);
});

Deno.test("store: vaciar el carrito borra la clave en vez de dejar basura", () => {
  const storage = fakeStorage();
  const s = createCartStore({ storage });
  s.add(A);
  s.clear();
  assert.equal(storage.data.has(CART_KEY), false);
  assert.equal(s.count(), 0);
  s.add(A);
  s.remove(A);
  assert.equal(storage.data.has(CART_KEY), false);
});

Deno.test("store: un carrito guardado corrupto o manipulado no rompe nada", () => {
  const corrupt = createCartStore({ storage: fakeStorage({ [CART_KEY]: "{{{ corrupto" }) });
  assert.equal(corrupt.count(), 0);
  corrupt.add(A); // y se puede seguir usando
  assert.equal(corrupt.count(), 1);

  const fake = JSON.stringify({ v: 1, items: [{ id: A, qty: 500, price_cents: 1 }] });
  assert.equal(createCartStore({ storage: fakeStorage({ [CART_KEY]: fake }) }).count(), MAX_QTY_PER_ITEM);
});

Deno.test("store: sin almacenamiento (modo privado) o con cuota llena, sigue funcionando en memoria", () => {
  const none = createCartStore({ storage: null });
  none.add(A, 2);
  assert.equal(none.count(), 2);
  assert.equal(none.persistent, false);

  const full = fakeStorage();
  full.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };
  const s = createCartStore({ storage: full });
  assert.equal(s.persistent, true);
  s.add(A);
  assert.equal(s.count(), 1); // el carrito funciona
  assert.equal(s.persistent, false); // pero avisa que no se está guardando
});

Deno.test("store: si leer el almacenamiento lanza, arranca vacío", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem() {},
    removeItem() {},
  };
  const s = createCartStore({ storage: broken });
  assert.equal(s.count(), 0);
  assert.equal(s.persistent, false);
});

Deno.test("store: avisa a los oyentes solo cuando algo cambia, y se puede dejar de escuchar", () => {
  const s = createCartStore({ storage: fakeStorage() });
  const seen = [];
  const off = s.subscribe((c) => seen.push(cartCount(c)));
  s.add(A);
  s.add(A);
  s.remove(B); // no estaba: no cambia nada
  s.clear();
  s.clear(); // ya vacío: no cambia nada
  assert.deepEqual(seen, [1, 2, 0]);
  off();
  s.add(A);
  assert.deepEqual(seen, [1, 2, 0]);
});

Deno.test("store: un oyente que falla no impide avisar al resto", () => {
  const s = createCartStore({ storage: fakeStorage() });
  let ok = 0;
  s.subscribe(() => {
    throw new Error("oyente roto");
  });
  s.subscribe(() => ok++);
  s.add(A);
  assert.equal(ok, 1);
});

Deno.test("store: se entera de cambios hechos desde otra pestaña (evento 'storage')", () => {
  const storage = fakeStorage();
  const handlers = [];
  const target = { addEventListener: (type, fn) => type === "storage" && handlers.push(fn) };
  const s = createCartStore({ storage, target });
  const seen = [];
  s.subscribe((c) => seen.push(cartCount(c)));

  storage.setItem(CART_KEY, serializeCart(addItem(emptyCart(), B, 4))); // "la otra pestaña" guardó
  handlers.forEach((h) => h({ key: CART_KEY }));
  assert.equal(s.count(), 4);

  handlers.forEach((h) => h({ key: "otra.clave" })); // otra clave: se ignora
  assert.deepEqual(seen, [4]);

  storage.data.clear(); // la otra pestaña vació todo el almacenamiento (key === null)
  handlers.forEach((h) => h({ key: null }));
  assert.equal(s.count(), 0);
});

Deno.test("store.replace: limpia lo que le pasen antes de aceptarlo", () => {
  const s = createCartStore({ storage: fakeStorage() });
  s.replace({ items: [{ id: A, qty: 3, price_cents: 1 }, { id: "x", qty: 1 }] });
  assert.deepEqual(s.get().items, [{ id: A, qty: 3 }]);
});

// ------------------------------------------------------------------ validación contra los productos reales

const product = (id, extra = {}) => ({ id, title: "Mat", price_cents: 2500, stock: null, ...extra });

Deno.test("validateCart: todo disponible -> ok y subtotal en céntimos enteros", () => {
  const cart = addItem(addItem(emptyCart(), A, 2), B, 1);
  const r = validateCart(cart, [product(A, { price_cents: 1999, stock: 10 }), product(B, { price_cents: 350 })]);
  assert.equal(r.ok, true);
  assert.equal(r.issues, 0);
  assert.equal(r.subtotalCents, 1999 * 2 + 350);
  assert.ok(Number.isInteger(r.subtotalCents));
  assert.deepEqual(r.lines.map((l) => l.status), ["ok", "ok"]);
  assert.deepEqual(r.fixedCart.items, cart.items);
});

Deno.test("validateCart: carrito vacío no es 'ok' (no hay nada que pagar)", () => {
  const r = validateCart(emptyCart(), [product(A)]);
  assert.equal(r.ok, false);
  assert.equal(r.subtotalCents, 0);
  assert.equal(validateCart(emptyCart(), null).ok, false);
});

Deno.test("validateCart: agotado, oculto/borrado y pedido de más se detectan y se corrigen", () => {
  const cart = addItem(addItem(addItem(emptyCart(), A, 2), B, 1), C, 6);
  const r = validateCart(cart, [
    product(A, { stock: 0 }), // agotado
    // B no viene: está oculto o se borró
    product(C, { stock: 4, price_cents: 1000 }), // pedías 6, quedan 4
  ]);
  const byId = Object.fromEntries(r.lines.map((l) => [l.id, l]));
  assert.equal(byId[A].status, "soldout");
  assert.equal(byId[B].status, "unavailable");
  assert.equal(byId[C].status, "reduced");
  assert.equal(byId[C].qty, 4);
  assert.equal(byId[C].requestedQty, 6);
  assert.equal(r.ok, false);
  assert.equal(r.issues, 3);
  assert.equal(r.subtotalCents, 4000); // solo cuenta lo que realmente se puede comprar
  assert.deepEqual(r.fixedCart.items, [{ id: C, qty: 4 }]);
});

Deno.test("validateCart: una vez corregido con fixedCart, vuelve a dar ok", () => {
  const cart = addItem(addItem(emptyCart(), A, 5), B, 1);
  const products = [product(A, { stock: 2 })];
  const first = validateCart(cart, products);
  assert.equal(first.ok, false);
  const second = validateCart(first.fixedCart, products);
  assert.equal(second.ok, true);
  assert.equal(second.subtotalCents, 5000);
});

Deno.test("validateCart: el precio sale SIEMPRE de la base, no de lo guardado en el navegador", () => {
  // Alguien edita el almacenamiento para pagar 1 céntimo: el precio inyectado se descarta al leer...
  const tampered = parseCart(JSON.stringify({ v: 1, items: [{ id: A, qty: 1, price_cents: 1 }] }));
  // ...y la validación usa el precio real de la base.
  const r = validateCart(tampered, [product(A, { price_cents: 4500 })]);
  assert.equal(r.subtotalCents, 4500);
  assert.equal(r.lines[0].unitCents, 4500);
});

Deno.test("validateCart: un precio inválido en la base se trata como no disponible, nunca como gratis", () => {
  const cart = addItem(emptyCart(), A);
  for (const bad of [null, undefined, -5, NaN, "abc", 12.5]) {
    const r = validateCart(cart, [product(A, { price_cents: bad })]);
    assert.equal(r.lines[0].status, "unavailable", String(bad));
    assert.equal(r.ok, false);
    assert.equal(r.subtotalCents, 0);
  }
  // un producto gratis de verdad (0) sí es válido
  assert.equal(validateCart(cart, [product(A, { price_cents: 0 })]).ok, true);
});

Deno.test("validateCart: stock null = sin control; el tope general igual aplica", () => {
  const cart = parseCart({ v: 1, items: [{ id: A, qty: 7 }] });
  assert.equal(validateCart(cart, [product(A, { stock: null })]).ok, true);
});

// ------------------------------------------------------------------ localStorage real del navegador

/** Reemplaza `globalThis.localStorage` durante la prueba y lo restaura (simula lo que hace cada navegador). */
function withLocalStorage(descriptor, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, ...descriptor });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
}

Deno.test("browserStorage: usa localStorage si funciona", () => {
  const storage = fakeStorage();
  withLocalStorage({ value: storage }, () => assert.equal(browserStorage(), storage));
});

Deno.test("browserStorage: null si acceder o escribir lanza (cookies bloqueadas, modo privado), y el store sigue andando", () => {
  withLocalStorage({
    get: () => {
      throw new DOMException("denied", "SecurityError");
    },
  }, () => {
    assert.equal(browserStorage(), null);
    const s = createCartStore(); // toma el almacenamiento por defecto
    s.add(A, 2);
    assert.equal(s.count(), 2);
    assert.equal(s.persistent, false);
  });
  const readonly = {
    ...fakeStorage(),
    setItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
  withLocalStorage({ value: readonly }, () => assert.equal(browserStorage(), null));
  withLocalStorage({ value: undefined }, () => assert.equal(browserStorage(), null));
});

Deno.test("browserStorage: la prueba de escritura no deja basura en el almacenamiento", () => {
  const storage = fakeStorage();
  withLocalStorage({ value: storage }, () => browserStorage());
  assert.equal(storage.data.size, 0);
});
