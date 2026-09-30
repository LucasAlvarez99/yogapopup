# Puesta en marcha con cuentas reales

Guía para pasar de "todo probado con simulaciones" a "el sitio funcionando con Supabase, Cloudflare R2 y Hostinger".
Cada paso indica **quién** lo hace y **cómo comprobar** que salió bien. Tiempo total estimado: 2–3 horas.

> Regla de oro: las claves privadas (R2, service role) **solo** van en `supabase/.env`. En `js/config.js` solo van
> datos públicos. `npm run doctor` lo comprueba por ti.

## 0 · Qué necesita el cliente (una sola vez)

| Qué | Para qué | Nota |
|---|---|---|
| Cuenta en **Supabase** | Usuarios, clases, progreso | Región **UE** (Frankfurt o Irlanda). Guarda la contraseña de la base |
| Cuenta en **Cloudflare** (con método de pago si se supera el nivel gratis) | Videos | Crear un bucket de **R2** |
| Acceso a **Hostinger** (FTP o Git) | Publicar la web | Solo sirve archivos estáticos |
| Cuenta en **UptimeRobot** (gratis) | Evitar que Supabase se pause | |
| **Dominio** definitivo | CORS y enlaces de correo | Ej. `https://yogapopup.es` |
| Proveedor de correo (Resend, Postmark…) | Correos de confirmación y recuperación | Ver paso 3 |
| **Política de privacidad** publicada | RGPD/LOPDGDD | Su URL va en `PRIVACY_URL` |

## 1 · Preparar el proyecto en tu equipo (desarrollador)

```bash
nvm use && npm ci          # Node 22, instalación reproducible
npm run verify             # debe terminar en verde
npm run doctor             # ahora marcará ✗ lo que falta: es lo esperado
```

## 2 · Supabase: crear y vincular (desarrollador)

1. En supabase.com crea el proyecto. Anota **Reference ID** (Project Settings → General).
2. Pon el Reference ID en `SUPABASE_PROJECT_REF` dentro de `.env` (raíz).
3. `npm run sb:login` (abre el navegador) → `npm run sb:link` → `npm run sb:db-push`
   (aplica todas las migraciones en orden: tablas y RLS, miniaturas, roles y auditoría, publicación, R2, productos,
   categoría e imágenes de producto; las de Storage crean solos los buckets `class-thumbnails` y `product-images`).
4. En Project Settings → API copia **Project URL** y la clave **anon/publishable** a `js/config.js`
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FUNCTIONS_URL`). **Nunca** la `service_role`.

✔ Comprobación: en Supabase → Table Editor deben existir `profiles`, `classes`, `entitlements`, `video_progress`, `audit_log`.

## 3 · Supabase: autenticación y correos (desarrollador + cliente)

*Authentication → …*

| Ajuste | Valor |
|---|---|
| URL Configuration → **Site URL** | `https://tudominio.com` |
| URL Configuration → **Redirect URLs** | `https://tudominio.com/index.html` |
| Providers → Email | **Confirm email: activado** |
| SMTP Settings | Tu proveedor de correo (el integrado solo sirve para pruebas y tiene un límite muy bajo) |
| Email Templates | Traducir *Confirm signup* y *Reset password* al español |

