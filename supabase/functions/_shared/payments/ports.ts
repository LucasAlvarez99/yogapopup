/**
 * Puertos del módulo de pagos. En producción los implementan repo.supabase.ts (funciones SQL atómicas de la migración
 * 20261008120000) y PayPalService; en los tests, dobles en memoria.
 */
import type { AuditPort, AuthPort, RateLimiterPort } from "../ports.ts";
import type { PayPalPort, PayPalShipping } from "../paypal/paypal.types.ts";

export type OrderKind = "shop" | "class";
export type OrderStatus = "created" | "pending" | "paid" | "failed" | "cancelled" | "refunded";
export type SubscriptionStatus = "approval_pending" | "active" | "suspended" | "cancelled" | "expired";

export interface OrderRow {
  id: string;
  user_id: string | null;
  kind: OrderKind;
  status: OrderStatus;
  currency: string;
  total_cents: number;
  tax_cents: number;
  refunded_cents: number;
  needs_review: boolean;
  review_note: string | null;
  failure_reason: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  created_at: string;
  paid_at: string | null;
}

export interface OrderItemRow {
  item_type: "product" | "class";
  title: string;
  size: string | null;
  unit_cents: number;
  qty: number;
}

export interface SubscriptionRow {
  id: string;
  user_id: string | null;
  paypal_subscription_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_end: string | null;
  last_payment_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

/** Línea del carrito que manda el navegador. Solo ids y cantidad: el precio y el stock salen SIEMPRE de la base. */
export type CartItemInput =
  | { type: "product"; id: string; variant_id: string | null; qty: number }
  | { type: "class"; id: string };

export type MarkPaidResult = "paid" | "already_paid" | "pending" | "mismatch" | "not_found";
export type RefundResult = "applied" | "duplicate" | "not_found" | "not_paid";
export type EventBegin = "new" | "duplicate" | "retry";

export interface MarkPaidInput {
  orderId: string;
  captureId: string | null;
  amountCents: number;
  currency: string;
  payerId: string | null;
  shipping: PayPalShipping | null;
  paypalStatus: string;
  captureStatus: "COMPLETED" | "PENDING";
}

export interface SyncSubscriptionInput {
  paypalSubscriptionId: string;
  userId: string | null;
  planId: string;
  status: SubscriptionStatus;
  nextBilling: string | null;
  lastPayment: string | null;
}

export interface PaymentsRepo {
  /** Crea el pedido con precios y stock de la base (reserva el stock). Lanza HttpError con el motivo si no se puede. */
  createOrder(userId: string, items: CartItemInput[]): Promise<string>;
  getOrder(id: string): Promise<OrderRow | null>;
  getOrderByPayPalId(paypalOrderId: string): Promise<OrderRow | null>;
  getOrderByCaptureId(captureId: string): Promise<OrderRow | null>;
  listOrderItems(orderId: string): Promise<OrderItemRow[]>;
  setPayPalOrderId(orderId: string, paypalOrderId: string): Promise<void>;
  releaseOrder(orderId: string, status: "failed" | "cancelled", reason: string): Promise<boolean>;
  markPaid(input: MarkPaidInput): Promise<MarkPaidResult>;
  applyRefund(orderId: string, refundId: string, amountCents: number): Promise<RefundResult>;
  /** Pedidos sin pagar (created/pending) más viejos que `olderThanMinutes`. */
  listStaleOrders(olderThanMinutes: number, limit: number): Promise<OrderRow[]>;

  startSubscription(userId: string, paypalSubscriptionId: string, planId: string): Promise<void>;
  getSubscriptionByPayPalId(paypalSubscriptionId: string): Promise<SubscriptionRow | null>;
  /** Suscripción activa o suspendida de la persona (la que se puede cancelar), si tiene. */
  getLiveSubscription(userId: string): Promise<SubscriptionRow | null>;
  syncSubscription(input: SyncSubscriptionInput): Promise<"ok" | "unknown_subscription">;
  listPendingSubscriptions(olderThanMinutes: number, limit: number): Promise<SubscriptionRow[]>;

  beginEvent(
    eventId: string,
    eventType: string,
    resourceType: string | null,
    resourceId: string | null,
    summary: Record<string, unknown>,
  ): Promise<EventBegin>;
  finishEvent(eventId: string, status: "processed" | "ignored" | "failed", error: string | null): Promise<void>;
}

export interface PaymentsConfig {
  allowedOrigins: string[];
  /** Plan de suscripción de PayPal (P-...). null = las suscripciones no están configuradas. */
  planId: string | null;
  /** Id del webhook registrado en PayPal. null = el webhook no puede verificar firmas. */
  webhookId: string | null;
  /** Secreto opcional para que un cron externo dispare la conciliación (solo el barrido). */
  cronSecret: string | null;
  brandName: string;
}

export interface PaymentDeps {
  /** null cuando faltan las credenciales de PayPal: las funciones responden 503 `payments_not_configured`. */
  paypal: PayPalPort | null;
  repo: PaymentsRepo;
  auth: AuthPort;
  audit: AuditPort;
  limiter: RateLimiterPort;
  config: PaymentsConfig;
}
