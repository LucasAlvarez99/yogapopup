// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { HttpError } from "../http.ts";
import type { OrderItemRow, OrderRow, PaymentsRepo, SubscriptionRow } from "./ports.ts";

const ORDER_COLUMNS = "id,user_id,kind,status,currency,total_cents,tax_cents,refunded_cents,needs_review,review_note,\
failure_reason,paypal_order_id,paypal_capture_id,created_at,paid_at";
const SUB_COLUMNS =
  "id,user_id,paypal_subscription_id,plan_id,status,current_period_end,last_payment_at,cancelled_at,created_at";

/** Motivos de rechazo de payments_create_order (el mensaje de la excepción SQL es el código estable). */
const CREATE_ORDER_ERRORS: Record<string, [number, string]> = {
  user_not_found: [404, "user_not_found"],
  invalid_cart: [400, "invalid_cart"],
  size_required: [400, "size_required"],
  product_unavailable: [409, "product_unavailable"],
  class_unavailable: [409, "class_unavailable"],
  insufficient_stock: [409, "insufficient_stock"],
  already_owned: [409, "already_owned"],
  too_many_orders: [429, "too_many_orders"],
};

/**
 * Repositorio de pagos sobre Supabase con la SERVICE ROLE. Todo lo que mueve dinero, stock o accesos pasa por las
 * funciones SQL atómicas de la migración de pagos; acá solo se llaman y se traducen sus errores.
 */
export function createSupabasePaymentsRepo(url: string, serviceRoleKey: string): PaymentsRepo {
  const db: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  function fail(op: string, error: { message: string }): never {
    throw new Error(`db ${op}: ${error.message}`);
  }

  async function one<T>(table: string, columns: string, column: string, value: string): Promise<T | null> {
    const { data, error } = await db.from(table).select(columns).eq(column, value).maybeSingle();
    if (error) fail(`${table}.${column}`, error);
    return (data as T | null) ?? null;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = await db.rpc(name, args);
    if (error) fail(name, error);
    return data;
  }

  return {
    async createOrder(userId, items) {
      const { data, error } = await db.rpc("payments_create_order", { p_user: userId, p_items: items });
      if (error) {
        const known = CREATE_ORDER_ERRORS[String(error.message).trim()];
        if (known) throw new HttpError(known[0], known[1], error.message);
        if (error.code === "22P02") throw new HttpError(400, "invalid_cart", "Invalid cart");
        fail("payments_create_order", error);
      }
      if (typeof data !== "string") throw new Error("payments_create_order returned no id");
      return data;
    },

    getOrder: (id) => one<OrderRow>("orders", ORDER_COLUMNS, "id", id),
    getOrderByPayPalId: (id) => one<OrderRow>("orders", ORDER_COLUMNS, "paypal_order_id", id),
    getOrderByCaptureId: (id) => one<OrderRow>("orders", ORDER_COLUMNS, "paypal_capture_id", id),

    async listOrderItems(orderId) {
      const { data, error } = await db.from("order_items").select("item_type,title,size,unit_cents,qty").eq(
        "order_id",
        orderId,
      );
      if (error) fail("listOrderItems", error);
      return (data ?? []) as OrderItemRow[];
    },

    async setPayPalOrderId(orderId, paypalOrderId) {
      const { error } = await db.from("orders").update({ paypal_order_id: paypalOrderId }).eq("id", orderId);
      if (error) fail("setPayPalOrderId", error);
    },

    async releaseOrder(orderId, status, reason) {
      return (await rpc("payments_release_order", { p_order: orderId, p_new_status: status, p_reason: reason })) ===
        true;
    },

    async markPaid(i) {
      return (await rpc("payments_mark_paid", {
        p_order: i.orderId,
        p_capture_id: i.captureId,
        p_amount_cents: i.amountCents,
        p_currency: i.currency,
        p_payer_id: i.payerId,
        p_shipping: i.shipping,
        p_paypal_status: i.paypalStatus,
        p_capture_status: i.captureStatus,
      })) as never;
    },

    async applyRefund(orderId, refundId, amountCents) {
      return (await rpc("payments_apply_refund", {
        p_order: orderId,
        p_refund_id: refundId,
        p_amount_cents: amountCents,
      })) as never;
    },

    async listStaleOrders(olderThanMinutes, limit) {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
      const { data, error } = await db.from("orders").select(ORDER_COLUMNS).in("status", ["created", "pending"])
        .lt("created_at", cutoff).order("created_at", { ascending: true }).limit(limit);
      if (error) fail("listStaleOrders", error);
      return (data ?? []) as OrderRow[];
    },

    async startSubscription(userId, paypalSubscriptionId, planId) {
      const { error } = await db.rpc("payments_start_subscription", {
        p_user: userId,
        p_paypal_subscription_id: paypalSubscriptionId,
        p_plan_id: planId,
      });
      if (error) {
        if (String(error.message).trim() === "already_subscribed") {
          throw new HttpError(409, "already_subscribed", error.message);
        }
        fail("payments_start_subscription", error);
      }
    },

    getSubscriptionByPayPalId: (id) => one<SubscriptionRow>("subscriptions", SUB_COLUMNS, "paypal_subscription_id", id),

    async getLiveSubscription(userId) {
      const { data, error } = await db.from("subscriptions").select(SUB_COLUMNS).eq("user_id", userId)
        .in("status", ["active", "suspended"]).maybeSingle();
      if (error) fail("getLiveSubscription", error);
      return (data as SubscriptionRow | null) ?? null;
    },

    async syncSubscription(i) {
      return (await rpc("payments_sync_subscription", {
        p_paypal_subscription_id: i.paypalSubscriptionId,
        p_user: i.userId,
        p_plan_id: i.planId,
        p_status: i.status,
        p_next_billing: i.nextBilling,
        p_last_payment: i.lastPayment,
      })) as never;
    },

    async listPendingSubscriptions(olderThanMinutes, limit) {
      const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString();
      const { data, error } = await db.from("subscriptions").select(SUB_COLUMNS).eq("status", "approval_pending")
        .lt("created_at", cutoff).order("created_at", { ascending: true }).limit(limit);
      if (error) fail("listPendingSubscriptions", error);
      return (data ?? []) as SubscriptionRow[];
    },

    async beginEvent(eventId, eventType, resourceType, resourceId, summary) {
      return (await rpc("payments_event_begin", {
        p_event_id: eventId,
        p_event_type: eventType,
        p_resource_type: resourceType,
        p_resource_id: resourceId,
        p_summary: summary,
      })) as never;
    },

    async finishEvent(eventId, status, error) {
      await rpc("payments_event_finish", { p_event_id: eventId, p_status: status, p_error: error });
    },
  };
}
