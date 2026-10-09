import { HttpError } from "../http.ts";
import { parseUuid } from "../validate.ts";
import type { PayPalPort } from "../paypal/paypal.types.ts";
import type { CartItemInput, PaymentDeps } from "./ports.ts";

/** 503 si faltan las credenciales de PayPal (así el resto del sitio sigue funcionando mientras se configuran). */
export function requirePayPal(deps: PaymentDeps): PayPalPort {
  if (!deps.paypal) throw new HttpError(503, "payments_not_configured", "Payments are not configured");
  return deps.paypal;
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
