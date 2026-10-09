import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import {
  isUuid,
  ORDER_HOLD_MINUTES,
  type PaymentsCtx,
  reconcileOrder,
  SUBSCRIPTION_APPROVAL_HOURS,
  syncSubscription,
} from "../_shared/payments/logic.ts";
import { parsePayPalId, requirePayPal, timingSafeEqual } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

const SWEEP_LIMIT = 25;

/**
 * Fase 22 · Conciliación. Tres usos:
 *   { order_id }         botón "verificar de nuevo" de un pedido (personal de gestión)
 *   { subscription_id }  lo mismo para una suscripción (id de PayPal)
 *   { sweep: true }      barrido de lo que quedó sin resolver: webhooks que no llegaron, órdenes aprobadas y nunca
 *                        capturadas, pedidos abandonados (se libera su stock). Lo puede disparar un cron externo con la
 *                        cabecera `x-cron-secret` (solo el barrido) o el personal de gestión desde el panel.
 * Reutiliza la misma lógica que el webhook y el navegador: todo es idempotente.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const paypal = requirePayPal(deps);
      const ctx: PaymentsCtx = { repo: deps.repo, paypal, audit: deps.audit };

      const secret = req.headers.get("x-cron-secret");
      const viaCron = !!secret && !!deps.config.cronSecret && timingSafeEqual(secret, deps.config.cronSecret);
      let actorId: string | null = null;
      if (!viaCron) {
        const staff = await deps.auth.requireStaff(req);
        actorId = staff.id;
        await enforceRateLimit(deps.limiter, "paypal-reconcile", staff.id, LIMITS.reconcile);
      }
      const body = await readJson(req);

      if (body.sweep === true) {
        const summary = { checked: 0, paid: 0, cancelled: 0, failed: 0, still_open: 0, subscriptions: 0, errors: 0 };
        for (const order of await deps.repo.listStaleOrders(ORDER_HOLD_MINUTES, SWEEP_LIMIT)) {
          summary.checked++;
          try {
            const r = await reconcileOrder(ctx, order);
            if (r.outcome === "paid") summary.paid++;
            else if (r.outcome === "cancelled") summary.cancelled++;
            else if (r.outcome === "failed") summary.failed++;
            else if (r.outcome === "open" || r.outcome === "pending") summary.still_open++;
          } catch (e) {
            summary.errors++;
            console.error(`[reconcile] order ${order.id}:`, e instanceof Error ? e.message : e);
          }
        }
        for (const sub of await deps.repo.listPendingSubscriptions(30, SWEEP_LIMIT)) {
          summary.subscriptions++;
          try {
            const r = await syncSubscription(ctx, sub.paypal_subscription_id, deps.config.planId);
            const abandoned = r.outcome === "ok" && r.status === "approval_pending" &&
              Date.now() - Date.parse(sub.created_at) > SUBSCRIPTION_APPROVAL_HOURS * 3_600_000;
            if (abandoned) {
              await deps.repo.syncSubscription({
                paypalSubscriptionId: sub.paypal_subscription_id,
                userId: null,
                planId: sub.plan_id,
                status: "cancelled",
                nextBilling: null,
                lastPayment: null,
              });
            }
          } catch (e) {
            summary.errors++;
            console.error(
              `[reconcile] subscription ${sub.paypal_subscription_id}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }
        if (summary.paid + summary.cancelled + summary.failed + summary.errors > 0) {
          await deps.audit.record({ actorId, action: "payment.sweep", details: summary }).catch(() => {});
        }
        return { mode: "sweep", ...summary };
      }

      // Lo individual es solo del personal de gestión (el cron externo no tiene por qué verificar pedidos sueltos).
      if (viaCron) throw new HttpError(403, "admin_only", "Only the sweep can be triggered with the cron secret");

      if (body.order_id !== undefined) {
        if (!isUuid(body.order_id)) throw new HttpError(400, "invalid_input", "order_id is not valid");
        const order = await deps.repo.getOrder(body.order_id);
        if (!order) throw new HttpError(404, "order_not_found", "Order not found");
        const r = await reconcileOrder(ctx, order);
        await deps.audit.record({
          actorId,
          action: "payment.reconcile",
          entityType: "order",
          entityId: order.id,
          details: { outcome: r.outcome, status: r.order.status },
        }).catch(() => {});
        return {
          mode: "order",
          outcome: r.outcome,
          order: {
            id: r.order.id,
            status: r.order.status,
            needs_review: r.order.needs_review,
            review_note: r.order.review_note,
          },
        };
      }

      if (body.subscription_id !== undefined) {
        const id = parsePayPalId(body.subscription_id, "subscription_id");
        if (!(await deps.repo.getSubscriptionByPayPalId(id))) {
          throw new HttpError(404, "subscription_not_found", "Subscription not found");
        }
        const r = await syncSubscription(ctx, id, deps.config.planId);
        await deps.audit.record({
          actorId,
          action: "payment.reconcile",
          entityType: "subscription",
          entityId: id,
          details: { outcome: r.outcome, status: r.status },
        }).catch(() => {});
        return {
          mode: "subscription",
          outcome: r.outcome,
          status: r.status,
          current_period_end: r.subscription?.current_period_end ?? null,
        };
      }

      throw new HttpError(400, "invalid_input", "Send order_id, subscription_id or sweep");
    },
  });
}
