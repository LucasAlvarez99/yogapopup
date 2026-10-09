import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { syncSubscription } from "../_shared/payments/logic.ts";
import { parsePayPalId, requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

/**
 * Fase 19 · La persona aprobó la suscripción en PayPal. Se consulta la API de PayPal (no se confía en el navegador)
 * y, si está activa, se concede el acceso. Si PayPal todavía la muestra como pendiente (pasa unos segundos), se
 * devuelve `approval_pending` y el acceso llega cuando el webhook (o un nuevo intento) la vea activa.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const user = await deps.auth.requireUser(req);
      const paypal = requirePayPal(deps);
      await enforceRateLimit(deps.limiter, "paypal-activate-subscription", user.id, LIMITS.activateSubscription);
      const body = await readJson(req);
      const subscriptionId = parsePayPalId(body.subscription_id, "subscription_id");

      const row = await deps.repo.getSubscriptionByPayPalId(subscriptionId);
      if (!row || row.user_id !== user.id) throw new HttpError(404, "subscription_not_found", "Subscription not found");

      const res = await syncSubscription(
        { repo: deps.repo, paypal, audit: deps.audit },
        subscriptionId,
        deps.config.planId,
      );
      if (res.outcome !== "ok") {
        throw new HttpError(409, "subscription_invalid", "The subscription does not match the plan");
      }
      return { status: res.status, current_period_end: res.subscription?.current_period_end ?? null };
    },
  });
}
