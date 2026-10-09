import { createEndpoint, HttpError, readTextLimited } from "../_shared/http.ts";
import { enforceRateLimit, LIMITS } from "../_shared/rate-limit.ts";
import { processWebhookEvent, summarizeEvent, type WebhookEvent } from "../_shared/payments/logic.ts";
import { requirePayPal } from "../_shared/payments/request.ts";
import type { PaymentDeps } from "../_shared/payments/ports.ts";

const MAX_EVENT_BYTES = 256 * 1024;

function parseEvent(raw: string): WebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_event", "Body is not valid JSON");
  }
  const e = parsed as Record<string, unknown> | null;
  if (
    !e || typeof e !== "object" || typeof e.id !== "string" || e.id.length < 3 || e.id.length > 100 ||
    typeof e.event_type !== "string" || e.event_type.length < 3 || e.event_type.length > 100 ||
    !e.resource || typeof e.resource !== "object" || Array.isArray(e.resource)
  ) {
    throw new HttpError(400, "invalid_event", "Not a PayPal event");
  }
  return {
    id: e.id,
    event_type: e.event_type,
    resource_type: typeof e.resource_type === "string" ? e.resource_type : undefined,
    resource: e.resource as Record<string, unknown>,
  };
}

/**
 * Fase 21 · Webhook de PayPal. Reglas:
 *   1. Un evento SIN firma verificada (API de PayPal) nunca se procesa: 401.
 *   2. Idempotente: el mismo evento reenviado no duplica pedidos, accesos ni reembolsos (tabla payment_events).
 *   3. Si el procesamiento falla se responde 500: PayPal reintenta solo durante días. Si ya se procesó, 200.
 * Del cuerpo solo se usa QUÉ revisar; los datos que cuentan se vuelven a pedir a la API de PayPal.
 */
export function createHandler(deps: PaymentDeps): (req: Request) => Promise<Response> {
  return createEndpoint({
    methods: ["POST"],
    allowedOrigins: [], // lo llama PayPal, no un navegador: sin CORS
    run: async (req) => {
      const paypal = requirePayPal(deps);
      const webhookId = deps.config.webhookId;
      if (!webhookId) throw new HttpError(503, "payments_not_configured", "Webhook is not configured");
      await enforceRateLimit(deps.limiter, "paypal-webhook", "all", LIMITS.webhook);

      const raw = await readTextLimited(req, MAX_EVENT_BYTES);
      const event = parseEvent(raw);

      const h = req.headers;
      const headers = {
        authAlgo: h.get("paypal-auth-algo") ?? "",
        certUrl: h.get("paypal-cert-url") ?? "",
        transmissionId: h.get("paypal-transmission-id") ?? "",
        transmissionSig: h.get("paypal-transmission-sig") ?? "",
        transmissionTime: h.get("paypal-transmission-time") ?? "",
      };
      if (Object.values(headers).some((v) => v === "")) {
        throw new HttpError(401, "invalid_signature", "Missing signature headers");
      }
      // Se verifica sobre el evento tal como llegó. Un fallo de red con PayPal lanza (500): PayPal reintenta.
      const verified = await paypal.verifyWebhook({ webhookId, headers, event: JSON.parse(raw) });
      if (!verified) throw new HttpError(401, "invalid_signature", "Signature verification failed");

      const begin = await deps.repo.beginEvent(
        event.id,
        event.event_type,
        event.resource_type ?? null,
        typeof event.resource.id === "string" ? event.resource.id.slice(0, 100) : null,
        summarizeEvent(event),
      );
      if (begin === "duplicate") return { received: true, status: "duplicate" };

      try {
        const result = await processWebhookEvent(
          { repo: deps.repo, paypal, audit: deps.audit },
          event,
          deps.config.planId,
        );
        await deps.repo.finishEvent(event.id, result.status, null);
        return { received: true, status: result.status, detail: result.detail };
      } catch (e) {
        const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        console.error(`[webhook] ${event.event_type} ${event.id} failed: ${message}`);
        await deps.repo.finishEvent(event.id, "failed", message).catch(() => {});
        throw new HttpError(500, "event_failed", "The event could not be processed");
      }
    },
  });
}
