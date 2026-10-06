/**
 * Carrito (Fase 15): estado, persistencia en el navegador y validación de stock.
 *
 * Decisiones:
 *  - El carrito guarda SOLO `{ id, qty }` por línea (y `variant`, el id del talle, si el producto tiene talles). Nunca precios ni títulos: el navegador no es de fiar
 *    (cualquiera puede editar `localStorage`), así que el precio y el stock se leen siempre de la base al
 *    mostrar o validar el carrito. Un precio viejo guardado no puede llegar a cobrarse.
 *  - La lógica es pura (sin DOM ni `window`): recibe el almacenamiento por parámetro, así se prueba en tests/web.
 *  - No hace falta sesión para armar el carrito; cerrar sesión no lo vacía.
 *  - Esta validación es para la interfaz (avisar antes de ir a pagar). La autoridad real es el servidor:
 *    la Edge Function del checkout (Fase 18) vuelve a validar precio y stock antes de crear la orden.
 */
import { isUuid } from "./format.js";
import { findVariant, sortedVariants } from "./sizes.js";
import { normalizeRate, splitTax } from "./tax.js";

export const CART_KEY = "yp.cart";
export const CART_VERSION = 1;
/** Tope de unidades de un mismo producto (aunque el stock no se controle). */
export const MAX_QTY_PER_ITEM = 10;
/** Tope de productos distintos, para que lo guardado siga siendo chico. */
export const MAX_LINES = 30;

export const emptyCart = () => ({ items: [] });

const isQty = (n) => Number.isInteger(n) && n >= 1;

/** Clave de una línea: producto + talle (o solo el producto si no tiene talles). */
const keyOf = (id, variant) => `${id}|${variant ?? ""}`;
/** Forma guardada de una línea: `variant` solo aparece si hay talle (los carritos viejos no lo tienen). */
const lineOf = ({ id, variant = null, qty }) => (variant ? { id, variant, qty } : { id, qty });

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

  // Una línea es (producto, talle): el mismo producto en dos talles son dos líneas.
  const byKey = new Map();
  for (const it of data.items) {
    if (!it || typeof it !== "object" || !isUuid(it.id) || !isQty(it.qty)) continue;
    const hasVariant = it.variant !== undefined && it.variant !== null;
    if (hasVariant && !isUuid(it.variant)) continue; // un talle manipulado descarta la línea
    const id = it.id.toLowerCase();
    const variant = hasVariant ? it.variant.toLowerCase() : null;
    const key = keyOf(id, variant);
    const prev = byKey.get(key);
    byKey.set(key, { id, variant, qty: Math.min(MAX_QTY_PER_ITEM, (prev?.qty ?? 0) + it.qty) }); // duplicados: se suman
    if (byKey.size >= MAX_LINES) break;
  }
  // Se reconstruye cada línea solo con sus campos conocidos: cualquier otro (un `price_cents` inyectado) se tira.
  return { items: [...byKey.values()].map(lineOf) };
}

/** Texto para guardar. Solo versión + líneas `{id, qty}` (con `variant` cuando hay talle). */
export const serializeCart = (cart) => JSON.stringify({ v: CART_VERSION, items: cart.items.map(lineOf) });

// ------------------------------------------------------------------ operaciones puras (devuelven un carrito nuevo)

const assertId = (id) => {
  if (!isUuid(id)) throw new TypeError("cart: id de producto inválido");
};
const assertQty = (qty) => {
  if (!isQty(qty)) throw new TypeError("cart: la cantidad debe ser un entero mayor o igual a 1");
};
/** El talle es opcional, pero si se indica tiene que ser un id válido. */
const normVariant = (variant) => {
  if (variant === null || variant === undefined) return null;
  if (!isUuid(variant)) throw new TypeError("cart: id de talle inválido");
  return variant.toLowerCase();
};
const same = (id, variant) => (i) => i.id === id && (i.variant ?? null) === variant;

/** Unidades de un producto (en un talle, si se indica) en el carrito (0 si no está). */
export const qtyOf = (cart, id, variant = null) =>
  cart.items.find(same(String(id).toLowerCase(), variant ? String(variant).toLowerCase() : null))?.qty ?? 0;

/** Total de unidades (lo que muestra el ícono del carrito). */
export const cartCount = (cart) => cart.items.reduce((sum, i) => sum + i.qty, 0);

/**
 * Suma unidades. Con `stock` no deja pasar de lo disponible (el del talle, si hay talle); siempre respeta MAX_QTY_PER_ITEM.
 * Si ya no se puede sumar más (tope o agotado), el carrito queda igual.
 */
