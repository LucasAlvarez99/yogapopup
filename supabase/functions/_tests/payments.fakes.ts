/**
 * Dobles de prueba de los pagos: PayPal y la base de datos en memoria. FakePaymentsRepo replica las reglas de las
 * funciones SQL de la migración 20261008120000 (que se prueban de verdad contra Postgres en supabase/tests/payments.test.sql);
 * acá sirven para probar las Edge Functions sin red ni base.
 */
import { HttpError } from "../_shared/http.ts";
import { PayPalError } from "../_shared/paypal/paypal.service.ts";
import type {
  CreateOrderInput,
  CreateSubscriptionInput,
  PayPalCapture,
  PayPalOrder,
  PayPalPort,
  PayPalRefund,
  PayPalSubscription,
  WebhookVerifyInput,
} from "../_shared/paypal/paypal.types.ts";
import type {
  CartItemInput,
  EventBegin,
  MarkPaidInput,
  MarkPaidResult,
  OrderItemRow,
  OrderRow,
  PaymentDeps,
  PaymentsConfig,
  PaymentsRepo,
  RefundResult,
  SubscriptionRow,
  SubscriptionStatus,
  SyncSubscriptionInput,
} from "../_shared/payments/ports.ts";
import { FakeAudit, FakeAuth, FakeLimiter, FakeRepo, USER_ID } from "./fakes.ts";

// ------------------------------------------------------------------ PayPal
export class FakePayPal implements PayPalPort {
  orders = new Map<string, { order: PayPalOrder; input: CreateOrderInput }>();
  subs = new Map<string, PayPalSubscription>();
  refunds = new Map<string, PayPalRefund>();
  calls: string[] = [];
  webhookValid = true;
  /** Si se define, la próxima llamada a esa operación falla con ese error. */
  failNext: { op: string; error: PayPalError } | null = null;
  /** Estado con el que se crea la captura al capturar (para simular cobros pendientes o rechazados). */
  captureStatus = "COMPLETED";
  /** Si se define, la captura sale por este monto en vez del total (para simular un cobro distinto). */
  captureAmountCents: number | null = null;
  private seq = 0;

