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
| **Datos del titular** (nombre/razón social, NIF/CIF, domicilio, correo) | Política de privacidad (RGPD/LOPDGDD) | Van en `LEGAL` de `js/config.js`; ver sección 7 bis |

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
5. **Política CORS del bucket** (obligatoria: el navegador sube el video directo a R2 con un `PUT`, y sin CORS esa
   subida falla aunque la URL firmada sea válida). Bucket → *Settings* → *CORS Policy* → *Add CORS policy* → pestaña
   **JSON**, y pega esto cambiando los orígenes por los tuyos (solo esquema + dominio, **sin** barra final ni ruta):

   ```json
   [
     {
       "AllowedOrigins": ["https://tudominio.com", "https://www.tudominio.com"],
       "AllowedMethods": ["GET", "HEAD", "PUT"],
       "AllowedHeaders": ["Content-Type", "Range"],
       "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Para probar desde GitHub Pages agrega `https://lucasalvarez99.github.io` (el origen no incluye `/yogapopup/`), y
   desde tu equipo `http://localhost:3000`; al publicar de verdad, quita los de prueba. Este formato es el del panel
   de Cloudflare; el de `wrangler r2 bucket cors set` es distinto.

## 5 · Secretos del backend y funciones (desarrollador)

1. Completa `supabase/.env` (plantilla: `supabase/.env.example`; no se sube a Git). `ALLOWED_ORIGINS` = tu dominio, **sin** barra final. Para probar antes de tener dominio, agrega temporalmente `https://lucasalvarez99.github.io` (GitHub Pages) o `http://localhost:3000`, y quítalos al publicar (con `npm run sb:secrets` otra vez).
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
3. La persona que gestiona el negocio se registra igual y se le asigna `admin`: en Supabase → **Table Editor → `profiles`**,
   doble clic en su celda `role` y escribir `admin` (o por SQL:
   `update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'correo@ejemplo.com');`).
   Queda registrado en `audit_log`. El `admin` edita, publica y borra clases y gestiona productos, pero **no sube
   videos**: eso lo hace un `developer`. *(`set_user_role()` no sirve desde el SQL Editor: exige una sesión de developer.)*

## 7 bis · Política de privacidad (RGPD / LOPDGDD)

El sitio ya trae la página `privacidad.html`, la casilla obligatoria en el registro y el registro de la aceptación.
Para abrir el registro al público falta lo que solo el titular del negocio puede aportar:

1. **Completar `LEGAL` en `js/config.js`:** nombre o razón social, NIF/CIF, domicilio y correo de contacto de privacidad.
   Hasta entonces la página muestra «[pendiente de completar]» y `npm run doctor` lo avisa.
2. **Que el asesor legal del titular revise el texto** de `privacidad.html`. Es una redacción base que describe lo que
   el sitio hace hoy; no sustituye una revisión jurídica. Conviene confirmar en particular: la edad mínima (14 años),
   los plazos de conservación y las transferencias internacionales.
3. **Mantenerla al día:** si cambia lo que se hace con los datos (pagos, analítica, boletín, nuevos proveedores),
   actualizar `privacidad.html` **y subir `PRIVACY_VERSION`** en `js/lib/legal.js`.
4. **Comprobar quién aceptó y cuándo** (la hora la pone el servidor):
   `select p.display_name, u.email, p.privacy_version, p.privacy_accepted_at from public.profiles p join auth.users u on u.id = p.id;`
   Las cuentas creadas antes de esta función quedan con ambos campos vacíos (no consta aceptación).

Tampoco hace falta un aviso de cookies mientras solo se use el almacenamiento necesario (sesión y carrito, como ahora).
Si se añade analítica, publicidad o contenido de terceros que use cookies, hace falta consentimiento previo y actualizar la política.

