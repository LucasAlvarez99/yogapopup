import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { requirePayPal, safeReturnUrl } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

/**
 * Fase 19 · Crea la suscripción en PayPal del lado del servidor (con la persona como `custom_id` y el plan del
 * negocio, nunca uno que mande el navegador) y devuelve su id para que el botón de PayPal la apruebe.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const user = await deps.auth.requireUser(req);
      const paypal = requirePayPal(deps);
      const planId = deps.config.planId;
      if (!planId) throw new HttpError(503, "payments_not_configured", "Subscriptions are not configured");
      await enforceRateLimit(deps.limiter, "paypal-create-subscription", user.id, LIMITS.createSubscription);
      const body = await readJson(req);

      if (await deps.repo.getLiveSubscription(user.id)) {
        throw new HttpError(409, "already_subscribed", "You already have an active subscription");
      }
      const returnUrl = safeReturnUrl(body.return_url, deps.config.allowedOrigins);
      const created = await paypal.createSubscription({
        planId,
        userId: user.id,
        brandName: deps.config.brandName,
        returnUrl,
        cancelUrl: returnUrl,
        requestId: `yp-sub-${user.id}-${crypto.randomUUID()}`,
      });
      await deps.repo.startSubscription(user.id, created.id, planId);
      return { subscription_id: created.id };
    },
  });
}
