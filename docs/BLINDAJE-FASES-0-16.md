# Blindaje de las Fases 0 a 16

Revisión de seguridad y robustez de todo lo construido antes de Cloudflare R2 real y pagos. Se auditó el código
(backend, SQL, frontend, CI), se ejecutaron las pruebas existentes y se corrigieron las brechas encontradas, cada una
con su prueba. Las migraciones anteriores **no se tocaron**: todo lo nuevo está en
`supabase/migrations/20261001120000_hardening_fases_0_16.sql`.

## Qué estaba bien (no se cambió)

- Permisos por columna: la clave del video en R2 no la puede leer ningún navegador.
- RLS en todas las tablas; roles `user` / `owner` / `developer`; nadie se cambia el rol desde el navegador.
- Auditoría inmutable (`audit_log`), protección del último desarrollador, borrado de video antes que el de la clase.
- Sin `innerHTML` ni `eval` ni scripts/estilos inline en todo el sitio; CORS por lista blanca; secretos solo en backend.
- `npm audit`: 0 vulnerabilidades.

## Brechas encontradas y corregidas

| # | Brecha | Qué pasaba | Corrección | Prueba |
|---|--------|-----------|-----------|--------|
| 1 | Sin límite de frecuencia | Una cuenta robada o un script podía pedir firmas de R2, subidas o borrados sin freno (`claude.md` lo exige) | Límite por usuario y por función (contador en Postgres, ventana fija). 429 + `Retry-After` | `hardening.test.ts`, `hardening.test.sql` |
| 2 | "Video" que no es video | Un archivo vacío, de más de 5 GiB o un HTML/ZIP quedaba `ready` y publicable | Se valida tamaño y tipo (`video/*`) en R2; si no sirve → `failed`, se despublica y el reintento borra el objeto malo | `hardening.test.ts` |
| 3 | Duración sin validar | `"5"`, `true`, `[]` pasaban; `1e12` desbordaba la columna → error 500 | Solo número entre 1 s y 24 h; tope también en la base | `hardening.test.ts`, `.sql` |
| 4 | Tope de cuerpo en caracteres | Se medía `.length`, no bytes; se leía todo antes de cortar | Tope en bytes y corte por `Content-Length` sin leer el cuerpo | `hardening.test.ts` |
| 5 | Núcleo de la Fase 0 sin pruebas SQL reales | `can_access_class` y `save_progress` solo se probaban contra una réplica en memoria | Matriz completa contra PostgreSQL: gratis/restringido, entitlements vencidos o ajenos, borradores, roles, privacidad del progreso | `hardening.test.sql` |
| 6 | `save_progress` | Sin duración conocida el avance no tenía tope; propietario + clase inexistente daba error de clave foránea | Tope 24 h; error claro `class_not_found` | `hardening.test.sql` |
| 7 | Sin topes en la base | Precio/stock/duración sin máximo; `image_url` aceptaba `javascript:` o `data:` | `CHECK` de rango y de formato (`https`) | `hardening.test.sql` |
| 8 | Cambios de precio sin rastro | Subir/bajar precios, ocultar o borrar un producto no se registraba | Auditoría de precio, activar/ocultar y borrado | `hardening.test.sql` |
| 9 | Subida: éxito falso | El panel decía "Clase creada y video subido" aunque el servidor marcara `failed`; la duración podía ser `NaN`/`Infinity`; sin tope de espera | Valida archivo antes de subir, sanea la duración, exige `ready` y muestra el motivo; `callFunction` y la lectura de duración con timeout | `video-upload.test.js` |
| 10 | Sin CSP ni cabeceras | Ninguna barrera si algún día se cuela un script | CSP estricta + `nosniff`, anti-iframe, referrer, HSTS, generadas en el build (`.htaccess` y `<meta>` para GitHub Pages) | `csp.test.js` |
| 11 | CI | El workflow de Pages publicaba **sin correr pruebas**; el token de CI sin permisos mínimos | `verify` antes de publicar; `permissions: contents: read`; `npm audit` y comprobación de la CSP en el build | — |

Las defensas del backend y de la CSP se comprobaron además **rompiéndolas a propósito**: cada una hace fallar al menos
una prueba.

## Cifras

| | Antes | Ahora |
|---|---|---|
| Pruebas de backend (Deno) | 48 | 64 |
| Pruebas de frontend | 87 | 102 |
| Pruebas de base de datos | migraciones + permisos | + `hardening.test.sql` (acceso, progreso, límite, topes, auditoría) |

## Cómo desplegarlo

1. `supabase db push` (aplica la migración nueva).
2. Redesplegar las Edge Functions (`npm run sb:deploy` o el comando habitual).
3. `npm run build` y publicar el contenido de `dist/`.

El orden no es crítico: si las funciones nuevas llegan antes que la migración, el limitador no encuentra su función y
**deja pasar** (queda en el log `[rate-limit] limiter unavailable`); no hay caída.

## Decisiones a conocer

- **El limitador "falla abierto".** Si la base no responde, la petición pasa. Es deliberado: la autorización real va
  antes y es independiente (hay una prueba que lo demuestra), y un contador caído no debe tumbar la reproducción.
- **Los `CHECK` nuevos son `NOT VALID`.** Se exigen a todo lo nuevo o editado y no impiden aplicar la migración si ya
  hubiera datos fuera de rango. Para exigirlo también a lo existente: `alter table … validate constraint …`.
- **Límites** (por usuario y minuto): reproducción 60, confirmar subida 60, crear subida 20, borrar clase 20.
- **HSTS** sin `includeSubDomains` ni `preload`, a propósito.
- La CSP permite `https://*.r2.cloudflarestorage.com` (subida y reproducción). Si se usa un dominio propio para R2,
  añadirlo en `scripts/lib/security-headers.mjs`.

## Pendiente de verificar a mano (no se pudo automatizar en esta revisión)

1. `npm run test:e2e` (necesita Chrome y ffmpeg; corre en CI, no se pudo ejecutar localmente en la revisión).
2. Abrir cada página del sitio construido con la consola del navegador abierta y comprobar que **no hay avisos de CSP**
   (login, catálogo, reproducción, tienda, panel, subida de video y de imágenes).
3. Subir un video real a R2 y comprobar la reproducción (verifica CORS del bucket + CSP juntos).

## Fuera de alcance / para la siguiente etapa

- **Imágenes de Unsplash** enlazadas directamente en `index.html` (permitidas por la CSP): alojarlas en `assets/`.
- **3 enlaces `href="#"`** que quedan en `index.html` (secciones que aún no existen).
- **Antes de pagos (Fase 17):** los pedidos deben guardar una *copia* del precio y del título; hoy un producto se puede
  borrar directo, así que `order_items` no debe depender de `products` con borrado en cascada.
- Fijar las GitHub Actions por hash (hoy por versión mayor) y activar Dependabot.
