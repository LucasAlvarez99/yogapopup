import { HttpError } from "../http.ts";
import { parseUuid } from "../validate.ts";
import type { PayPalPort, ShipTo } from "../paypal/paypal.types.ts";
import type { CartItemInput, PaymentDeps } from "./ports.ts";

/** 503 si faltan las credenciales de PayPal (así el resto del sitio sigue funcionando mientras se configuran). */
export function requirePayPal(deps: PaymentDeps): PayPalPort {
  if (!deps.paypal) throw new HttpError(503, "payments_not_configured", "Payments are not configured");
  return deps.paypal;
}

/** Nivel de suscripción: 1, 2 o 3. */
export function parseTier(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new HttpError(400, "invalid_input", "tier must be 1, 2 or 3");
  }
  return value;
}

const PAYPAL_ID_RE = /^[A-Za-z0-9_-]{5,64}$/;

export function parsePayPalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !PAYPAL_ID_RE.test(value)) {
    throw new HttpError(400, "invalid_input", `${field} is not valid`);
  }
  return value;
}

/**
 * Carrito que manda el navegador. De cada línea se toma SOLO el tipo, el id, el talle y la cantidad: cualquier otro
 * campo (un `price_cents` inyectado, por ejemplo) se descarta acá y, de todos modos, el precio sale de la base.
 */
export function parseCartItems(body: Record<string, unknown>): CartItemInput[] {
  const raw = body.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 30) {
    throw new HttpError(400, "invalid_cart", "items must be a list of 1 to 30 lines");
  }
  return raw.map((line): CartItemInput => {
    if (line === null || typeof line !== "object" || Array.isArray(line)) {
      throw new HttpError(400, "invalid_cart", "each line must be an object");
    }
    const l = line as Record<string, unknown>;
    if (l.type === "class") return { type: "class", id: parseUuid(l.id, "id") };
    if (l.type === "product") {
      const qty = l.qty;
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 10) {
        throw new HttpError(400, "invalid_cart", "qty must be an integer between 1 and 10");
      }
      const variant = l.variant_id === undefined || l.variant_id === null
        ? null
        : parseUuid(l.variant_id, "variant_id");
      return { type: "product", id: parseUuid(l.id, "id"), variant_id: variant, qty };
    }
    throw new HttpError(400, "invalid_cart", "type must be product or class");
  });
}

/**
 * URL a la que PayPal vuelve tras aprobar una suscripción. Solo se acepta si su ORIGEN está en ALLOWED_ORIGINS
 * (nunca una URL cualquiera que mande el navegador: sería una redirección abierta). Si no, se usa el primer origen
 * https permitido.
 */
export function safeReturnUrl(candidate: unknown, allowedOrigins: string[]): string | undefined {
  if (typeof candidate === "string" && candidate.length <= 500) {
    try {
      const u = new URL(candidate);
      if (
        (u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1") &&
        allowedOrigins.includes(u.origin)
      ) {
        return u.href;
      }
    } catch { /* se usa el valor por defecto */ }
  }
  const fallback = allowedOrigins.find((o) => o.startsWith("https://"));
  return fallback ? `${fallback}/` : undefined;
}

/** Comparación en tiempo constante (no revela cuántos caracteres coinciden). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

// Caracteres de control (saltos de línea, tabulaciones…) no tienen lugar en una dirección.
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const PHONE_RE = /^\+?[0-9][0-9 ()\-]{5,19}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function shipText(
  raw: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  required = true,
): string | null {
  const v = raw[field];
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (!required) return null;
    throw new HttpError(400, "invalid_address", `${field} is required`);
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_address", `${field} must be text`);
  const t = v.trim().replace(/ +/g, " ");
  if (t.length < min || t.length > max || CONTROL_RE.test(t)) {
    throw new HttpError(400, "invalid_address", `${field} is not valid`);
  }
  return t;
}

/**
 * Domicilio y contacto del pop up de envío. Se valida todo acá (el navegador solo ayuda): sin esto no hay pedido con
 * productos físicos. Solo se envía a España; el resto de los campos se recortan y se descartan los desconocidos.
 */
export function parseShipTo(value: unknown): ShipTo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_address", "ship_to is required for orders with products");
  }
  const r = value as Record<string, unknown>;
  const country = shipText(r, "country_code", 2, 2)!.toUpperCase();
  if (country !== "ES") throw new HttpError(400, "invalid_address", "We only ship to Spain");
  const phone = shipText(r, "phone", 6, 20)!;
  if (!PHONE_RE.test(phone)) throw new HttpError(400, "invalid_address", "phone is not valid");
  const email = shipText(r, "email", 5, 254)!;
  if (!EMAIL_RE.test(email)) throw new HttpError(400, "invalid_address", "email is not valid");
  const postal = shipText(r, "postal_code", 5, 5)!;
  if (!/^[0-9]{5}$/.test(postal)) throw new HttpError(400, "invalid_address", "postal_code is not valid");
  return {
    name: shipText(r, "name", 2, 100)!,
    address_line_1: shipText(r, "address_line_1", 3, 120)!,
    address_line_2: shipText(r, "address_line_2", 1, 120, false),
    postal_code: postal,
    city: shipText(r, "city", 2, 80)!,
    region: shipText(r, "region", 2, 80)!,
    country_code: country,
    phone,
    email,
  };
}
