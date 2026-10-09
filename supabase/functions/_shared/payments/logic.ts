/**
 * Reglas de negocio de los pagos, sin HTTP ni Supabase: reciben puertos (repositorio, PayPal, auditoría) y se prueban
 * con dobles en memoria. Hay tres reglas que no se negocian:
 *   1. PayPal es la fuente de la verdad: lo que dice el navegador (o el cuerpo del webhook) nunca decide un cobro;
 *      siempre se vuelve a consultar la API de PayPal y se compara contra lo que hay en la base.
 *   2. Todo es idempotente: el navegador, el webhook y la conciliación pueden llegar en cualquier orden y repetirse.
 *   3. El monto cobrado tiene que ser EXACTAMENTE el del pedido; si no, no se da nada por pagado y se pide revisión.
 */
import type { AuditPort } from "../ports.ts";
import type { PayPalPort } from "../paypal/paypal.types.ts";
import type { OrderRow, PaymentsRepo, SubscriptionRow, SubscriptionStatus } from "./ports.ts";

export interface PaymentsCtx {
  repo: PaymentsRepo;
  paypal: PayPalPort;
  audit: AuditPort;
}

/** Un pedido sin pagar retiene el stock este tiempo; pasado ese plazo la conciliación lo libera. */
export const ORDER_HOLD_MINUTES = 60;
/** Una orden aprobada pero nunca capturada se captura sola (la persona sí la aprobó) hasta este plazo; después se cancela. */
export const CAPTURE_MAX_AGE_HOURS = 24;
/** Una suscripción que nunca se aprobó se descarta pasado este plazo. */
export const SUBSCRIPTION_APPROVAL_HOURS = 24;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** La auditoría de pagos NO puede tumbar un cobro ya registrado: si falla, se deja constancia en el log. */
async function safeAudit(audit: AuditPort, entry: Parameters<AuditPort["record"]>[0]): Promise<void> {
  try {
    await audit.record(entry);
  } catch (e) {
    console.error("[payments] audit failed:", entry.action, e instanceof Error ? e.message : e);
  }
}

// ======================================================================= pedidos

export type SettleOutcome = "paid" | "already_paid" | "pending" | "failed" | "cancelled" | "open" | "mismatch";

export interface SettleResult {
  outcome: SettleOutcome;
  order: OrderRow;
}

/**
 * Lleva un pedido al estado que PayPal dice que tiene. Es la ÚNICA ruta que registra un cobro: la usan el navegador
 * (captura al aprobar), el webhook y la conciliación.
 *   capture = true  -> si PayPal tiene la orden APROBADA pero sin capturar, se captura ahora.
 */
