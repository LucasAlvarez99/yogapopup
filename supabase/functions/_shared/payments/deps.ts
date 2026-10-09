import { PayPalService } from "../paypal/paypal.service.ts";
import { createSupabaseAuth } from "../auth.supabase.ts";
import { createSupabaseAudit } from "../audit.supabase.ts";
import { createSupabaseRateLimiter } from "../rate-limit.supabase.ts";
import { json } from "../http.ts";
import { loadPaymentsConfig } from "./config.ts";
import { createSupabasePaymentsRepo } from "./repo.supabase.ts";
import type { PaymentDeps } from "./ports.ts";

/** Raíz de composición de las funciones de pagos. */
export function buildPaymentDeps(env: Record<string, string | undefined> = Deno.env.toObject()): PaymentDeps {
  const cfg = loadPaymentsConfig(env);
  return {
    paypal: cfg.paypal ? new PayPalService(cfg.paypal) : null,
    repo: createSupabasePaymentsRepo(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    auth: createSupabaseAuth(cfg.supabase.url, cfg.supabase.anonKey),
    audit: createSupabaseAudit(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    limiter: createSupabaseRateLimiter(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    config: cfg.app,
  };
}

/** Igual que `serve` de las demás funciones: las dependencias se arman en la primera petición y un error de configuración se loguea sin filtrar detalles. */
export function servePayments(create: (deps: PaymentDeps) => (req: Request) => Promise<Response>): void {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  Deno.serve(async (req) => {
    try {
      handler ??= create(buildPaymentDeps());
    } catch (e) {
      console.error("[startup]", e instanceof Error ? e.message : e);
      return json({ error: { code: "server_misconfigured", message: "Server is not configured" } }, 500);
    }
    return await handler(req);
  });
}
