# Aviso por correo de la clase en vivo (Fase 31)

Cada mañana, cada alumna anotada en una clase en vivo (o virtual) **de ese día** recibe un correo con el título, la hora, el
profesor y un enlace a *Mi cuenta* para cancelar (hasta que empiece la clase). No hay app propia: el aviso es solo por correo.

## Cómo funciona

- Una tarea programada llama a la Edge Function `live-reminders` (`supabase/functions/live-reminders`).
- La base (`live_reminders_claim`) elige las reservas de **hoy** (en `REMINDERS_TZ`, por defecto `Europe/Madrid`) cuya clase está
  publicada y **todavía no empezó**, de cuentas no suspendidas, y las marca como avisadas **en el mismo paso**: aunque el cron corra
  dos veces a la vez, nadie recibe dos correos.
- Si el proveedor de correo rechaza un envío, esa reserva **vuelve a la cola** y el siguiente barrido la reintenta. Las cuentas sin
  correo se omiten.
- Quien reserva una clase del mismo día **después** del barrido recibe su aviso en el siguiente barrido (si la clase aún no empezó).
- La función no acepta datos del navegador: quién recibe qué lo decide solo la base. Los textos que escribe una persona (título,
  nombres) van escapados en el correo.

## Puesta en marcha

1. **Cuenta de correo (Resend).** Creá una cuenta en resend.com, **verificá tu dominio** (SPF/DKIM; es la misma verificación que pide
   la Fase 37) y creá una API key. Usá el mismo proveedor como SMTP para los correos de Supabase Auth (recuperación de contraseña):
   una sola cuenta, un solo dominio.
2. **`supabase/.env`** (secretos, nunca en git):
   ```
   RESEND_API_KEY=re_...
   MAIL_FROM=Yoga Pop Up <avisos@tu-dominio>
   REMINDERS_CRON_SECRET=<un secreto largo y aleatorio>
   ```
   Opcionales: `REMINDERS_TZ` (por defecto `Europe/Madrid`), `SITE_URL` (enlace del correo), `REMINDERS_BATCH` (máximo de correos por
   barrido, 100). Después: `npm run sb:secrets`.
3. **Migración y despliegue:** `npm run sb:db-push` (`20261020120000_live_reminders`) y `npm run sb:deploy`.
4. **Programar el aviso.** En Supabase → *Integrations → Cron* (o SQL con `pg_cron`), una vez por día a las 08:00 de Madrid
   (06:00 UTC en verano, 07:00 en invierno; si preferís más de un barrido por día, no hay problema: no se repite ningún aviso):
   ```sql
   select cron.schedule(
     'live-reminders', '0 6 * * *',
     $$ select net.http_post(
          url := 'https://TU-PROYECTO.supabase.co/functions/v1/live-reminders',
          headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', '<REMINDERS_CRON_SECRET>'),
          body := '{}'::jsonb) $$);
   ```
   También sirve cualquier cron externo con `curl -X POST … -H "x-cron-secret: …"`. El personal de gestión puede dispararlo a mano
   (misma URL con su sesión; con límite de frecuencia).
5. **Comprobar:** `npm run doctor:online` tiene que mostrar `live-reminders sin sesión: 401` (y no el aviso de 503).

## Prueba real (antes de dar la Fase 31 por cumplida)

- [ ] Crear una clase en vivo para hoy (más tarde que ahora) y reservarla con una cuenta tuya con un correo que leas.
- [ ] Disparar el aviso: `curl -X POST https://TU-PROYECTO.supabase.co/functions/v1/live-reminders -H "x-cron-secret: …" -d '{}'`
      → responde `{"claimed":1,"sent":1,"failed":0,"skipped":0}` y llega el correo (revisá también *spam*).
- [ ] Repetir el comando: `claimed: 0` (no hay segundo correo).
- [ ] Apagar `RESEND_API_KEY` a propósito: responde 503 y **no** marca nada como avisado.
- [ ] Con una clave inválida: `failed: 1` y, al corregirla, el siguiente barrido envía el correo.
- [ ] La hora del correo es la de Ibiza/Madrid, no la de tu computadora.
