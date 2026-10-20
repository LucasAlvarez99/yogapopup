# Entrega al cliente · checklist

Lista corta, en orden, de lo que falta para publicar en Hostinger y entregar. Cada punto dice **quién** lo hace y **cómo saber que
salió bien**. El detalle técnico de cada paso está en [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md), [`PAYPAL.md`](PAYPAL.md),
[`RECORDATORIOS.md`](RECORDATORIOS.md) y [`FASES-32-36.md`](FASES-32-36.md).

> Estado al 20/10/2026: `npm run doctor:online` da **30 de 30 en verde** (Supabase, R2, PayPal en *sandbox*, CORS con
> `yogapopuplife.com` y GitHub Pages). Lo que falta es probar con cosas reales y completar datos y trámites.

## 1 · Datos y trámites del cliente (bloquean la venta)

- [ ] **NIF/CIF y domicilio** del titular. Hoy `js/config.js > LEGAL` dice «Tramitando» y `npm run doctor` ya lo marca como pendiente.
      *NIF* = número de identificación fiscal: el de una persona o autónomo (DNI/NIE + letra) o el de una sociedad (letra + 7 cifras +
      control, p. ej. `B12345678`; antes se llamaba CIF). Hasta tenerlo no se puede vender ni publicar el aviso legal completo.
- [ ] **Revisión por la gestoría o un asesor** de `privacidad.html`, `aviso-legal.html` y `condiciones.html`. Puntos a decidir
      (están también en los comentarios al inicio de cada página): si hace falta una **casilla obligatoria** en el pago por la pérdida
      del desistimiento de los videos, cómo se **emiten las facturas** (el sistema no las emite), el plazo de entrega y quién paga la devolución.
- [ ] **IVA:** confirmar el tipo de cada cosa (hoy 21 % en todo) y ajustarlo en el panel.
- [ ] **Precios reales** de niveles, videos y productos; **fotos propias** para sustituir las de Unsplash de la home; **videos** del catálogo.
- [ ] Cuenta de **PayPal Business verificada** (y a nombre del cliente), acceso a **Hostinger** y al DNS del dominio.

## 2 · Correo (recuperación de contraseña y avisos de clases en vivo)

**Qué son SPF, DKIM y DMARC.** Son tres registros que se añaden al DNS del dominio para que Gmail, Outlook, etc. confíen en los correos que
salen «de» `@yogapopuplife.com`:

| Registro | Qué dice | Si falta |
|---|---|---|
| **SPF** | Qué servidores pueden enviar correo en nombre del dominio | Los correos van a spam o se rechazan |
| **DKIM** | Una firma digital que prueba que el correo no se alteró y salió de un remitente autorizado | Igual: spam o rechazo |
| **DMARC** | Qué hacer si SPF/DKIM fallan (nada, cuarentena o rechazar) y a dónde mandar los informes | Cualquiera puede suplantar el dominio con más facilidad |

No se programan: el proveedor de correo (Resend) te da los valores y tú los pegas en el DNS.

Pasos (Lucas, con el cliente o con su acceso al DNS):

1. Crear cuenta en **resend.com** → *Domains* → *Add domain* con el dominio (mejor un subdominio, p. ej. `send.yogapopuplife.com`) y región **EU**.
2. Resend muestra los registros (MX/SPF y DKIM). Pegarlos en el **DNS del dominio**, que está donde se gestione (hPanel de Hostinger →
   *Dominios* → *DNS / Servidores de nombres*, o Cloudflare). Añadir también un DMARC mínimo: `TXT` en `_dmarc` con
   `v=DMARC1; p=none; rua=mailto:correo-del-cliente`. Más adelante se endurece a `quarantine`.
3. En Resend pulsar **Verify**. Puede tardar de minutos a unas horas. ✔ Debe quedar el dominio en *Verified*.
4. *API Keys* → crear una con permiso **Sending access** limitada a ese dominio.
5. **SMTP de Supabase** (para confirmar cuenta y recuperar contraseña): Supabase → *Authentication* → *SMTP Settings* (el nombre del menú
   cambia según la versión del panel) → activar SMTP propio: host `smtp.resend.com`, puerto `465`, usuario `resend`, contraseña = la API key,
   remitente `avisos@yogapopuplife.com`, nombre `Yoga Pop Up`. Traducir las plantillas *Confirm signup* y *Reset password* (PUESTA-EN-MARCHA §3).
