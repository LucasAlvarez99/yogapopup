/**
 * Piezas puras del asistente de PayPal (scripts/paypal-setup.mjs): cuerpos de las llamadas y lectura de argumentos.
 * Están separadas del script para probarlas sin red (tests/web/paypal-setup.test.js).
 */

/** Eventos que el webhook necesita. DEBE coincidir con los que maneja supabase/functions/_shared/payments/logic.ts (hay un test que lo comprueba). */
export const WEBHOOK_EVENTS = [
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.PENDING',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.DECLINED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.REVERSED',
  'BILLING.SUBSCRIPTION.CREATED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.RE-ACTIVATED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
];

export const API = { sandbox: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com' };

/** "9.99" | "9,99" -> 999. Devuelve null si no es un precio válido con a lo sumo 2 decimales. */
export function priceToCents(text) {
  const m = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return cents > 0 ? cents : null;
}

const centsToValue = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

export function buildProductBody(name) {
  return { name: String(name).slice(0, 127), description: 'Suscripción a la videoteca', type: 'SERVICE' };
}

/** Plan de cobro recurrente (sin fin), en EUR, con el IVA INCLUIDO en el precio (igual que la tienda). */
export function buildPlanBody({ productId, name, priceCents, interval = 'MONTH', taxPercent = 21 }) {
  if (!['MONTH', 'YEAR'].includes(interval)) throw new Error('interval debe ser MONTH o YEAR');
  if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error('priceCents inválido');
  return {
    product_id: productId,
    name: String(name).slice(0, 127),
    description: String(name).slice(0, 127),
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: interval, interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0, // 0 = hasta que la persona cancele
      pricing_scheme: { fixed_price: { value: centsToValue(priceCents), currency_code: 'EUR' } },
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: 'CANCEL',
      payment_failure_threshold: 3,
    },
    taxes: { percentage: String(taxPercent), inclusive: true },
  };
}

export function buildWebhookBody(url) {
  if (!/^https:\/\/[^\s]+$/.test(String(url))) throw new Error('la URL del webhook debe ser https://...');
  return { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) };
}

/** --clave valor  |  --bandera */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