> **Si un admin no puede subir imágenes** (productos o miniaturas): el aviso de la pantalla ahora dice el motivo
> (sin permiso, imagen demasiado pesada, falta el bucket). Si es de permisos, `supabase/diagnostico_imagenes.sql`
> (solo lectura, para el SQL Editor) muestra en qué falla la base. La imagen se reduce a WebP y, en Safari (que no sabe
> codificar WebP), a JPEG, siempre por debajo de los 2 MB del bucket.

> **Profesores y agenda (migración `20261005120000`).** Igual orden: primero `npm run sb:db-push`, después publicar la web (la home pide `teachers` y `live_agenda`). Para dar de alta a un profesor: que se registre en el sitio y, con tu sesión de developer, panel → Profesores → su correo (tildá "También es admin" para quien además gestiona, como Manuela/Manu; la migración `20261006120000` garantiza que nunca se baja de rango a un admin).

> **Talles e IVA (migración `20261004120000`).** Orden: primero `npm run sb:db-push`, **después** publicar la web. Si la
> web sale antes, la tienda sigue funcionando sin talles ni IVA hasta que se aplique la migración. Todos los productos
> nacen con **IVA 21 %** incluido en el precio; **confirmar con la gestoría** si algún producto o servicio lleva otro tipo
> (10 %, 4 % o exento) y ajustarlo en el panel (campo «IVA incluido en el precio»).

## 8 · Primer video real (desarrollador)

Desde el panel de negocio (con una cuenta `developer`: el `admin` no puede subir videos):

1. Abre el sitio (GitHub Pages o `npm run dev`) → menú de la cuenta → **Panel de negocio** → **Clases** → **Nueva clase**.
2. Título, categoría y un video **mp4 (H.264/AAC)** de prueba, corto (30-60 s). Guardar: se ve una barra de progreso.
   El archivo viaja del navegador directo a tu bucket de R2.
3. La clase queda **Lista** y **sin publicar**. Pulsa **Publicar** y mírala en la videoteca con otra cuenta (o la tuya).
4. Dale a reproducir: debe empezar, permitir adelantar (Range) y recordar dónde te quedaste.

Si algo falla: ver la tabla de abajo (casi siempre es CORS del bucket o `ALLOWED_ORIGINS`).

Opcional, prueba automática contra el Supabase real (necesita una cuenta de prueba **confirmada** y el id de esa clase):

```bash
YP_SUPABASE_URL=https://xxxx.supabase.co YP_ANON_KEY=... \
YP_TEST_EMAIL=prueba@tudominio.com YP_TEST_PASSWORD=... YP_CLASS_ID=<id de la clase> \
npm run test:integration
```

Los 9 pasos deben salir ✓. El paso 7 confirma que R2 soporta Range requests (necesario para buscar dentro del
video); el 8 confirma que **sin la firma el video no se puede ver** (el bucket no es público).

(Alternativa sin panel, por si lo necesitas: subir el archivo con `rclone`/AWS CLI a `classes/<uuid>/archivo.mp4` y
ejecutar `supabase/first_class.example.sql` con esa key y la duración.)

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
| La subida desde el panel falla con "error de red" y en la consola del navegador dice CORS | El navegador sube directo a R2 (PUT) y el bucket no tiene política CORS, o no incluye el origen desde el que estás | R2 → bucket → Settings → CORS Policy (paso 4.5): permitir `PUT`, `GET`, `HEAD` y el header `Content-Type` desde ese origen exacto |
| La subida falla con estado 403 | Token de R2 sin permiso sobre el bucket, claves mal copiadas o `R2_BUCKET` con otro nombre | Revisar el token y `supabase/.env`, y volver a correr `npm run sb:secrets` |
| Registro OK pero no llega el correo | SMTP, SPF/DKIM o límite de envíos | Supabase → Logs → Auth y la bandeja de spam |
| "Demasiados intentos" al recuperar contraseña | Límite de Supabase (~1 por minuto por correo) | Esperar un minuto |
| Nadie puede registrarse | *Enable sign ups* desactivado | Authentication → Sign In / Providers |
