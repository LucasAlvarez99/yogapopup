import { createEndpoint, HttpError } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { PayPalError } from "../_shared/paypal/paypal.service.ts";
import { syncSubscription } from "../_shared/payments/logic.ts";
import { requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

/**
 * Fase 20 · Cancela la suscripción EN PAYPAL (no solo en la base: si no, se seguiría cobrando) y deja el acceso
 * hasta que venza lo ya pagado. Cancelar dos veces no es un error.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const user = await deps.auth.requireUser(req);
      const paypal = requirePayPal(deps);
      await enforceRateLimit(deps.limiter, "paypal-cancel-subscription", user.id, LIMITS.cancelSubscription);

      const live = await deps.repo.getLiveSubscription(user.id);
      if (!live) throw new HttpError(404, "no_subscription", "No active subscription");

      try {
        await paypal.cancelSubscription(live.paypal_subscription_id, "Cancelada por la persona desde su cuenta");
      } catch (e) {
        // Si PayPal ya la tenía cancelada, igual hay que reflejarlo en la base.
        if (!(e instanceof PayPalError && e.status === 422 && e.issue === "SUBSCRIPTION_STATUS_INVALID")) throw e;
      }
      await deps.audit.record({
        actorId: user.id,
        action: "subscription.cancel_requested",
        entityType: "subscription",
        entityId: live.paypal_subscription_id,
      }).catch((e) => console.error("[payments] audit failed:", e instanceof Error ? e.message : e));

      const res = await syncSubscription(
        { repo: deps.repo, paypal, audit: deps.audit },
        live.paypal_subscription_id,
        deps.config.planId,
      );
      return { status: res.status, access_until: res.subscription?.current_period_end ?? null };
    },
  });
}
