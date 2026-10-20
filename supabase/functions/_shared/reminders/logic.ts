import type { MailMessage, MailPort, ReminderRow, RemindersConfig, RemindersRepo } from "./ports.ts";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Primer nombre para el saludo ("Ana Pérez" → "Ana"); vacío si no hay. */
export function firstName(displayName: string | null): string {
  return (displayName ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "jueves 15 de octubre, 12:00" en la zona del negocio. */
export function formatWhen(iso: string, timezone: string): { day: string; time: string } {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("es-ES", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" })
    .format(d);
  const time = new Intl.DateTimeFormat("es-ES", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d);
  return { day, time };
}

/**
 * El correo de aviso. Todo lo que escribe una persona (nombre, título de la clase, nombre del profesor) va escapado en el
 * HTML: nunca se interpreta como marcado. Sin enlaces que no sean los del propio sitio.
 */
export function buildReminderEmail(
  row: ReminderRow,
  cfg: Pick<RemindersConfig, "timezone" | "siteUrl" | "brandName">,
): MailMessage {
  const { day, time } = formatWhen(row.starts_at, cfg.timezone);
  const name = firstName(row.display_name);
  const greeting = name ? `Hola ${name},` : "Hola,";
  const mode = row.mode === "virtual" ? "clase virtual" : "clase en vivo";
  const teacher = row.teacher_name ? ` con ${row.teacher_name}` : "";
  const where = cfg.siteUrl ? `${cfg.siteUrl.replace(/\/+$/, "")}/cuenta.html` : null;
  const line1 = `Te recordamos que hoy tienes tu ${mode} «${row.title}»${teacher}.`;
  const line2 = `Es hoy, ${day}, a las ${time} (${row.duration_minutes} min).`;
  const line3 = where
    ? `Puedes ver o cancelar tu reserva (hasta que empiece la clase) desde tu cuenta: ${where}`
    : "Puedes ver o cancelar tu reserva (hasta que empiece la clase) desde tu cuenta.";
  const text = [greeting, "", line1, line2, "", line3, "", `— ${cfg.brandName}`].join("\n");
  const link = where ? ` <a href="${escapeHtml(where)}">tu cuenta</a>` : " tu cuenta";
  const html = `<p>${escapeHtml(greeting)}</p>` +
    `<p>Te recordamos que hoy tienes tu ${mode} <strong>«${escapeHtml(row.title)}»</strong>${
      escapeHtml(teacher)
    }.</p>` +
    `<p>Es hoy, <strong>${escapeHtml(day)}</strong>, a las <strong>${
      escapeHtml(time)
    }</strong> (${row.duration_minutes} min).</p>` +
    `<p>Puedes ver o cancelar tu reserva (hasta que empiece la clase) desde${link}.</p>` +
    `<p>— ${escapeHtml(cfg.brandName)}</p>`;
  return { to: row.email ?? "", subject: `Hoy a las ${time}: ${row.title}`.slice(0, 150), text, html };
}

export interface RemindersSummary {
  claimed: number;
  sent: number;
  failed: number;
  /** Reservas sin correo (no hay a dónde avisar): se dejan marcadas para no reintentarlas siempre. */
  skipped: number;
}

/**
 * Un barrido: reclama las reservas de hoy sin avisar, manda un correo por reserva y devuelve a la cola las que fallaron.
 * Un fallo de un correo no frena a los demás.
 */
export async function runReminders(
  deps: { repo: RemindersRepo; mail: MailPort; config: RemindersConfig },
): Promise<RemindersSummary> {
  const summary: RemindersSummary = { claimed: 0, sent: 0, failed: 0, skipped: 0 };
  const rows = await deps.repo.claim(deps.config.timezone, deps.config.batchLimit);
  summary.claimed = rows.length;
  const failed: string[] = [];
  for (const row of rows) {
    if (!row.email) {
      summary.skipped++;
      continue;
    }
    try {
      await deps.mail.send(buildReminderEmail(row, deps.config));
      summary.sent++;
    } catch (e) {
      summary.failed++;
      failed.push(row.booking_id);
      // Nunca se loguea el correo de la persona: solo el id de la reserva y el motivo.
      console.error(`[reminders] booking ${row.booking_id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (failed.length > 0) await deps.repo.release(failed);
  return summary;
}
