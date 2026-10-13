import { createEndpoint, HttpError, readJson } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { parseTier, requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

export const TIER_NAME_MAX = 40;
export const TIER_BENEFITS_MAX = 400;
export const TIER_PRICE_MIN_CENTS = 100; // 1 €
export const TIER_PRICE_MAX_CENTS = 50000; // 500 €

/**
 * Panel de negocio · guarda un nivel de suscripción (nombre, beneficios y precio mensual). Solo el personal de gestión.
 * PayPal fija el precio en el PLAN y un plan no cambia de precio: si el precio cambia (o el nivel todavía no tiene plan),
 * se crea un plan NUEVO en PayPal y pasa a ser el vigente. Las personas que ya están suscriptas siguen con su plan (y su
 * precio) hasta que cancelen; las que contraten desde ahora pagan el nuevo. Cambiar solo el nombre o los beneficios no
 * toca PayPal.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: deps.config.allowedOrigins,
    run: async (req) => {
      const staff = await deps.auth.requireStaff(req);
      await enforceRateLimit(deps.limiter, "paypal-save-tier", staff.id, LIMITS.saveTier);
      const body = await readJson(req);

      const tierNumber = parseTier(body.tier);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const benefits = typeof body.benefits === "string" ? body.benefits.trim() : "";
      const price = body.price_cents;
      if (name.length < 1 || name.length > TIER_NAME_MAX) {
        throw new HttpError(400, "invalid_input", `name must be 1 to ${TIER_NAME_MAX} characters`);
      }
      if (benefits.length > TIER_BENEFITS_MAX) {
        throw new HttpError(400, "invalid_input", `benefits must be at most ${TIER_BENEFITS_MAX} characters`);
      }
      if (
        typeof price !== "number" || !Number.isInteger(price) || price < TIER_PRICE_MIN_CENTS ||
        price > TIER_PRICE_MAX_CENTS
      ) {
        throw new HttpError(400, "invalid_price", "price_cents must be between 100 and 50000");
      }

      const current = await deps.repo.getTier(tierNumber);
      if (!current) throw new HttpError(404, "tier_not_found", "Subscription level not found");

      let planId: string | null = null;
      if (price !== current.price_cents || !current.current_plan_id) {
        const paypal = requirePayPal(deps);
        planId = (await paypal.createPlan({
          name: `${name} · ${(price / 100).toFixed(2)} EUR/mes`,
          priceCents: price,
          requestId: `yp-plan-${tierNumber}-${price}-${crypto.randomUUID()}`,
        })).id;
      }
      const saved = await deps.repo.saveTier({ tier: tierNumber, name, benefits, priceCents: price, planId });
      if (saved !== "ok") throw new HttpError(404, "tier_not_found", "Subscription level not found");

      await deps.audit.record({
        actorId: staff.id,
        action: "subscription_tier.save",
        entityType: "subscription_tier",
        entityId: String(tierNumber),
        details: { from_price_cents: current.price_cents, to_price_cents: price, new_plan: planId !== null },
      }).catch((e) => console.error("[payments] audit failed:", e instanceof Error ? e.message : e));

      return { tier: tierNumber, name, benefits, price_cents: price, plan_ready: true, new_plan: planId !== null };
    },
  });
}