export async function settleOrder(
  ctx: PaymentsCtx,
  order: OrderRow,
  opts: { capture: boolean },
): Promise<SettleResult> {
  const refetch = async (): Promise<OrderRow> => (await ctx.repo.getOrder(order.id)) ?? order;
  if (order.status === "paid" || order.status === "refunded") return { outcome: "already_paid", order };
  if (!order.paypal_order_id) return { outcome: "open", order };

  let pp = await ctx.paypal.getOrder(order.paypal_order_id);
  if (pp.customId !== order.id) {
    await safeAudit(ctx.audit, {
      actorId: null,
      action: "payment.mismatch",
      entityType: "order",
      entityId: order.id,
      details: { reason: "custom_id", paypal_order_id: pp.id },
    });
    return { outcome: "mismatch", order };
  }

  if (opts.capture && pp.status === "APPROVED") {
    pp = await ctx.paypal.captureOrder(pp.id, `yp-capture-${order.id}`);
  }

  const cap = pp.capture;
  if (cap) {
    if (cap.customId && cap.customId !== order.id) {
      await safeAudit(ctx.audit, {
        actorId: null,
        action: "payment.mismatch",
        entityType: "order",
        entityId: order.id,
        details: { reason: "capture_custom_id", capture_id: cap.id },
      });
      return { outcome: "mismatch", order };
    }
    if (cap.status === "DECLINED" || cap.status === "FAILED") {
      await ctx.repo.releaseOrder(order.id, "failed", `capture_${cap.status.toLowerCase()}`);
      return { outcome: "failed", order: await refetch() };
    }
    const completed = cap.status === "COMPLETED" || cap.status === "REFUNDED" || cap.status === "PARTIALLY_REFUNDED";
    if (completed || cap.status === "PENDING") {
      const result = await ctx.repo.markPaid({
        orderId: order.id,
        captureId: cap.id,
        amountCents: cap.amountCents,
        currency: cap.currency,
        payerId: pp.payerId,
        shipping: pp.shipping,
        paypalStatus: pp.status,
        captureStatus: completed ? "COMPLETED" : "PENDING",
      });
      if (result === "paid") {
        await safeAudit(ctx.audit, {
          actorId: null,
          action: "payment.paid",
          entityType: "order",
          entityId: order.id,
          details: { kind: order.kind, total_cents: order.total_cents, capture_id: cap.id },
        });
      } else if (result === "mismatch") {
        await safeAudit(ctx.audit, {
          actorId: null,
          action: "payment.mismatch",
          entityType: "order",
          entityId: order.id,
          details: {
            reason: "amount",
            expected_cents: order.total_cents,
            got_cents: cap.amountCents,
            got_currency: cap.currency,
          },
        });
        return { outcome: "mismatch", order: await refetch() };
      } else if (result === "not_found") {
        return { outcome: "open", order };
      }
      return {
        outcome: result === "already_paid" ? "already_paid" : result === "pending" ? "pending" : "paid",
        order: await refetch(),
      };
    }
    return { outcome: "open", order: await refetch() }; // estado de captura desconocido: se deja como está
  }

  if (pp.status === "VOIDED") {
    await ctx.repo.releaseOrder(order.id, "cancelled", "voided_by_paypal");
    return { outcome: "cancelled", order: await refetch() };
  }
  return { outcome: "open", order };
}

/** ¿Pasó más tiempo que `hours` desde `iso`? */
const olderThanHours = (iso: string, hours: number): boolean => Date.now() - Date.parse(iso) > hours * 3_600_000;

/**
 * Conciliación de UN pedido (botón "verificar de nuevo" y barrido). Igual que `settleOrder`, pero además decide
 * qué hacer con lo que PayPal nunca llegó a cobrar: capturar si se aprobó hace poco, o liberar el stock si venció.
 */
export async function reconcileOrder(ctx: PaymentsCtx, order: OrderRow): Promise<SettleResult> {
  const canCapture = !olderThanHours(order.created_at, CAPTURE_MAX_AGE_HOURS);
  const result = await settleOrder(ctx, order, { capture: canCapture });
  if (result.outcome === "open" && (order.status === "created" || order.status === "pending")) {
    const expired = olderThanHours(order.created_at, ORDER_HOLD_MINUTES / 60);
    if (expired) {
      const released = await ctx.repo.releaseOrder(order.id, "cancelled", "expired");
      if (released) return { outcome: "cancelled", order: (await ctx.repo.getOrder(order.id)) ?? order };
    }
  }
  return result;
}

// ======================================================================= suscripciones

export function mapSubscriptionStatus(paypalStatus: string): SubscriptionStatus {
  switch (paypalStatus) {
    case "APPROVAL_PENDING":
    case "APPROVED":
      return "approval_pending";
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "suspended";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    default:
      throw new Error(`Unknown PayPal subscription status: ${paypalStatus.slice(0, 40)}`);
  }
}

export type SubscriptionSyncOutcome = "ok" | "wrong_plan" | "wrong_user" | "unknown";

export interface SubscriptionSyncResult {
  outcome: SubscriptionSyncOutcome;
  status: SubscriptionStatus | null;
  subscription: SubscriptionRow | null;
}