Registros DNS del dominio remitente: **SPF, DKIM y DMARC** (los da el proveedor de correo).
Detalle en [`supabase/README.md`](../supabase/README.md#recuperación-de-contraseña-en-producción).

## 4 · Cloudflare R2 (cliente o desarrollador)

1. Dashboard de Cloudflare → **R2** → *Create bucket* (ej. `yogapopup-videos`). Ubicación automática está bien.
2. R2 → Overview: anota el **Account ID**.
3. R2 → *Manage API Tokens* → *Create API Token*: permiso **Object Read & Write**, restringido **a ese bucket**
   (no "Admin Read & Write" de toda la cuenta). Copia el **Access Key ID** y la **Secret Access Key**
   (la secret no se vuelve a mostrar: si se pierde, hay que crear un token nuevo).
4. **No** actives acceso público al bucket ni un dominio público (`r2.dev` o dominio propio) para él: todo el
   acceso al video pasa por las URLs firmadas que generan las Edge Functions. Un bucket público lo dejaría
   viendo cualquiera con el link, sin pasar por `can_access_class()`.

## 5 · Secretos del backend y funciones (desarrollador)

1. Completa `supabase/.env` (plantilla: `supabase/.env.example`). `ALLOWED_ORIGINS` = tu dominio, **sin** `localhost` ni barra final.
2. `npm run sb:secrets` → `npm run sb:deploy`.

## 6 · Comprobar la configuración (desarrollador)

```bash
npm run doctor            # sin red: js/config.js y supabase/.env
npm run doctor:online     # con red: funciones, CORS, privacidad de columnas, ajustes de Auth
```

Debe terminar con **0 errores**. Los avisos (`!`) se leen y se deciden (p. ej. `PRIVACY_URL` vacío).

## 7 · Roles (desarrollador)

1. Regístrate desde la web con tu correo y confírmalo.
2. En Supabase → SQL Editor ejecuta `supabase/promote_role.example.sql` con tu correo (rol `developer`).
3. La persona propietaria se registra igual y se le asigna `owner` con
   `select public.set_user_role('<su id>', 'owner');` (queda en `audit_log`).

## 8 · Primer video real (desarrollador)

El panel de gestión llega en una fase posterior. Mientras tanto:
1. Sube el video al bucket de R2 con una key del tipo `classes/<uuid>/archivo.mp4` (con el dashboard de
   Cloudflare, `rclone`, o el AWS CLI apuntando al endpoint de R2: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
2. Ejecuta `supabase/first_class.example.sql` en el SQL Editor con esa key y la duración del video en segundos.
3. Crea una cuenta de prueba **confirmada** y prueba la integración real:

```bash
YP_SUPABASE_URL=https://xxxx.supabase.co YP_ANON_KEY=... \
YP_TEST_EMAIL=prueba@tudominio.com YP_TEST_PASSWORD=... YP_CLASS_ID=<id de la clase> \
npm run test:integration
```

Los 9 pasos deben salir ✓. El paso 7 confirma que R2 soporta Range requests (necesario para buscar dentro del
video); el 8 confirma que **sin la firma el video no se puede ver** (el bucket no es público).

## 9 · Publicar la web (desarrollador + cliente)

```bash
npm run build             # arma dist/ con SOLO los archivos públicos
```

Sube a `public_html` el **contenido** de `dist/` (no la carpeta del proyecto). Después abre el sitio, crea una
cuenta, entra a la videoteca y reproduce la clase en el móvil y en el ordenador.

## 10 · UptimeRobot (cliente)

Monitor **HTTP(s)**, cada **5 minutos**: `https://<REFERENCE_ID>.supabase.co/functions/v1/health`.
Evita que el plan gratuito de Supabase se pause por inactividad y avisa si la base cae.

## Si algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| `doctor`: "Función health … estado 404" | Funciones sin desplegar | `npm run sb:deploy` |
| `doctor`: "CORS … no permitido" | `ALLOWED_ORIGINS` sin el dominio | Corregir `supabase/.env` y `npm run sb:secrets` |
| Integración paso 6/7 ✗ (403 o sin Range) | `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` equivocadas, o el token no tiene permiso sobre el bucket | Revisar el token en R2 → Manage API Tokens |
| Integración paso 8 ✗ (se ve sin firma) | El bucket tiene acceso público activado | Desactivar el acceso público / el dominio `r2.dev` del bucket |
| El navegador bloquea el video por CORS | El navegador sube directo a R2 (PUT) y el bucket no tiene una política de CORS | R2 → bucket → Settings → CORS Policy: permitir `PUT`, `GET`, `HEAD` desde tu dominio |
| Registro OK pero no llega el correo | SMTP, SPF/DKIM o límite de envíos | Supabase → Logs → Auth y la bandeja de spam |
| "Demasiados intentos" al recuperar contraseña | Límite de Supabase (~1 por minuto por correo) | Esperar un minuto |
| Nadie puede registrarse | *Enable sign ups* desactivado | Authentication → Sign In / Providers |
