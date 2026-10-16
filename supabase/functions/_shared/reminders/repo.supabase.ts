// deno-lint-ignore no-import-prefix -- especificador npm: en línea, válido en Supabase Edge Functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ReminderRow, RemindersRepo } from "./ports.ts";

/** Repositorio con la SERVICE ROLE: llama a las funciones SQL live_reminders_claim / live_reminders_release. */
export function createSupabaseRemindersRepo(url: string, serviceRoleKey: string): RemindersRepo {
  const db: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async claim(timezone, limit) {
      const { data, error } = await db.rpc("live_reminders_claim", { p_tz: timezone, p_limit: limit });
      if (error) throw new Error(`db live_reminders_claim: ${error.message}`);
      return (data ?? []) as ReminderRow[];
    },
    async release(bookingIds) {
      if (bookingIds.length === 0) return;
      const { error } = await db.rpc("live_reminders_release", { p_ids: bookingIds });
      if (error) throw new Error(`db live_reminders_release: ${error.message}`);
    },
  };
}