  private maybeFail(op: string): void {
    this.calls.push(op);
    if (this.failNext && this.failNext.op === op) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  createOrder(input: CreateOrderInput): Promise<{ id: string }> {
    this.maybeFail("createOrder");
    const id = `PPORDER${++this.seq}`;
    this.orders.set(id, {
      input,
      order: {
        id,
        status: "CREATED",
        customId: input.orderId,
        payerId: null,
        amountCents: input.totalCents,
        currency: "EUR",
        shipping: null,
        capture: null,
      },
    });
    return Promise.resolve({ id });
  }

  /** Ayuda de test: la persona aprobó la orden en PayPal. */
  approve(id: string, shipping: PayPalOrder["shipping"] = null): void {
    const o = this.orders.get(id)!.order;
    o.status = "APPROVED";
    o.payerId = "PAYER123";
    o.shipping = shipping;
  }

  getOrder(id: string): Promise<PayPalOrder> {
    this.maybeFail("getOrder");
    const o = this.orders.get(id);
    if (!o) return Promise.reject(new PayPalError("not found", 404, "getOrder"));
    return Promise.resolve({ ...o.order });
  }

  captureOrder(id: string, _requestId: string): Promise<PayPalOrder> {
    this.maybeFail("captureOrder");
    const o = this.orders.get(id)?.order;
    if (!o) return Promise.reject(new PayPalError("not found", 404, "captureOrder"));
    if (o.status === "COMPLETED") return Promise.resolve({ ...o }); // ya capturada: se devuelve el estado
    if (o.status !== "APPROVED") {
      return Promise.reject(new PayPalError("not approved", 422, "captureOrder", "ORDER_NOT_APPROVED"));
    }
    const capture: PayPalCapture = {
      id: `CAPTURE${++this.seq}`,
      status: this.captureStatus,
      amountCents: this.captureAmountCents ?? o.amountCents ?? 0,
      currency: "EUR",
      customId: o.customId,
    };
    o.capture = capture;
    o.status = "COMPLETED";
    return Promise.resolve({ ...o });
  }

  getRefund(id: string): Promise<PayPalRefund> {
    this.maybeFail("getRefund");
    const r = this.refunds.get(id);
    return r ? Promise.resolve({ ...r }) : Promise.reject(new PayPalError("not found", 404, "getRefund"));
  }

  verifyWebhook(_input: WebhookVerifyInput): Promise<boolean> {
    this.maybeFail("verifyWebhook");
    return Promise.resolve(this.webhookValid);
  }

  createSubscription(input: CreateSubscriptionInput): Promise<{ id: string }> {
    this.maybeFail("createSubscription");
    const id = `I-FAKESUB${++this.seq}`;
    this.subs.set(id, {
      id,
      planId: input.planId,
      status: "APPROVAL_PENDING",
      customId: input.userId,
      nextBillingTime: null,
      lastPaymentTime: null,
    });
    return Promise.resolve({ id });
  }

  /** Ayuda de test: PayPal pasa la suscripción a ACTIVE con su próxima fecha de cobro. */
  activateSub(id: string, nextBillingTime: string, lastPaymentTime = new Date().toISOString()): void {
    Object.assign(this.subs.get(id)!, { status: "ACTIVE", nextBillingTime, lastPaymentTime });
  }

  getSubscription(id: string): Promise<PayPalSubscription> {
    this.maybeFail("getSubscription");
    const s = this.subs.get(id);
    return s ? Promise.resolve({ ...s }) : Promise.reject(new PayPalError("not found", 404, "getSubscription"));
  }

  cancelSubscription(id: string, _reason: string): Promise<void> {
    this.maybeFail("cancelSubscription");
    const s = this.subs.get(id);
    if (!s) return Promise.reject(new PayPalError("not found", 404, "cancelSubscription"));
    if (s.status === "CANCELLED") {
      return Promise.reject(
        new PayPalError("invalid status", 422, "cancelSubscription", "SUBSCRIPTION_STATUS_INVALID"),
      );
    }
    s.status = "CANCELLED";
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------ Base de datos
interface FakeProduct {
  id: string;
  title: string;
  price_cents: number;
  stock: number | null;
  is_active: boolean;
  tax_rate_bps: number;
  variants: Map<string, { id: string; size: string; stock: number | null }>;
}
interface FakeClass {
  id: string;
  title: string;
  price_cents: number | null;
  tax_rate_bps: number;
  access_level: "free" | "restricted";
  is_published: boolean;
}
export interface FakeEntitlement {
  user_id: string;
  scope: "all" | "class";
  class_id: string | null;
  source: string;
  external_ref: string;
  expires_at: string | null;
}

const err = (status: number, code: string) => new HttpError(status, code, code);

export class FakePaymentsRepo implements PaymentsRepo {
  products = new Map<string, FakeProduct>();
  classes = new Map<string, FakeClass>();
  orders = new Map<string, OrderRow & { stock_reserved: boolean; refund_ids: string[] }>();
  items = new Map<
    string,
    (OrderItemRow & { product_id: string | null; variant_id: string | null; class_id: string | null })[]
  >();
  entitlements: FakeEntitlement[] = [];
  subs = new Map<string, SubscriptionRow>();
  events = new Map<string, { status: string; attempts: number; error: string | null }>();
  markPaidCalls = 0;
  /** Si es true, la próxima vez que se aplique un pago o reembolso falla (para probar los reintentos del webhook). */
  failNextWrite = false;

  addProduct(p: Partial<FakeProduct> & { title: string; price_cents: number }): FakeProduct {
    const row: FakeProduct = {
      id: crypto.randomUUID(),
      stock: 10,
      is_active: true,
      tax_rate_bps: 2100,
      variants: new Map(),
      ...p,
    };
    this.products.set(row.id, row);
    return row;
  }
  addVariant(product: FakeProduct, size: string, stock: number | null) {
    const v = { id: crypto.randomUUID(), size, stock };
    product.variants.set(v.id, v);
    return v;
  }
  addClass(p: Partial<FakeClass> = {}): FakeClass {
    const row: FakeClass = {
      id: crypto.randomUUID(),
      title: "Curso pago",
      price_cents: 1210,
      tax_rate_bps: 2100,
      access_level: "restricted",
      is_published: true,
      ...p,
    };
    this.classes.set(row.id, row);
    return row;
  }
  hasClassAccess(userId: string, classId: string, now = Date.now()): boolean {
    return this.entitlements.some((e) =>
      e.user_id === userId && (e.expires_at === null || Date.parse(e.expires_at) > now) &&
      (e.scope === "all" || e.class_id === classId)
    );
  }

  async createOrder(userId: string, input: CartItemInput[]): Promise<string> {
    const classes = input.filter((i) => i.type === "class").length;
    if ((classes > 0 && classes !== input.length) || classes > 1) throw err(400, "invalid_cart");
    // Un intento nuevo reemplaza a los anteriores sin pagar.
    for (const o of this.orders.values()) {
      if (o.user_id === userId && o.status === "created") await this.releaseOrder(o.id, "cancelled", "superseded");
    }
    const id = crypto.randomUUID();
    const lines: (OrderItemRow & { product_id: string | null; variant_id: string | null; class_id: string | null })[] =
      [];
    let total = 0;
    let tax = 0;
    const take: (() => void)[] = [];
    if (classes === 1) {
      const c = this.classes.get(input[0].id);
      if (!c || !c.is_published || c.access_level !== "restricted" || c.price_cents === null) {
        throw err(409, "class_unavailable");
      }
      if (this.hasClassAccess(userId, c.id)) throw err(409, "already_owned");
      lines.push({
        item_type: "class",
        title: c.title,
        size: null,
        unit_cents: c.price_cents,
        qty: 1,
        product_id: null,
        variant_id: null,
        class_id: c.id,
      });
      total = c.price_cents;
      tax = Math.round(total * c.tax_rate_bps / (10000 + c.tax_rate_bps));
    } else {
      const merged = new Map<string, { id: string; variant: string | null; qty: number }>();
      for (const i of input) {
        if (i.type !== "product") continue;
        const key = `${i.id}|${i.variant_id ?? ""}`;
        const prev = merged.get(key);
        merged.set(key, { id: i.id, variant: i.variant_id, qty: (prev?.qty ?? 0) + i.qty });
      }
      for (const m of merged.values()) {
        if (m.qty > 10) throw err(400, "invalid_cart");
        const p = this.products.get(m.id);
        if (!p || !p.is_active || p.price_cents <= 0) throw err(409, "product_unavailable");
        let size: string | null = null;
        if (p.variants.size > 0) {
          if (!m.variant) throw err(400, "size_required");
          const v = p.variants.get(m.variant);
          if (!v) throw err(409, "product_unavailable");
          if (v.stock !== null && v.stock < m.qty) throw err(409, "insufficient_stock");
          size = v.size;
          if (v.stock !== null) take.push(() => (v.stock = v.stock! - m.qty));
        } else {
          if (m.variant) throw err(409, "product_unavailable");
          if (p.stock !== null && p.stock < m.qty) throw err(409, "insufficient_stock");
          if (p.stock !== null) take.push(() => (p.stock = p.stock! - m.qty));
        }
        lines.push({
          item_type: "product",
          title: p.title,
          size,
          unit_cents: p.price_cents,
          qty: m.qty,
          product_id: p.id,
          variant_id: m.variant,
          class_id: null,
        });
        total += p.price_cents * m.qty;
        tax += Math.round(p.price_cents * m.qty * p.tax_rate_bps / (10000 + p.tax_rate_bps));
      }
    }
    take.forEach((f) => f());
    this.orders.set(id, {
      id,
      user_id: userId,
      kind: classes === 1 ? "class" : "shop",
      status: "created",
      currency: "EUR",
      total_cents: total,
      tax_cents: tax,
      refunded_cents: 0,
      needs_review: false,
      review_note: null,
      failure_reason: null,
      paypal_order_id: null,
      paypal_capture_id: null,
      created_at: new Date().toISOString(),
      paid_at: null,
      stock_reserved: classes === 0,
      refund_ids: [],
    });
    this.items.set(id, lines);
    return id;
  }

  getOrder(id: string) {
    const o = this.orders.get(id);
    return Promise.resolve(o ? { ...o } : null);
  }
  getOrderByPayPalId(id: string) {
    const o = [...this.orders.values()].find((o) => o.paypal_order_id === id);
    return Promise.resolve(o ? { ...o } : null);
  }
  getOrderByCaptureId(id: string) {
    const o = [...this.orders.values()].find((o) => o.paypal_capture_id === id);
    return Promise.resolve(o ? { ...o } : null);
  }
  listOrderItems(orderId: string) {
    return Promise.resolve((this.items.get(orderId) ?? []).map((l) => ({ ...l })));
  }
  setPayPalOrderId(orderId: string, paypalOrderId: string) {
    this.orders.get(orderId)!.paypal_order_id = paypalOrderId;
    return Promise.resolve();
  }

  releaseOrder(orderId: string, status: "failed" | "cancelled", reason: string) {
    const o = this.orders.get(orderId);
    if (!o || (o.status !== "created" && o.status !== "pending")) return Promise.resolve(false);
    if (o.stock_reserved) {
      for (const l of this.items.get(orderId) ?? []) {
        if (l.item_type !== "product" || !l.product_id) continue;
        const p = this.products.get(l.product_id);
        if (!p) continue;
        const v = l.variant_id ? p.variants.get(l.variant_id) : null;
        if (v) {
          if (v.stock !== null) v.stock += l.qty;
        } else if (p.stock !== null) p.stock += l.qty;
      }
    }
    Object.assign(o, { status, stock_reserved: false, failure_reason: reason });
    return Promise.resolve(true);
  }

  markPaid(i: MarkPaidInput): Promise<MarkPaidResult> {
    this.markPaidCalls++;
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error("db down"));
    }
    const o = this.orders.get(i.orderId);
    if (!o) return Promise.resolve("not_found");
    if (o.status === "paid" || o.status === "refunded") return Promise.resolve("already_paid");
    if (i.currency !== o.currency || i.amountCents !== o.total_cents) {
      Object.assign(o, { needs_review: true, review_note: "amount_mismatch" });
      return Promise.resolve("mismatch");
    }
    if (i.captureStatus !== "COMPLETED") {
      Object.assign(o, { status: "pending", paypal_capture_id: i.captureId ?? o.paypal_capture_id });
      return Promise.resolve("pending");
    }
    Object.assign(o, {
      status: "paid",
      paid_at: new Date().toISOString(),
      paypal_capture_id: i.captureId ?? o.paypal_capture_id,
    });
    if (o.kind === "class" && o.user_id) {
      for (const l of this.items.get(o.id) ?? []) {
        if (l.class_id && !this.entitlements.some((e) => e.source === "paypal" && e.external_ref === o.id)) {
          this.entitlements.push({
            user_id: o.user_id,
            scope: "class",
            class_id: l.class_id,
            source: "paypal",
            external_ref: o.id,
            expires_at: null,
          });
        }
      }
    }
    return Promise.resolve("paid");
  }

  applyRefund(orderId: string, refundId: string, amountCents: number): Promise<RefundResult> {
    const o = this.orders.get(orderId);
    if (!o) return Promise.resolve("not_found");
    if (o.status !== "paid" && o.status !== "refunded") return Promise.resolve("not_paid");
    if (o.refund_ids.includes(refundId)) return Promise.resolve("duplicate");
    o.refund_ids.push(refundId);
    o.refunded_cents = Math.min(o.total_cents, o.refunded_cents + amountCents);
    if (o.refunded_cents >= o.total_cents) {
      o.status = "refunded";
      if (o.kind === "class") {
        this.entitlements = this.entitlements.filter((e) => !(e.source === "paypal" && e.external_ref === o.id));
      }
    }
    return Promise.resolve("applied");
  }

  listStaleOrders(olderThanMinutes: number, limit: number) {
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    return Promise.resolve(
      [...this.orders.values()].filter((o) =>
        (o.status === "created" || o.status === "pending") && Date.parse(o.created_at) < cutoff
      )
        .slice(0, limit).map((o) => ({ ...o })),
    );
  }

  startSubscription(userId: string, paypalSubscriptionId: string, planId: string) {
    if (
      [...this.subs.values()].some((s) => s.user_id === userId && (s.status === "active" || s.status === "suspended"))
    ) {
      return Promise.reject(err(409, "already_subscribed"));
    }
    for (const s of this.subs.values()) {
      if (s.user_id === userId && s.status === "approval_pending") s.status = "cancelled";
    }
    this.subs.set(paypalSubscriptionId, {
      id: crypto.randomUUID(),
      user_id: userId,
      paypal_subscription_id: paypalSubscriptionId,
      plan_id: planId,
      status: "approval_pending",
      current_period_end: null,
      last_payment_at: null,
      cancelled_at: null,
      created_at: new Date().toISOString(),
    });
    return Promise.resolve();
  }
  getSubscriptionByPayPalId(id: string) {
    const s = this.subs.get(id);
    return Promise.resolve(s ? { ...s } : null);
  }
  getLiveSubscription(userId: string) {
    const s = [...this.subs.values()].find((s) =>
      s.user_id === userId && (s.status === "active" || s.status === "suspended")
    );
    return Promise.resolve(s ? { ...s } : null);
  }
  syncSubscription(i: SyncSubscriptionInput): Promise<"ok" | "unknown_subscription"> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error("db down"));
    }
    let s = this.subs.get(i.paypalSubscriptionId);
    if (!s) {
      if (!i.userId) return Promise.resolve("unknown_subscription");
      s = {
        id: crypto.randomUUID(),
        user_id: i.userId,
        paypal_subscription_id: i.paypalSubscriptionId,
        plan_id: i.planId,
        status: "approval_pending",
        current_period_end: null,
        last_payment_at: null,
        cancelled_at: null,
        created_at: new Date().toISOString(),
      };
      this.subs.set(i.paypalSubscriptionId, s);
    }
    s.plan_id = i.planId;
    s.status = i.status as SubscriptionStatus;
    if (i.status === "active" && i.nextBilling) s.current_period_end = i.nextBilling;
    if (i.lastPayment) s.last_payment_at = i.lastPayment;
    if ((i.status === "cancelled" || i.status === "expired") && !s.cancelled_at) {
      s.cancelled_at = new Date().toISOString();
    }
    const ref = i.paypalSubscriptionId;
    if (s.user_id && i.status === "active") {
      const until = new Date(
        Date.parse(i.nextBilling ?? s.current_period_end ?? new Date().toISOString()) + 2 * 86_400_000,
      ).toISOString();
      const e = this.entitlements.find((e) => e.source === "paypal" && e.external_ref === ref);
      if (e) e.expires_at = until;
      else {this.entitlements.push({
          user_id: s.user_id,
          scope: "all",
          class_id: null,
          source: "paypal",
          external_ref: ref,
          expires_at: until,
        });}
    } else if (s.user_id && (i.status === "cancelled" || i.status === "expired")) {
      const e = this.entitlements.find((e) => e.source === "paypal" && e.external_ref === ref);
      if (e) e.expires_at = s.current_period_end ?? new Date().toISOString();
    }
    return Promise.resolve("ok");
  }
  listPendingSubscriptions(olderThanMinutes: number, limit: number) {
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    return Promise.resolve(
      [...this.subs.values()].filter((s) => s.status === "approval_pending" && Date.parse(s.created_at) < cutoff).slice(
        0,
        limit,
      ).map((s) => ({ ...s })),
    );
  }

  beginEvent(
    eventId: string,
    _t: string,
    _rt: string | null,
    _ri: string | null,
    _s: Record<string, unknown>,
  ): Promise<EventBegin> {
    const e = this.events.get(eventId);
    if (!e) {
      this.events.set(eventId, { status: "received", attempts: 1, error: null });
      return Promise.resolve("new");
    }
    if (e.status === "processed" || e.status === "ignored") return Promise.resolve("duplicate");
    e.attempts++;
    e.status = "received";
    return Promise.resolve("retry");
  }
  finishEvent(eventId: string, status: "processed" | "ignored" | "failed", error: string | null) {
    const e = this.events.get(eventId);
    if (e) Object.assign(e, { status, error });
    return Promise.resolve();
  }
}

// ------------------------------------------------------------------ Armado
export const PLAN_ID = "P-TESTPLAN123";
export const WEBHOOK_ID = "WH-TEST-WEBHOOK";
export const CRON_SECRET = "cron-secret-de-prueba";

export function makePaymentDeps(over: Partial<PaymentsConfig> = {}, opts: { paypal?: boolean } = {}) {
  const paypal = new FakePayPal();
  const repo = new FakePaymentsRepo();
  const auth = new FakeAuth(new FakeRepo());
  const audit = new FakeAudit();
  const limiter = new FakeLimiter();
  const config: PaymentsConfig = {
    allowedOrigins: ["https://yogapopup.test"],
    planId: PLAN_ID,
    webhookId: WEBHOOK_ID,
    cronSecret: CRON_SECRET,
    brandName: "Yoga Pop Up",
    ...over,
  };
  const deps: PaymentDeps = { paypal: opts.paypal === false ? null : paypal, repo, auth, audit, limiter, config };
  return { paypal, repo, auth, audit, limiter, config, deps, USER_ID };
}
