import { R2Service } from "./r2/r2.service.ts";
import { loadConfig } from "./config.ts";
import { createSupabaseRepo } from "./repo.supabase.ts";
import { createSupabaseAuth } from "./auth.supabase.ts";
import { createSupabaseAudit } from "./audit.supabase.ts";
import { json } from "./http.ts";
import type { HandlerDeps } from "./ports.ts";

/** Raíz de composición: arma las dependencias reales a partir de las variables de entorno. */
export function buildDeps(env: Record<string, string | undefined> = Deno.env.toObject()): HandlerDeps {
  const cfg = loadConfig(env);
  return {
    r2: new R2Service(cfg.r2),
    repo: createSupabaseRepo(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    auth: createSupabaseAuth(cfg.supabase.url, cfg.supabase.anonKey),
    audit: createSupabaseAudit(cfg.supabase.url, cfg.supabase.serviceRoleKey),
    config: cfg.app,
  };
}

/**
 * Arranca una Edge Function. Las dependencias se crean en la primera petición: si falta
 * una variable de entorno se registra el motivo en el log y el cliente recibe un 500
 * genérico (nunca el detalle de la configuración).
 */
export function serve(create: (deps: HandlerDeps) => (req: Request) => Promise<Response>): void {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  Deno.serve(async (req) => {
    try {
      handler ??= create(buildDeps());
    } catch (e) {
      console.error("[startup]", e instanceof Error ? e.message : e);
      return json({ error: { code: "server_misconfigured", message: "Server is not configured" } }, 500);
    }
    return await handler(req);
  });
}
