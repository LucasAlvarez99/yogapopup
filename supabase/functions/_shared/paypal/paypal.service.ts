import { centsToValue, valueToCents } from "./money.ts";
import type {
  CreateOrderInput,
  CreateSubscriptionInput,
  PayPalCapture,
  PayPalConfig,
  PayPalOrder,
  PayPalPort,
  PayPalRefund,
  PayPalShipping,
  PayPalSubscription,
  WebhookVerifyInput,
} from "./paypal.types.ts";

const BASE_URL = { sandbox: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;
const ID_RE = /^[A-Za-z0-9_-]{5,64}$/;

/** Error de la capa PayPal. Nunca incluye credenciales ni cuerpos completos en el mensaje. */
export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly operation: string,
    /** Código de detalle de PayPal (p. ej. ORDER_ALREADY_CAPTURED, INSTRUMENT_DECLINED), si lo informó. */
    public readonly issue: string | null = null,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

function pathId(id: string, what: string): string {
  if (!ID_RE.test(id)) throw new PayPalError(`invalid ${what} id`, 400, "validate");
  return id;
}

/**
 * Único punto del sistema que habla con PayPal (REST v1/v2). Corre solo en el backend: el secreto nunca llega al
 * navegador. Cada respuesta se VALIDA antes de usarse (montos como cadenas estrictas, ids acotados): lo que PayPal
 * devuelve se trata con el mismo cuidado que lo que manda el navegador.
 */
export class PayPalService implements PayPalPort {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;

  constructor(private readonly cfg: PayPalConfig) {
    if (!cfg.clientId) throw new Error("PAYPAL_CLIENT_ID is required");
    if (!cfg.clientSecret) throw new Error("PAYPAL_CLIENT_SECRET is required");
    if (cfg.env !== "sandbox" && cfg.env !== "live") throw new Error("PAYPAL_ENV must be sandbox or live");
    this.base = BASE_URL[cfg.env];
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.now = cfg.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.timeoutMs = cfg.requestTimeoutMs ?? 15_000;
  }

  // ------------------------------------------------------------------ transporte

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60 > this.now()) return this.token.value;
    if (this.tokenInFlight) return await this.tokenInFlight;
    this.tokenInFlight = (async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${this.cfg.clientId}:${this.cfg.clientSecret}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new PayPalError("PayPal token request failed (network)", 0, "token");
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new PayPalError(`PayPal token request failed (${res.status})`, res.status, "token");
      }
      const data = await res.json().catch(() => null);
      const value = isObj(data) ? str(data.access_token, 2000) : null;
      const expiresIn = isObj(data) && typeof data.expires_in === "number" ? data.expires_in : 0;
      if (!value || expiresIn <= 0) throw new PayPalError("PayPal token response is invalid", 502, "token");
      this.token = { value, expiresAt: this.now() + expiresIn };
      return value;
    })().finally(() => {
      this.tokenInFlight = null;
    });
    return await this.tokenInFlight;
  }

  private async request(
    operation: string,
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Json | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            ...opts.headers,
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new PayPalError(`PayPal ${operation} failed (network)`, 0, operation);
      }
      if (res.status === 401 && attempt === 0) { // token vencido o revocado: se pide uno nuevo y se reintenta una vez
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const details = isObj(data) && Array.isArray(data.details) ? data.details : [];
        const first = details.find(isObj);
        const issue = (first ? str(first.issue, 80) : null) ?? (isObj(data) ? str(data.name, 80) : null);
        throw new PayPalError(
          `PayPal ${operation} failed (${res.status}${issue ? ` ${issue}` : ""})`,
          res.status,
          operation,
          issue,
        );
      }
      if (!isObj(data)) throw new PayPalError(`PayPal ${operation} returned an invalid body`, 502, operation);
      return data;
    }
    throw new PayPalError(`PayPal ${operation} unauthorized`, 401, operation);
  }

  // ------------------------------------------------------------------ pedidos (Orders v2)

  async createOrder(input: CreateOrderInput): Promise<{ id: string }> {
    const items = input.items.map((i) => ({
      name: i.name.slice(0, 127),
      quantity: String(i.qty),
      unit_amount: { currency_code: "EUR", value: centsToValue(i.unitCents) },
      category: i.digital ? "DIGITAL_GOODS" : "PHYSICAL_GOODS",
    }));
    const itemTotal = input.items.reduce((sum, i) => sum + i.unitCents * i.qty, 0);
    if (itemTotal !== input.totalCents) {
      throw new PayPalError("order total does not match its items", 400, "createOrder");
    }
    const data = await this.request("createOrder", "POST", "/v2/checkout/orders", {
      headers: { "PayPal-Request-Id": `yp-order-${input.orderId}`, Prefer: "return=representation" },
      body: {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: "default",
          custom_id: input.orderId,
          invoice_id: input.orderId,
          description: input.description.slice(0, 127),
          amount: {
            currency_code: "EUR",
            value: centsToValue(input.totalCents),
            breakdown: { item_total: { currency_code: "EUR", value: centsToValue(input.totalCents) } },
          },
          items,
        }],
        application_context: {
          brand_name: input.brandName.slice(0, 127),
          locale: "es-ES",
          shipping_preference: input.shipping === "address" ? "GET_FROM_FILE" : "NO_SHIPPING",
          user_action: "PAY_NOW",
        },
      },
    });
    const id = str(data?.id, 64);
    if (!id || !ID_RE.test(id)) throw new PayPalError("PayPal createOrder returned an invalid id", 502, "createOrder");
    return { id };
  }

  async getOrder(paypalOrderId: string): Promise<PayPalOrder> {
    const data = await this.request("getOrder", "GET", `/v2/checkout/orders/${pathId(paypalOrderId, "order")}`);
    return parseOrder(data, "getOrder");
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<PayPalOrder> {
    try {
      const data = await this.request(
        "captureOrder",
        "POST",
        `/v2/checkout/orders/${pathId(paypalOrderId, "order")}/capture`,
        {
          headers: { "PayPal-Request-Id": requestId.slice(0, 108), Prefer: "return=representation" },
          body: {},
        },
      );
      return parseOrder(data, "captureOrder");
    } catch (e) {
      // Ya estaba capturada (el webhook o un reintento se adelantó): no es un error, se lee el estado actual.
      if (e instanceof PayPalError && e.status === 422 && e.issue === "ORDER_ALREADY_CAPTURED") {
        return await this.getOrder(paypalOrderId);
      }
      throw e;
    }
  }

  async getRefund(refundId: string): Promise<PayPalRefund> {
    const data = await this.request("getRefund", "GET", `/v2/payments/refunds/${pathId(refundId, "refund")}`);
    const id = str(data?.id, 64);
    const amount = isObj(data?.amount) ? data.amount : null;
    const cents = valueToCents(amount?.value);
    const currency = str(amount?.currency_code, 3);
    const status = str(data?.status, 40);
    if (!id || cents === null || !currency || !status) {
      throw new PayPalError("PayPal refund is invalid", 502, "getRefund");
    }
    const up = Array.isArray(data?.links) ? data.links.find((l) => isObj(l) && l.rel === "up") : null;
    const captureId = isObj(up) ? /\/captures\/([A-Za-z0-9_-]{5,64})$/.exec(String(up.href ?? ""))?.[1] ?? null : null;
    return { id, status, amountCents: cents, currency, captureId };
  }

  // ------------------------------------------------------------------ webhook

  async verifyWebhook(input: WebhookVerifyInput): Promise<boolean> {
    const h = input.headers;
    const data = await this.request("verifyWebhook", "POST", "/v1/notifications/verify-webhook-signature", {
      body: {
        auth_algo: h.authAlgo,
        cert_url: h.certUrl,
        transmission_id: h.transmissionId,
        transmission_sig: h.transmissionSig,
        transmission_time: h.transmissionTime,
        webhook_id: input.webhookId,
        webhook_event: input.event,
      },
    });
    return data?.verification_status === "SUCCESS";
  }

  // ------------------------------------------------------------------ suscripciones (Billing v1)

  async createSubscription(input: CreateSubscriptionInput): Promise<{ id: string }> {
    const data = await this.request("createSubscription", "POST", "/v1/billing/subscriptions", {
      headers: { "PayPal-Request-Id": input.requestId.slice(0, 108), Prefer: "return=representation" },
      body: {
        plan_id: input.planId,
        custom_id: input.userId,
        application_context: {
          brand_name: input.brandName.slice(0, 127),
          locale: "es-ES",
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
          payment_method: { payer_selected: "PAYPAL", payee_preferred: "IMMEDIATE_PAYMENT_REQUIRED" },
          ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
          ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
        },
      },
    });
    const id = str(data?.id, 64);
    if (!id || !ID_RE.test(id)) {
      throw new PayPalError("PayPal createSubscription returned an invalid id", 502, "createSubscription");
    }
    return { id };
  }

  async getSubscription(subscriptionId: string): Promise<PayPalSubscription> {
    const data = await this.request(
      "getSubscription",
      "GET",
      `/v1/billing/subscriptions/${pathId(subscriptionId, "subscription")}`,
    );
    const id = str(data?.id, 64);
    const planId = str(data?.plan_id, 64);
    const status = str(data?.status, 40);
    if (!id || !planId || !status) throw new PayPalError("PayPal subscription is invalid", 502, "getSubscription");
    const billing = isObj(data?.billing_info) ? data.billing_info : null;
    const last = isObj(billing?.last_payment) ? billing.last_payment : null;
    return {
      id,
      planId,
      status,
      customId: str(data?.custom_id, 64),
      nextBillingTime: validDate(billing?.next_billing_time),
      lastPaymentTime: validDate(last?.time),
    };
  }

  async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    await this.request(
      "cancelSubscription",
      "POST",
      `/v1/billing/subscriptions/${pathId(subscriptionId, "subscription")}/cancel`,
      {
        body: { reason: reason.slice(0, 128) },
      },
    );
  }
}