/**
 * Trae la suscripción de la API de PayPal y la refleja en la base (estado + acceso). `planId` es el plan que el
 * negocio vende: una suscripción a OTRO plan (más barato, de otro producto de la misma cuenta) no concede acceso.
 */
export async function syncSubscription(
  ctx: PaymentsCtx,
  paypalSubscriptionId: string,
  planId: string | null,
): Promise<SubscriptionSyncResult> {
  const sub = await ctx.paypal.getSubscription(paypalSubscriptionId);
  const existing = await ctx.repo.getSubscriptionByPayPalId(sub.id);

  if (planId && sub.planId !== planId) {
    await safeAudit(ctx.audit, {
      actorId: null,
      action: "payment.mismatch",
      entityType: "subscription",
      entityId: sub.id,
      details: { reason: "plan", plan_id: sub.planId },
    });
    return { outcome: "wrong_plan", status: null, subscription: existing };
  }
  const hint = isUuid(sub.customId) ? sub.customId : null;
  if (existing?.user_id && hint && existing.user_id !== hint) {
    await safeAudit(ctx.audit, {
      actorId: null,
      action: "payment.mismatch",
      entityType: "subscription",
      entityId: sub.id,
      details: { reason: "user" },
    });
    return { outcome: "wrong_user", status: null, subscription: existing };
  }

  const status = mapSubscriptionStatus(sub.status);
  const result = await ctx.repo.syncSubscription({
    paypalSubscriptionId: sub.id,
    userId: hint,
    planId: sub.planId,
    status,
    nextBilling: sub.nextBillingTime,
    lastPayment: sub.lastPaymentTime,
  });
  if (result === "unknown_subscription") return { outcome: "unknown", status, subscription: null };

  const after = await ctx.repo.getSubscriptionByPayPalId(sub.id);
  if (existing?.status !== status) {
    await safeAudit(ctx.audit, {
      actorId: after?.user_id ?? null,
      action: `subscription.${status}`,
      entityType: "subscription",
      entityId: sub.id,
      details: { from: existing?.status ?? null, to: status },
    });
  }
  return { outcome: "ok", status, subscription: after };
}

// ======================================================================= webhook

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: Record<string, unknown>;
}

export interface EventResult {
  status: "processed" | "ignored";
  detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 100): string | null => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/** Resumen SIN datos personales que se guarda de cada evento (el cuerpo de PayPal trae correo y dirección). */
export function summarizeEvent(ev: WebhookEvent): Record<string, unknown> {
  const r = ev.resource;
  const amount = isObj(r.amount) ? r.amount : null;
  return {
    event_type: ev.event_type,
    resource_id: text(r.id),
    custom_id: text(r.custom_id, 64),
    status: text(r.status, 40),
    amount: text(amount?.total ?? amount?.value, 20),
    currency: text(amount?.currency_code ?? amount?.currency, 3),
  };
}

const ORDER_EVENTS = new Set([
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.DECLINED",
]);
const REFUND_EVENTS = new Set(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);
const SUBSCRIPTION_EVENTS = new Set([
  "BILLING.SUBSCRIPTION.CREATED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
]);

/** Ubica el pedido de un evento de captura/reembolso: por custom_id, por la orden de PayPal o por la captura. */
async function findOrderForEvent(
  repo: PaymentsRepo,
  r: Record<string, unknown>,
  captureId: string | null,
): Promise<OrderRow | null> {
  const customId = text(r.custom_id, 64);
  if (isUuid(customId)) {
    const byId = await repo.getOrder(customId);
    if (byId) return byId;
  }
  const related = isObj(r.supplementary_data) && isObj(r.supplementary_data.related_ids)
    ? r.supplementary_data.related_ids
    : null;
  const ppOrder = text(related?.order_id, 64);
  if (ppOrder) {
    const byPayPal = await repo.getOrderByPayPalId(ppOrder);
    if (byPayPal) return byPayPal;
  }
  return captureId ? await repo.getOrderByCaptureId(captureId) : null;
}

