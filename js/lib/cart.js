/**
 * Carrito (Fase 15): estado, persistencia en el navegador y validación de stock.
 *
 * Decisiones:
 *  - El carrito guarda SOLO `{ id, qty }` por línea. Nunca precios ni títulos: el navegador no es de fiar
 *    (cualquiera puede editar `localStorage`), así que el precio y el stock se leen siempre de la base al
 *    mostrar o validar el carrito. Un precio viejo guardado no puede llegar a cobrarse.
 *  - La lógica es pura (sin DOM ni `window`): recibe el almacenamiento por parámetro, así se prueba en tests/web.
 *  - No hace falta sesión para armar el carrito; cerrar sesión no lo vacía.
 *  - Esta validación es para la interfaz (avisar antes de ir a pagar). La autoridad real es el servidor:
 *    la Edge Function del checkout (Fase 18) vuelve a validar precio y stock antes de crear la orden.
 */
import { isUuid } from "./format.js";

export const CART_KEY = "yp.cart";
export const CART_VERSION = 1;
/** Tope de unidades de un mismo producto (aunque el stock no se controle). */
export const MAX_QTY_PER_ITEM = 10;
/** Tope de productos distintos, para que lo guardado siga siendo chico. */
export const MAX_LINES = 30;

export const emptyCart = () => ({ items: [] });

const isQty = (n) => Number.isInteger(n) && n >= 1;

/** Máximo de unidades permitido para un producto según su stock (`null` = no se controla). */
export function limitFor(stock) {
  if (stock === null || stock === undefined) return MAX_QTY_PER_ITEM;
  const n = Number(stock);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_QTY_PER_ITEM, Math.floor(n));
}

// ------------------------------------------------------------------ lectura segura (datos no confiables)

/**
 * Convierte lo que haya en el almacenamiento (texto, objeto o basura) en un carrito válido.
 * Nunca lanza: lo corrupto o manipulado se descarta.
 */
export function parseCart(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return emptyCart();
    }
  }
  if (!data || typeof data !== "object" || data.v !== CART_VERSION || !Array.isArray(data.items)) return emptyCart();

  const byId = new Map();
  for (const it of data.items) {
    if (!it || typeof it !== "object" || !isUuid(it.id) || !isQty(it.qty)) continue;
    const id = it.id.toLowerCase();
    byId.set(id, Math.min(MAX_QTY_PER_ITEM, (byId.get(id) ?? 0) + it.qty)); // duplicados: se suman
    if (byId.size >= MAX_LINES) break;
  }
  // Se reconstruye cada línea con solo id y qty: cualquier otro campo (un `price_cents` inyectado) se tira.
  return { items: [...byId].map(([id, qty]) => ({ id, qty })) };
}

/** Texto para guardar. Solo versión + líneas `{id, qty}`. */
export const serializeCart = (cart) => JSON.stringify({ v: CART_VERSION, items: cart.items.map(({ id, qty }) => ({ id, qty })) });

// ------------------------------------------------------------------ operaciones puras (devuelven un carrito nuevo)

const assertId = (id) => {
  if (!isUuid(id)) throw new TypeError("cart: id de producto inválido");
};
const assertQty = (qty) => {
  if (!isQty(qty)) throw new TypeError("cart: la cantidad debe ser un entero mayor o igual a 1");
};

/** Unidades de un producto en el carrito (0 si no está). */
export const qtyOf = (cart, id) => cart.items.find((i) => i.id === String(id).toLowerCase())?.qty ?? 0;

/** Total de unidades (lo que muestra el ícono del carrito). */
export const cartCount = (cart) => cart.items.reduce((sum, i) => sum + i.qty, 0);

/**
 * Suma unidades. Con `stock` no deja pasar de lo disponible; siempre respeta MAX_QTY_PER_ITEM.
 * Si ya no se puede sumar más (tope o agotado), el carrito queda igual.
 */
export function addItem(cart, id, qty = 1, { stock = null } = {}) {
  assertId(id);
  assertQty(qty);
  id = id.toLowerCase();
  const limit = limitFor(stock);
  const current = qtyOf(cart, id);
  const next = Math.min(limit, current + qty);
  if (next <= 0 || next === current) return cart;
  if (current === 0) {
    if (cart.items.length >= MAX_LINES) return cart;
    return { items: [...cart.items, { id, qty: next }] };
  }
  return { items: cart.items.map((i) => (i.id === id ? { id, qty: next } : i)) };
}

/** Fija la cantidad exacta. 0 quita la línea. Con `stock` la limita a lo disponible. */
export function setQty(cart, id, qty, { stock = null } = {}) {
  assertId(id);
  if (qty !== 0) assertQty(qty);
  id = id.toLowerCase();
  if (qty === 0) return removeItem(cart, id);
  const next = Math.min(limitFor(stock), qty);
  if (next <= 0) return removeItem(cart, id);
  if (qtyOf(cart, id) === 0) return addItem(cart, id, next, { stock });
  return { items: cart.items.map((i) => (i.id === id ? { id, qty: next } : i)) };
}