export function addItem(cart, id, qty = 1, { stock = null, variant = null } = {}) {
  assertId(id);
  assertQty(qty);
  id = id.toLowerCase();
  variant = normVariant(variant);
  const limit = limitFor(stock);
  const current = qtyOf(cart, id, variant);
  const next = Math.min(limit, current + qty);
  if (next <= 0 || next === current) return cart;
  if (current === 0) {
    if (cart.items.length >= MAX_LINES) return cart;
    return { items: [...cart.items, lineOf({ id, variant, qty: next })] };
  }
  return { items: cart.items.map((i) => (same(id, variant)(i) ? lineOf({ id, variant, qty: next }) : i)) };
}

/** Fija la cantidad exacta. 0 quita la línea. Con `stock` la limita a lo disponible. */
export function setQty(cart, id, qty, { stock = null, variant = null } = {}) {
  assertId(id);
  if (qty !== 0) assertQty(qty);
  id = id.toLowerCase();
  variant = normVariant(variant);
  if (qty === 0) return removeItem(cart, id, variant);
  const next = Math.min(limitFor(stock), qty);
  if (next <= 0) return removeItem(cart, id, variant);
  if (qtyOf(cart, id, variant) === 0) return addItem(cart, id, next, { stock, variant });
  return { items: cart.items.map((i) => (same(id, variant)(i) ? lineOf({ id, variant, qty: next }) : i)) };
}

export function removeItem(cart, id, variant = null) {
  assertId(id);
  id = id.toLowerCase();
  variant = normVariant(variant);
  return cart.items.some(same(id, variant)) ? { items: cart.items.filter((i) => !same(id, variant)(i)) } : cart;
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
    remove: (id, variant = null) => commit(removeItem(cart, id, variant)),
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
 * Compara el carrito con los productos ACTIVOS que devuelve la base (por ejemplo `await listActiveProducts()`, que
 * incluye sus talles). Precios, stock e IVA salen de ahí, nunca del carrito guardado.
 *
 * Cada línea tiene un `status`:
 *  - "ok":          todo bien.
 *  - "reduced":     pedías más de lo que hay; se baja a `qty` (el stock).
 *  - "soldout":     el producto (o ese talle) existe pero está agotado.
 *  - "needs_size":  el producto tiene talles y la línea no eligió ninguno (carritos anteriores a los talles).
 *  - "unavailable": ya no existe, está oculto, o ese talle ya no existe.
 *
 * Con talles, el stock que cuenta es el DEL TALLE; sin talles, el del producto.
 *
 * @returns {{
 *   lines: Array<{ id: string, variant: string|null, size: string|null, status: string, requestedQty: number, qty: number,
 *                  product: object|null, stock: number|null, unitCents: number, lineCents: number, taxRateBps: number }>,
 *   subtotalCents: number, taxCents: number, netCents: number, issues: number, ok: boolean,
 *   fixedCart: { items: Array<{id:string, variant?:string, qty:number}> }
 * }} `ok` es true solo si hay algo en el carrito y ninguna línea tiene problemas.
 *   `taxCents` es el IVA INCLUIDO en el subtotal (informativo); `netCents` = subtotal − IVA.
 */
export function validateCart(cart, activeProducts) {
  const byId = new Map();
  for (const p of activeProducts ?? []) if (p && isUuid(p.id)) byId.set(p.id.toLowerCase(), p);

  const lines = cart.items.map(({ id, variant = null, qty: requestedQty }) => {
    const product = byId.get(id) ?? null;
    const base = { id, variant, size: null, requestedQty, product, stock: null, taxRateBps: normalizeRate(product?.tax_rate_bps) };
    // Sin `Number(...)`: Number(null) === 0 convertiría un precio ausente en "gratis".
    const price = product?.price_cents;
    if (!product || !Number.isSafeInteger(price) || price < 0) {
      return { ...base, product: null, status: "unavailable", qty: 0, unitCents: 0, lineCents: 0 };
    }

    let stock = product.stock;
    if (sortedVariants(product).length > 0) {
      if (!variant) return { ...base, status: "needs_size", qty: 0, unitCents: price, lineCents: 0 };
      const chosen = findVariant(product, variant);
      if (!chosen) return { ...base, status: "unavailable", qty: 0, unitCents: price, lineCents: 0 }; // ese talle ya no existe
      stock = chosen.stock;
      base.size = chosen.size;
    } else if (variant) {
      return { ...base, status: "unavailable", qty: 0, unitCents: price, lineCents: 0 }; // el producto ya no tiene talles
    }
    base.stock = stock;

    const limit = limitFor(stock);
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
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineCents, 0);
  const taxCents = lines.reduce((sum, l) => sum + (splitTax(l.lineCents, l.taxRateBps)?.taxCents ?? 0), 0);
  return {
    lines,
    subtotalCents,
    taxCents,
    netCents: subtotalCents - taxCents,
    issues,
    ok: lines.length > 0 && issues === 0,
    fixedCart: { items: lines.filter((l) => l.qty > 0).map((l) => lineOf({ id: l.id, variant: l.variant, qty: l.qty })) },
  };
}