6. **Avisos de clases en vivo:** en `supabase/.env` poner `RESEND_API_KEY`, `MAIL_FROM` y `REMINDERS_CRON_SECRET` (un texto largo aleatorio;
   en PowerShell: `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`), luego `npm run sb:secrets` y `npm run sb:deploy`.
7. En Supabase → *Database* → *Extensions* activar `pg_cron` y `pg_net`, y programar el aviso diario con el SQL de
   [`RECORDATORIOS.md`](RECORDATORIOS.md) (paso 4). Se programa en UTC: `0 6 * * *` son las 08:00 en Madrid con horario de verano y las 07:00 en invierno.
8. Probar con la lista «Prueba real» de `RECORDATORIOS.md` y con una recuperación de contraseña real.

✔ `npm run doctor:online` ya muestra `live-reminders sin sesión: 401` (la función está desplegada); falta la prueba con un correo real.

## 3 · Prueba con un video real (Fases 33-36)

- [ ] Con una cuenta `developer`: panel → *Clases* → *Nueva clase* con un mp4 corto (H.264/AAC), publicarlo y verlo con otra cuenta.
- [ ] Correr `npm run test:integration` con las variables `YP_SUPABASE_URL`, `YP_ANON_KEY`, `YP_TEST_EMAIL`, `YP_TEST_PASSWORD`, `YP_CLASS_ID`
      (ver `docs/PUESTA-EN-MARCHA.md` §8): deben salir los 9 pasos ✓.
- [ ] Probar en móvil (Chrome Android y Safari iPhone). Subir 3, 10 y luego el catálogo completo (~40) y revisar costos con `npm run cost`.

## 4 · PayPal: sandbox y paso a producción

- [ ] Completar la checklist «Prueba en el sandbox» de [`PAYPAL.md`](PAYPAL.md) (compra, carrito mixto, reembolsos, suscripción, webhook).
- [ ] App **Live** en PayPal → `PAYPAL_ENV=live`, `PAYPAL_CLIENT_ID` y `PAYPAL_CLIENT_SECRET` nuevos en `supabase/.env`; `npm run sb:secrets`.
- [ ] `npm run paypal:webhook -- --url https://TU-PROYECTO.supabase.co/functions/v1/paypal-webhook --confirm-live` y guardar el nuevo `PAYPAL_WEBHOOK_ID`.
- [ ] `PAYPAL.CLIENT_ID` de `js/config.js` = el Client ID **live** (el workflow de Hostinger sube lo que haya en la rama). `npm run doctor` debe decir que coinciden.
- [ ] En el panel → *Pagos* → *Planes*: volver a guardar los 3 niveles (los planes del sandbox no existen en live).
- [ ] Una compra real de 0,10 € con **otra** cuenta de PayPal y su reembolso (`PAYPAL.md`, «Primera prueba con dinero real»).

## 5 · Dominio y publicación en Hostinger

- [ ] Dominio `yogapopuplife.com` apuntando al hosting, **HTTPS activo** (SSL gratuito de Hostinger) y, si se quiere, `www` redirigido al dominio sin `www`.
- [ ] `ALLOWED_ORIGINS` solo con el dominio final (sin `localhost` ni `github.io`); el **CORS del bucket de R2** y *Site URL* / *Redirect URLs* de Supabase Auth con el dominio.
- [ ] Publicar: `npm run build` y subir el **contenido** de `dist/` a `public_html`, o usar el workflow manual **Publicar en Hostinger** (configuración en el
      encabezado de `.github/workflows/hostinger.yml`: secretos `HOSTINGER_FTP_SERVER`, `HOSTINGER_FTP_USER`, `HOSTINGER_FTP_PASSWORD`).
- [ ] Comprobar en el dominio real: `https://yogapopuplife.com/.env` y `/package.json` deben dar error (no descargarse), y registro, videoteca, carrito, pago y panel deben funcionar.
- [ ] **UptimeRobot** hacia `https://<REFERENCE_ID>.supabase.co/functions/v1/health` cada 5 minutos, y **copia de seguridad manual de la base** antes de abrir al público.

## 6 · Día de entrega (Fase 39)

- [ ] Recorrido con el cliente: subir un video, publicarlo, verlo como usuario, comprar en la tienda, suscribirse, reservar una clase en vivo y recibir el aviso.
- [ ] Traspaso de accesos (Supabase, Cloudflare, PayPal, Hostinger, Resend, DNS) a nombre del cliente, con la autenticación en dos pasos activada.
- [ ] `npm run verify` y `npm run test:e2e` en verde, y firma de conformidad.