export function removeItem(cart, id) {
  assertId(id);
  id = id.toLowerCase();
  return cart.items.some((i) => i.id === id) ? { items: cart.items.filter((i) => i.id !== id) } : cart;
}

export const clearCart = () => emptyCart();

// ------------------------------------------------------------------ almacenamiento

/** `localStorage` del navegador, o null si no se puede usar (modo privado estricto, cookies bloqueadas). */
export function browserStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = "__yp_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Carrito con persistencia. `storage` es cualquier objeto con getItem/setItem/removeItem (por defecto
 * localStorage); si no existe o falla, el carrito sigue funcionando en memoria mientras la pestaña esté abierta.
 * `target` (por ejemplo `window`) sirve para enterarse de cambios hechos desde otra pestaña.
 */
export function createCartStore({ storage = browserStorage(), key = CART_KEY, target = null } = {}) {
  let cart = emptyCart();
  let persistent = storage !== null && storage !== undefined;
  const listeners = new Set();

  const read = () => {
    if (!storage) return emptyCart();
    try {
      return parseCart(storage.getItem(key));
    } catch {
      persistent = false;
      return emptyCart();
    }
  };
  const write = () => {
    if (!storage) return;
    try {
      if (cart.items.length === 0) storage.removeItem(key);
      else storage.setItem(key, serializeCart(cart));
      persistent = true;
    } catch {
      persistent = false; // cuota llena o almacenamiento bloqueado: se sigue en memoria
    }
  };
  const notify = () => {
    for (const fn of [...listeners]) {
      try {
        fn(cart);
      } catch { /* un oyente roto no debe afectar a los demás */ }
    }
  };
  const commit = (next) => {
    if (next === cart) return cart;
    cart = next;
    write();
    notify();
    return cart;
  };

  cart = read();

  target?.addEventListener?.("storage", (e) => {
    if (e.key !== null && e.key !== key) return; // e.key === null: se vació todo el almacenamiento
    cart = read();
    notify();
  });

  return {
    get: () => cart,
    count: () => cartCount(cart),
    /** false si lo último que se intentó guardar falló: el carrito no sobrevivirá a cerrar la pestaña. */
    get persistent() {
      return persistent;
    },
    add: (id, qty = 1, opts) => commit(addItem(cart, id, qty, opts)),
    setQty: (id, qty, opts) => commit(setQty(cart, id, qty, opts)),
    remove: (id) => commit(removeItem(cart, id)),
    /** Reemplaza el carrito (por ejemplo con el `fixedCart` de la validación). */
    replace: (next) => commit(parseCart({ v: CART_VERSION, items: next.items })),
    clear: () => commit(cart.items.length ? clearCart() : cart),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ------------------------------------------------------------------ validación contra los productos reales

/**
 * Compara el carrito con los productos ACTIVOS que devuelve la base (por ejemplo `await listActiveProducts()`).
 * Precios y stock salen de ahí, nunca del carrito guardado.
 *
 * Cada línea tiene un `status`:
 *  - "ok":          todo bien.
 *  - "reduced":     pedías más de lo que hay; se baja a `qty` (el stock).
 *  - "soldout":     el producto existe pero está agotado.
 *  - "unavailable": ya no existe, o está oculto.
 *
 * @returns {{
 *   lines: Array<{ id: string, status: string, requestedQty: number, qty: number, product: object|null,
 *                  unitCents: number, lineCents: number }>,
 *   subtotalCents: number, issues: number, ok: boolean, fixedCart: { items: Array<{id:string, qty:number}> }
 * }} `ok` es true solo si hay algo en el carrito y ninguna línea tiene problemas.
 */
export function validateCart(cart, activeProducts) {
  const byId = new Map();
  for (const p of activeProducts ?? []) if (p && isUuid(p.id)) byId.set(p.id.toLowerCase(), p);

  const lines = cart.items.map(({ id, qty: requestedQty }) => {
    const product = byId.get(id) ?? null;
    const base = { id, requestedQty, product };
    // Sin `Number(...)`: Number(null) === 0 convertiría un precio ausente en "gratis".
    const price = product?.price_cents;
    if (!product || !Number.isSafeInteger(price) || price < 0) {
      return { ...base, product: null, status: "unavailable", qty: 0, unitCents: 0, lineCents: 0 };
    }
    const limit = limitFor(product.stock);
    if (limit === 0) return { ...base, status: "soldout", qty: 0, unitCents: price, lineCents: 0 };
    const qty = Math.min(requestedQty, limit);
    return {
      ...base,
      status: qty < requestedQty ? "reduced" : "ok",
      qty,
      unitCents: price,
      lineCents: price * qty,
    };
  });

  const issues = lines.filter((l) => l.status !== "ok").length;
  return {
    lines,
    subtotalCents: lines.reduce((sum, l) => sum + l.lineCents, 0),
    issues,
    ok: lines.length > 0 && issues === 0,
    fixedCart: { items: lines.filter((l) => l.qty > 0).map((l) => ({ id: l.id, qty: l.qty })) },
  };
}
