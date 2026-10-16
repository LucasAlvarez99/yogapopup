/**
 * Puertos del aviso de clases en vivo (Fase 31). En producción: repo.supabase.ts (funciones SQL live_reminders_*) y el
 * envío de correo por HTTP (mail.resend.ts); en los tests, dobles en memoria.
 */
import type { AuditPort, AuthPort, RateLimiterPort } from "../ports.ts";

/** Una reserva a avisar, ya "reclamada" (marcada como avisada) por la base. */
export interface ReminderRow {
  booking_id: string;
  user_id: string;
  email: string | null;
  display_name: string | null;
  session_id: string;
  title: string;
  starts_at: string;
  duration_minutes: number;
  mode: "live" | "virtual";
  teacher_name: string | null;
}

export interface RemindersRepo {
  /** Reserva (atómicamente) las reservas de HOY sin avisar, hasta `limit`. Cada una se devuelve una sola vez. */
  claim(timezone: string, limit: number): Promise<ReminderRow[]>;
  /** Devuelve reservas que no se pudieron avisar: el próximo barrido las reintenta. */
  release(bookingIds: string[]): Promise<void>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailPort {
  /** Lanza si el proveedor no aceptó el correo. */
  send(message: MailMessage): Promise<void>;
}

export interface RemindersConfig {
  allowedOrigins: string[];
  /** Secreto del cron (cabecera x-cron-secret). null = solo el personal de gestión puede disparar el aviso. */
  cronSecret: string | null;
  /** Zona horaria del negocio: define qué es "hoy" y en qué hora se muestra la clase. */
  timezone: string;
  /** Dirección pública del sitio (para el enlace del correo). null = sin enlace. */
  siteUrl: string | null;
  brandName: string;
  /** Máximo de correos por barrido (el resto sale en el siguiente). */
  batchLimit: number;
}

export interface RemindersDeps {
  /** null cuando falta configurar el correo: la función responde 503 `mail_not_configured`. */
  mail: MailPort | null;
  repo: RemindersRepo;
  auth: AuthPort;
  audit: AuditPort;
  limiter: RateLimiterPort;
  config: RemindersConfig;
}