/** Id de la captura de un evento de reembolso: del enlace "up" o de los ids relacionados. */
function captureIdOfRefund(r: Record<string, unknown>): string | null {
  const up = Array.isArray(r.links) ? r.links.find((l) => isObj(l) && l.rel === "up") : null;
  const fromLink = isObj(up) ? /\/captures\/([A-Za-z0-9_-]{5,64})$/.exec(String(up.href ?? ""))?.[1] ?? null : null;
  if (fromLink) return fromLink;
  const related = isObj(r.supplementary_data) && isObj(r.supplementary_data.related_ids)
    ? r.supplementary_data.related_ids
    : null;
  return text(related?.capture_id, 64);
}

/**
 * Procesa un evento YA verificado (firma comprobada con la API de PayPal). El cuerpo del evento solo se usa para saber
 * QUÉ revisar; los montos, estados y fechas se vuelven a pedir a la API.
 */
export async function processWebhookEvent(
  ctx: PaymentsCtx,
  ev: WebhookEvent,
  planId: string | null,
): Promise<EventResult> {
  const type = ev.event_type;
  const r = ev.resource;

  if (ORDER_EVENTS.has(type)) {
    const order = await findOrderForEvent(ctx.repo, r, text(r.id, 64));
    if (!order) return { status: "ignored", detail: "order_not_found" };
    const res = await settleOrder(ctx, order, { capture: false });
    return { status: "processed", detail: `order_${res.outcome}` };
  }

  if (REFUND_EVENTS.has(type)) {
    const captureId = captureIdOfRefund(r);
    const order = await findOrderForEvent(ctx.repo, r, captureId ?? text(r.id, 64));
    if (!order) return { status: "ignored", detail: "order_not_found" };
    if (type === "PAYMENT.CAPTURE.REVERSED") {
      // Contracargo: se trata como un reembolso total (el id propio evita aplicarlo dos veces).
      const applied = await ctx.repo.applyRefund(order.id, `reversal:${text(r.id, 80) ?? ev.id}`, order.total_cents);
      await safeAudit(ctx.audit, {
        actorId: null,
        action: "payment.reversed",
        entityType: "order",
        entityId: order.id,
        details: { result: applied },
      });
      return { status: "processed", detail: `reversal_${applied}` };
    }
    const refundId = text(r.id, 64);
    if (!refundId) return { status: "ignored", detail: "refund_without_id" };
    const refund = await ctx.paypal.getRefund(refundId);
    if (refund.status !== "COMPLETED") return { status: "ignored", detail: "refund_not_completed" };
    if (refund.currency !== order.currency) return { status: "ignored", detail: "refund_currency_mismatch" };
    const applied = await ctx.repo.applyRefund(order.id, refund.id, refund.amountCents);
    await safeAudit(ctx.audit, {
      actorId: null,
      action: "payment.refunded",
      entityType: "order",
      entityId: order.id,
      details: { result: applied, refund_id: refund.id, amount_cents: refund.amountCents },
    });
    return { status: "processed", detail: `refund_${applied}` };
  }

  if (SUBSCRIPTION_EVENTS.has(type) || type === "PAYMENT.SALE.COMPLETED") {
    // En un cobro de suscripción el id de la suscripción viene como billing_agreement_id; una venta común no lo trae.
    const subId = type === "PAYMENT.SALE.COMPLETED" ? text(r.billing_agreement_id, 64) : text(r.id, 64);
    if (!subId) return { status: "ignored", detail: "not_a_subscription" };
    const res = await syncSubscription(ctx, subId, planId);
    return { status: res.outcome === "ok" ? "processed" : "ignored", detail: `subscription_${res.outcome}` };
  }

  return { status: "ignored", detail: "event_type_not_handled" };
}