// ---------------------------------------------------------------------- normalización

function validDate(v: unknown): string | null {
  const s = str(v, 40);
  return s && Number.isFinite(Date.parse(s)) ? new Date(s).toISOString() : null;
}

function parseShipping(pu: Json): PayPalShipping | null {
  const s = isObj(pu.shipping) ? pu.shipping : null;
  if (!s) return null;
  const a = isObj(s.address) ? s.address : {};
  const name = isObj(s.name) ? str(s.name.full_name, 120) : null;
  return {
    name,
    address_line_1: str(a.address_line_1, 120),
    address_line_2: str(a.address_line_2, 120),
    city: str(a.admin_area_2, 80),
    region: str(a.admin_area_1, 80),
    postal_code: str(a.postal_code, 20),
    country_code: str(a.country_code, 2),
  };
}

function parseCapture(c: unknown, operation: string): PayPalCapture | null {
  if (!isObj(c)) return null;
  const id = str(c.id, 64);
  const status = str(c.status, 40);
  const amount = isObj(c.amount) ? c.amount : null;
  const cents = valueToCents(amount?.value);
  const currency = str(amount?.currency_code, 3);
  if (!id || !status || cents === null || !currency) throw new PayPalError("PayPal capture is invalid", 502, operation);
  return { id, status, amountCents: cents, currency, customId: str(c.custom_id, 64) };
}

export function parseOrder(data: Json | null, operation: string): PayPalOrder {
  const id = str(data?.id, 64);
  const status = str(data?.status, 40);
  if (!data || !id || !status) throw new PayPalError("PayPal order is invalid", 502, operation);
  const pu = Array.isArray(data.purchase_units) && isObj(data.purchase_units[0]) ? data.purchase_units[0] : {};
  const amount = isObj(pu.amount) ? pu.amount : null;
  const payments = isObj(pu.payments) ? pu.payments : null;
  const captures = Array.isArray(payments?.captures) ? payments.captures : [];
  const capture = captures.length > 0 ? parseCapture(captures[captures.length - 1], operation) : null;
  const payer = isObj(data.payer) ? data.payer : null;
  return {
    id,
    status,
    customId: str(pu.custom_id, 64) ?? capture?.customId ?? null,
    payerId: str(payer?.payer_id, 64),
    amountCents: valueToCents(amount?.value),
    currency: str(amount?.currency_code, 3),
    shipping: parseShipping(pu),
    capture,
  };
}
