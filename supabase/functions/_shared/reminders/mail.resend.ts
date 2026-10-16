import type { MailMessage, MailPort } from "./ports.ts";

export class MailError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "MailError";
  }
}

/**
 * Envío por la API HTTP de Resend (resend.com). Es el mismo proveedor que se usa como SMTP para los correos de Supabase Auth
 * (recuperación de contraseña, Fase 37): una sola cuenta y un solo dominio verificado (SPF/DKIM). `fetchFn` se inyecta en los tests.
 */
export class ResendMail implements MailPort {
  constructor(
    private readonly cfg: { apiKey: string; from: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
      body: JSON.stringify({
        from: this.cfg.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // El cuerpo de error del proveedor no se reenvía a nadie ni se loguea completo (puede nombrar el destinatario).
      await res.body?.cancel();
      throw new MailError(`mail provider rejected the message (HTTP ${res.status})`, res.status);
    }
    await res.body?.cancel();
  }
}
