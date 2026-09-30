// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient } from "npm:@supabase/supabase-js@2";
import type { AuditPort } from "./ports.ts";

/** Escribe en public.audit_log con la service role (la función SQL solo es ejecutable por ella). */
export function createSupabaseAudit(url: string, serviceRoleKey: string): AuditPort {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async record(entry) {
      const { error } = await db.rpc("audit_write", {
        p_actor: entry.actorId,
        p_action: entry.action,
        p_entity_type: entry.entityType ?? null,
        p_entity_id: entry.entityId ?? null,
        p_details: entry.details ?? {},
      });
      if (error) throw new Error(`audit_write: ${error.message}`);
    },
  };
}
