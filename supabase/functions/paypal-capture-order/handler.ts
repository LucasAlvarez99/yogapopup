import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { PayPalError } from "../_shared/paypal/paypal.service.ts";
import { settleOrder } from "../_shared/payments/logic.ts";
import { parsePayPalId, requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

/**
 * Fase 18 · Cobra una orden que la persona ya aprobó en PayPal, y la VERIFICA contra la API de PayPal antes de
 * confirmarla (monto, moneda y que sea nuestro pedido). Nunca se confía en lo que dice el navegador: solo manda el
 * id de la orden, y el resultado sale de lo que PayPal informa.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const user = await deps.auth.requireUser(req);
      const paypal = requirePayPal(deps);
      await enforceRateLimit(deps.limiter, "paypal-capture-order", user.id, LIMITS.capturePayPalOrder);
      const body = await readJson(req);
      const paypalOrderId = parsePayPalId(body.paypal_order_id, "paypal_order_id");

      const order = await deps.repo.getOrderByPayPalId(paypalOrderId);
      // Un pedido ajeno es "no encontrado" (no se revela que existe).
      if (!order || order.user_id !== user.id) throw new HttpError(404, "order_not_found", "Order not found");

      let result;
      try {
        result = await settleOrder({ repo: deps.repo, paypal, audit: deps.audit }, order, { capture: true });
      } catch (e) {
        // La persona puede reintentar con otro medio de pago: el pedido sigue abierto.
        if (
          e instanceof PayPalError && e.status === 422 &&
          (e.issue === "INSTRUMENT_DECLINED" || e.issue === "PAYER_ACTION_REQUIRED")
        ) {
          throw new HttpError(402, "payment_declined", "The payment method was declined");
        }
        throw e;
      }
      const summary = { order_id: result.order.id, kind: result.order.kind, total_cents: result.order.total_cents };
      switch (result.outcome) {
        case "paid":
        case "already_paid":
          return { status: "paid", ...summary };
        case "pending":
          return { status: "pending", ...summary };
        case "failed":
          throw new HttpError(402, "payment_failed", "The payment was not completed");
        case "cancelled":
          throw new HttpError(409, "order_cancelled", "The order was cancelled");
        case "mismatch":
          throw new HttpError(409, "payment_review", "The payment needs to be reviewed");
        case "open":
          throw new HttpError(409, "order_not_approved", "The order was not approved in PayPal");
      }
    },
  });
}
