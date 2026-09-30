# YogaPop Up · Backend (Supabase + Cloudflare R2)

El video vive en un **bucket de Cloudflare R2**; usuarios, clases, permisos y progreso viven en **Supabase**.
Hostinger solo sirve la web estática (no guarda videos). Ningún secreto llega al navegador:
las claves de R2 y la service role de Supabase solo existen como *secrets* de las Edge Functions.

```
Navegador ──► Edge Functions (Supabase) ──► Cloudflare R2 (API compatible con S3)
    │                 │
    │                 └──► Postgres (RLS, can_access_class, save_progress)
    └── sube el video DIRECTO a R2 con un PUT prefirmado (SigV4)
    └── reproduce el archivo progresivo con una URL firmada que vence
```

R2 no transcodifica: a diferencia de Bunny, no genera HLS adaptativo. El video se sirve tal cual se
subió y el navegador lo reproduce con `<video>` normal, apoyándose en Range requests para buscar.

## Funciones

| Función | Quién | Qué hace |
|---|---|---|
| `admin-create-upload` | admin | Crea la clase y devuelve una URL PUT prefirmada para subir el video directo a R2. Con `class_id` asocia el video a una clase existente. |
| `admin-sync-video` | admin | Comprueba con un HEAD directo a R2 si el objeto ya existe y lo refleja en la clase; recibe `duration_seconds` (la calcula el navegador, ya que R2 no transcodifica). La llama tanto el panel ("comprobar estado") como el formulario de subida justo al terminar el PUT. |
| `admin-delete-class` | admin | Borra el objeto en R2 y luego la clase. Si R2 falla, no borra nada (se reintenta). |
| `playback` | usuario con acceso | Devuelve la URL del video firmada (vence) + desde dónde retomar. |
| `health` | pública | Ping a la base, para UptimeRobot. |

Sin webhooks: como no hay transcodificación asíncrona, no hace falta que nadie nos avise "ya está listo".

Publicar / despublicar se hace directo contra la tabla `classes` (permitido solo a admin por RLS).
El progreso se guarda con la función SQL `save_progress()` (no pasa por Edge Functions).

## Puesta en marcha

### 1. Cloudflare R2
1. Crear un **bucket** (ej. `yogapopup-videos`) en el dashboard de Cloudflare → R2.
2. Anotar el **Account ID** (R2 → Overview).
3. R2 → *Manage API Tokens* → crear un token con permiso **Object Read & Write**, restringido
   **solo a ese bucket** (no "Admin Read & Write" de toda la cuenta). Guardar el **Access Key ID**
   y la **Secret Access Key**: la secret no se vuelve a mostrar.
4. Subir el video, en cambio, siempre lo hace el navegador con el PUT prefirmado que devuelve
   `admin-create-upload`: no hace falta subir nada a mano desde el dashboard.

> Los nombres exactos de los menús pueden variar; lo importante es cada dato de la lista.

### 2. Supabase
Desde la **raíz del proyecto** (ver README principal: `npm install` y completar `.env`):
1. Crear el proyecto en supabase.com y copiar el *Reference ID* a `SUPABASE_PROJECT_REF` en `.env`.
2. `npm run sb:login` (abre el navegador) y luego `npm run sb:link`.
3. `npm run sb:db-push` aplica la base (`supabase/migrations/`).
4. Registrar la primera cuenta desde la web y darle el rol de desarrollador con
   `supabase/promote_role.example.sql` (SQL Editor de Supabase).
5. Completar `supabase/.env` con los datos de R2 y ejecutar `npm run sb:secrets`.
6. `npm run sb:deploy` publica las funciones.

### 3. UptimeRobot (que el proyecto gratuito no se pause)
Monitor **HTTP(s)**, intervalo **5 min**, URL: `https://<PROJECT_REF>.supabase.co/functions/v1/health`.
Además avisa por mail si la base cae. Son ~8.600 llamadas/mes (el plan gratuito incluye 500.000).

## Costos (referencia, USD; verificar en la página oficial de Cloudflare)
Cloudflare R2: primeros **10 GB/mes de almacenamiento gratis**, **sin costo de egreso nunca** (a
diferencia de casi cualquier otro proveedor, ver/descargar los videos no genera tráfico facturable),
1 millón de operaciones Class A y 10 millones Class B gratis por mes. Pasado los 10 GB gratis:
~0,015 USD/GB/mes de almacenamiento.

Supuestos (a validar con el primer video en la Fase 8): 40 clases de ~45 min, sin transcodificar a
varias resoluciones (a diferencia de Bunny) → ~1-2 GB c/u → ~60-80 GB en total.

| Almacenamiento | R2 aprox./mes |
|---|---|
| 80 GB (40 clases) | ~1 USD (10 GB gratis + 70 GB pagos) |
| 200 GB | ~3 USD |

Al no cobrar egreso, el costo casi no depende de cuántas veces se reproduzcan las clases.

Supabase plan gratuito (500 MB base, 1 GB storage, 5 GB egress, 500.000 invocaciones): alcanza de
sobra. **Ojo**: no incluye copias de seguridad ni SLA; si la base pasa a ser crítica para el
cliente, el plan Pro es el paso siguiente.

## Pruebas
```
npm test           # 47 pruebas: firmas, permisos, flujos y casos de error (sin red)
npm run verify     # formato + lint + tipos + pruebas
```
Las pruebas viven en `supabase/functions/_tests/` y simulan R2 y la base en memoria. Lo que **no**
cubren (se valida con el primer video real, Fase 8): la API real de R2, la subida desde el
navegador, CORS del bucket, y los adaptadores `repo.supabase.ts` / `auth.supabase.ts` contra un
proyecto real.

## Recuperación de contraseña en producción

Las pruebas E2E confirman la interfaz y el flujo del enlace, pero el envío del correo depende de tu proyecto de
Supabase. Antes de abrir el registro:

1. **SMTP propio.** El correo integrado de Supabase está pensado solo para pruebas y tiene un límite de envíos muy
   bajo. Configura un proveedor (Resend, Postmark, Mailgun, SendGrid…) en *Authentication → SMTP Settings*.
2. **Registros del dominio** del remitente: SPF, DKIM y DMARC. Sin ellos Gmail/Outlook mandan el correo a spam.
3. **URLs de redirección.** En *Authentication → URL Configuration* añade tu dominio como *Site URL* y en
   *Redirect URLs* la página de inicio (`https://tudominio.com/index.html`): el enlace del correo vuelve ahí.
   Si no está en la lista, Supabase ignora la redirección.
4. **Caducidad del enlace.** Es corta por defecto (1 hora, ajustable en *Authentication → Email*). Si se pide varias
   veces seguidas, Supabase limita la frecuencia (aprox. 1 por minuto por correo): la web muestra
   "Demasiados intentos" en ese caso.
5. **Plantilla del correo** en español (*Authentication → Email Templates*) y prueba real con un buzón tuyo.
6. Revisa *Logs → Auth* en Supabase si "la web dice éxito pero no llega nada": la web siempre responde igual, exista
   o no la cuenta, para no revelar qué correos están registrados.

