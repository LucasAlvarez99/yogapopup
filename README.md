# YogaPop Up

Sitio de yoga (cursos, clases en vivo, tienda y **videoteca**) al que se le suma un sistema profesional de
videos: los videos viven en **Cloudflare R2**, los usuarios, clases, permisos y progreso en **Supabase**, y la
web sigue siendo el sitio estático actual alojado en **Hostinger** (sin videos en el hosting).

> ## Estado actual (30/09/2026) · Fases 0-16 cumplidas
>
> **Poner el sitio a andar con cuentas reales:** [`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md) ·
> Reglas del proyecto: [`claude.md`](claude.md) · Encargo original: [`docs/ENCARGO-ORIGINAL.md`](docs/ENCARGO-ORIGINAL.md) ·
> Hoja de ruta hasta la entrega: [`Fases`](#fases) más abajo (Fase 0 = hoy, Fase 39 = día de entrega).
>
> **Probado:** 47 pruebas de backend (roles, auditoría, contratos, firmas R2) · 87 unitarias del frontend y de `doctor` (incluye una guarda de enlaces y recursos de todas las páginas) ·
> **pruebas de base de datos** (`npm run test:db`: migraciones en orden, matriz de permisos por rol, historial inmutable,
> verificadas rompiendo la migración a propósito) · **44 pruebas E2E** en Chromium real, todas en verde (30/09/2026, incluidas las 2 de la
> tienda de la Fase 13, las del panel —acceso por rol, lista de clases, CRUD completo de productos con imagen y 4 del ciclo de vida de las clases— y 8 del carrito de la Fase 16).
>
> **Roles hechos:** `user` / `admin` / `developer` (el developer es superconjunto del admin; la diferencia: **solo el developer sube videos**), historial de
> auditoría que nadie puede editar ni borrar, cambios de rol solo por desarrolladores y protección del último desarrollador.
> **Cuentas reales preparadas:** guía, `npm run doctor[:online]` y una prueba de integración real que se ejecuta
> sola cuando existan las credenciales (`npm run test:integration`). **Falta que el cliente cree las cuentas** (ver
> "Tareas externas pendientes" en la hoja de ruta).
> **Panel de negocio (`panel.html`):** listar con filtros, crear, editar, subir el video a R2 (con progreso),
> reintentar, publicar, despublicar y eliminar, protegido por rol; pestaña **Productos** (Fase 14) con alta, edición,
> imagen, publicar/ocultar y borrado. **Identidad visual:** logo real (`assets/logo-claro.png` /
> `logo-oscuro.png`) en navbar, pie y favicon; paleta verificada contra el manual de marca; redes sociales reales
> (WhatsApp, Instagram, YouTube) en los pies de página.
>
> **Aún no existe:** panel técnico interno (solo desarrolladores), reconciliación programada, pagos, y la prueba con un
> video real en tu bucket de R2 (Fase 33; el panel de clases está probado de punta a punta contra el backend simulado).
> La tienda pública (Fases 12-13), el carrito (Fases 15-16) y el panel de productos (Fase 14) están construidos y probados
> en navegador contra el backend simulado; el panel de productos además se validó a mano contra el Supabase real (30/09/2026).
>
> ```bash
> nvm use && npm ci                              # instalación reproducible
> npm run verify                                 # formato + lint + tipos + pruebas de backend y frontend
> npm run test:db                                # base de datos (requiere PostgreSQL y bash)
> npm run doctor                                 # ¿la configuración está lista para producción?
> CHROME_PATH=/ruta/a/chrome npm run test:e2e    # 44 pruebas E2E (requiere Chrome/Chromium y ffmpeg)
> npm run dev                                    # sitio en http://localhost:3000 (o Live Server: index.html → botón "Go Live")
> npm run build                                  # arma dist/ (lo único que se sube a Hostinger)
> ```

### Roles y permisos

| Acción | `user` | `admin` | `developer` |
|---|:-:|:-:|:-:|
| Ver catálogo, reproducir lo permitido, guardar progreso, comprar | ✅ | ✅ | ✅ |
| Editar clases (título, nivel, miniatura…) | ❌ | ✅ | ✅ |
| Publicar / despublicar clases | ❌ | ✅ | ✅ |
| **Borrar** clases (borra también su video en R2) | ❌ | ✅ | ✅ |
| Productos: crear, editar, activar/ocultar, borrar (con imagen) | ❌ | ✅ | ✅ |
| Ver borradores y clases no publicadas | ❌ | ✅ | ✅ |
| **Subir videos** (clase nueva, reintentar o reemplazar el video) | ❌ | ❌ | ✅ |
| Cambiar el rol de otras personas | ❌ | ❌ | ✅ |
| Leer el historial interno (`audit_log`) | ❌ | ❌ | ✅ |

"Subir" se impide en **tres capas**: la Edge Function `admin-create-upload` exige `developer`, la base solo deja insertar
en `classes` al `developer`, y el panel no muestra las acciones de subida al admin. Cambiar el rol de alguien (solo un
developer): `select public.set_user_role('<id>', 'admin');` — queda auditado.

## Demo pública (GitHub Pages)

`.github/workflows/pages.yml` arma `dist/` (lo mismo que se sube a Hostinger, ver `scripts/build-site.mjs`)
y lo publica solo en cada push a `main`. No hace falta copiar nada a mano: lo que ves en `npm run dev` es lo que
queda publicado (las páginas viven en la raíz del repo, con rutas relativas que también funcionan bajo
`/yogapopup/`).

1. Activarlo una sola vez: **Settings → Pages → Source: "GitHub Actions"**.
2. Después de cada push a `main`, la Action deja la URL en la pestaña **Actions** (o en Settings → Pages):
   `https://lucasalvarez99.github.io/yogapopup/`.

Es una vidriera de **prueba**, no el sitio de producción (ese va a Hostinger con dominio propio, ver
[`docs/PUESTA-EN-MARCHA.md`](docs/PUESTA-EN-MARCHA.md)). Ahí ya funcionan sin tocar nada el login, el catálogo, la tienda y el
panel de productos (van por Supabase Auth/REST, que aceptan cualquier origen). Para **reproducir videos** y para
**crear/borrar clases** desde el panel hay que agregar `https://lucasalvarez99.github.io` a `ALLOWED_ORIGINS` en
`supabase/.env` y correr `npm run sb:secrets` de nuevo (CORS de las Edge Functions); para **subir** un video
también hay que permitir ese origen en la política CORS del bucket de R2.

## Estado del proyecto

Leyenda: ✅ cumplida · 🟡 código listo, falta validarla (con cuentas reales o en el navegador) · ⬜ sin empezar

| Fase | Qué es | Estado |
|---|---|---|
| 0 | Auditoría + modelo de datos + backend de video (R2) | ✅ |
| 1 | Reproductor — estructura y controles básicos | ✅ |
| 2 | Reproductor — reanudar, renovar y errores | ✅ |
| 3 | Progreso — guardado periódico | ✅ |
| 4 | Progreso — interfaz | ✅ |
| 5 | Autenticación — login, registro y sesión | ✅ |
| 6 | Autenticación — páginas protegidas | ✅ |
| 7 | Autenticación — conectar la home | ✅ |
| 8 | Panel administrativo — listado | ✅ |
| 9 | Panel administrativo — alta y edición | ✅ |
| 10 | Panel administrativo — subida de video | ✅ |
| 11 | Panel administrativo — publicar y borrar | ✅ |
| 12 | Tienda — modelo de datos de productos | ✅ |
| 13 | Tienda — página pública | ✅ |
| 14 | Tienda — panel administrativo de productos | ✅ |
| 15 | Carrito — estado y persistencia | ✅ |
| 16 | Carrito — interfaz | ✅ |
| 17 | Pagos — modelo de datos | ⬜ |
| 18 | Checkout — compra puntual con PayPal | ⬜ |
| 19 | Suscripciones con PayPal — alta | ⬜ |
| 20 | Suscripciones con PayPal — baja | ⬜ |
| 21 | Pagos — webhook de PayPal | ⬜ |
| 22 | Pagos — conciliación y errores | ⬜ |
| 23 | Perfil — progreso de videos | ⬜ |
| 24 | Perfil — historial de compras | ⬜ |
| 25 | Perfil — estado de la suscripción | ⬜ |
| 26 | Comentarios — modelo de datos y formulario | ⬜ |
| 27 | Comentarios — moderación | ⬜ |
| 28 | Súper-admin — modelo de datos de la agenda | ⬜ |
| 29 | Súper-admin — vista de agenda | ⬜ |
| 30 | Agenda — inscripción de alumnos | ⬜ |
| 31 | Notificaciones — aviso de clase en vivo | ⬜ |
| 32 | Cuentas reales — infraestructura | ⬜ |
| 33 | Prueba con un solo video real | ⬜ |
| 34 | Prueba con un solo video — progreso, responsive y costo | ⬜ |
| 35 | Escalado — varios videos | ⬜ |
| 36 | Escalado — catálogo completo | ⬜ |
| 37 | Entrega — dominio y correo | ⬜ |
| 38 | Entrega — monitoreo y respaldo | ⬜ |
| 39 | Entrega — recorrido, traspaso y cierre | ⬜ |

Detalle de cada fase, con sus tareas, más abajo en [Fases](#fases).

---

## Arquitectura

```
                 ┌─────────────────────────┐
                 │  Web estática (Hostinger)│   index.html · css/ · js/
                 └────────────┬────────────┘
                              │ HTTPS
                              ▼
                 ┌─────────────────────────┐
                 │ Supabase Edge Functions  │   supabase/functions/
                 │  (TypeScript / Deno)     │
                 └───────┬─────────┬───────┘
                         │         │
             ┌───────────┘         └────────────┐
             ▼                                  ▼
   ┌──────────────────┐               ┌──────────────────┐
   │ Supabase          │               │ Cloudflare R2     │
   │ Auth · Postgres   │               │ Videos (bucket)   │
   │ RLS · progreso    │               │                   │
   └──────────────────┘               └──────────────────┘

   El navegador sube el video DIRECTO a R2 (PUT prefirmado) y lo reproduce con una URL
   firmada que vence. El archivo nunca pasa por Hostinger ni por las funciones.
   R2 no transcodifica: se sirve el archivo tal cual se subió (progresivo, sin HLS
   adaptativo), con soporte de Range requests nativo para buscar/adelantar.
```

## Estructura del repositorio

```
yogapopup/
├── *.html                                Las páginas, tal cual se publican: index, videoteca, clase, cuenta,
│                                         panel, tienda, producto
├── css/ · js/ · assets/                  Estilos, JS y recursos que usan las páginas
│   └── js/config.js                      Config PÚBLICA del frontend (placeholders)
├── supabase/
│   ├── migrations/                       Base de datos: tablas, RLS, permisos (Fase 0)
│   ├── functions/
│   │   ├── _shared/                      Capa R2, auth, repositorio, HTTP (Fase 0)
│   │   ├── _tests/                       47 pruebas automáticas
│   │   ├── admin-create-upload/  admin-sync-video/  admin-delete-class/
│   │   └── playback/  health/
│   ├── .env  ·  .env.example             Secretos del BACKEND (R2)
│   ├── config.toml · promote_role.example.sql · README.md
├── scripts/
│   ├── build-site.mjs                    Arma dist/ (los *.html de la raíz + css/, js/, assets/)
│   └── supabase.mjs                      Atajos del CLI de Supabase
├── serve.json                            Config del servidor local (sin URLs "limpias", sin caché)
├── .env  ·  .env.example                 Variables de las herramientas locales
├── .htaccess                             Bloquea archivos sensibles en Hostinger (viaja dentro de dist/)
└── package.json                          Scripts y herramientas de desarrollo
```

Las páginas están en la **raíz**, exactamente como se publican: el mismo código se ve igual con `npm run dev`
(http://localhost:3000), con Live Server de VS Code (http://127.0.0.1:5500/index.html), con
`npm run preview` (http://localhost:3001, lo que sale de `dist/`) y en GitHub Pages. Reglas para que siga así
(las vigila `tests/web/pages-links.test.js`): dentro de un `.html`, enlaces y recursos **relativos y sin `/`
inicial** (`videoteca.html`, `css/app.css`), nunca `/videoteca.html`.

> Desde `localhost` o Live Server ya funcionan el login, el catálogo, la tienda y el panel de productos. Para
> reproducir videos y crear/borrar clases, agregá esos orígenes (`http://localhost:3000`, `http://127.0.0.1:5500`)
> a `ALLOWED_ORIGINS` en `supabase/.env` y corré `npm run sb:secrets` (solo en desarrollo; en producción, sin `localhost`).


---

## Puesta en marcha

### ¿Dónde se hace `npm install`?

**Una sola vez, en la raíz del proyecto**: la carpeta que contiene `package.json`, `index.html` y `supabase/`.

```bash
cd yogapopup          # la carpeta raíz, junto a package.json
npm install
```

- **No** hay que hacer `npm install` dentro de `supabase/`, `supabase/functions/` ni `js/`.
- Requisito: **Node.js 20 o superior**. El resto (CLI de Supabase, Deno para las pruebas y un servidor local)
  se instala solo con ese comando.
- El sitio en sí **no tiene build ni dependencias de npm**: Bootstrap y las fuentes se cargan por CDN.

### Pasos

1. `npm install` (raíz).
2. Completar `.env` (raíz) y `supabase/.env` (ver [Variables de entorno](#variables-de-entorno)). Ya existen
   con los campos vacíos; **no están en Git**.
3. Ver el sitio en local: `npm run dev` → http://localhost:3000
4. Comprobar que todo el código está sano: `npm run verify`
5. Con las cuentas creadas (ver [Tareas externas](#tareas-externas-pendientes)):
   `npm run sb:login` → `npm run sb:link` → `npm run sb:db-push` → `npm run sb:secrets` → `npm run sb:deploy`.
   Guía completa en [`supabase/README.md`](supabase/README.md).

### Scripts

| Comando | Qué hace |
|---|---|
| `npm run dev` | Sitio en http://localhost:3000 |
| `npm run build` | Arma `dist/` con **solo** los archivos públicos |
| `npm run preview` | Construye y sirve `dist/` en http://localhost:3001 |
| `npm test` | 46 pruebas de las funciones (sin red) |
| `npm run verify` | Formato + lint + tipos + pruebas |
| `npm run sb:login` / `sb:link` | Iniciar sesión / vincular el proyecto Supabase |
| `npm run sb:db-push` | Aplica las migraciones a la base |
| `npm run sb:secrets` | Sube `supabase/.env` como secretos de las funciones |
| `npm run sb:deploy` | Publica las Edge Functions |
| `npm run sb -- <comando>` | Cualquier otro comando del CLI de Supabase |

Los comandos `sb:*` aceptan `--dry-run` para ver qué ejecutarían.

### Publicar el sitio en Hostinger

1. `npm run build`
2. Subir a `public_html` el **contenido** de `dist/` (no la carpeta del proyecto).

`dist/` contiene solo `index.html`, `css/`, `js/`, `assets/` y `.htaccess`: por construcción no puede llevarse
`.env`, `supabase/` ni `scripts/`. Si por error se subiera todo el proyecto, el `.htaccess` sigue bloqueando
esos archivos (comprobado en Apache).

---

## Variables de entorno

Ninguna credencial real está en este repositorio: todos los archivos vienen con campos vacíos o de ejemplo.

| Archivo | ¿Va a Git? | Variable | ¿Secreta? | Para qué / de dónde sale |
|---|---|---|---|---|
| `.env` | No | `SUPABASE_PROJECT_REF` | No | Supabase → Project Settings → General → *Reference ID* |
| `.env` | No | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | **Sí** | Opcionales (CI). Con `npm run sb:login` no hacen falta |
| `supabase/.env` | No | `R2_ACCOUNT_ID` | No | Cloudflare dashboard → R2 → Overview |
| `supabase/.env` | No | `R2_ACCESS_KEY_ID` | **Sí** | R2 → Manage API Tokens (permiso Object Read & Write, solo sobre el bucket de videos) |
| `supabase/.env` | No | `R2_SECRET_ACCESS_KEY` | **Sí** | Ídem. Nunca sale del backend |
| `supabase/.env` | No | `R2_BUCKET` | No | Nombre del bucket (ej. `yogapopup-videos`) |
| `supabase/.env` | No | `ALLOWED_ORIGINS` | No | Dominios que pueden llamar a las funciones (CORS) |
| `supabase/.env` | No | `PLAYBACK_TTL_SECONDS`, `UPLOAD_TTL_SECONDS` | No | Opcionales (por defecto 2 h y 4 h) |
| `js/config.js` | **Sí** | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FUNCTIONS_URL` | **No** (públicas) | Supabase → Project Settings → API |

- `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` dentro de las Edge Functions las inyecta
  Supabase automáticamente: no hay que cargarlas.
- La *anon key* es pública por diseño (la protegen las políticas RLS). **La service role key y las claves de
  R2 jamás van en el frontend ni en `js/config.js`.**
- El proyecto no tenía convención previa de variables (era una maqueta estática), por eso estos nombres son propios.

---

## Seguridad (resumen)

- Ninguna clave privada llega al navegador; viven solo como *secrets* de las Edge Functions.
- RLS activado en todas las tablas y privilegios por columna: la key del objeto en R2 no es legible desde el
  navegador y un usuario no puede volverse admin.
- El acceso a un video se decide en un único lugar (`can_access_class`) y se entrega una URL **firmada (SigV4)
  con vencimiento**: conocer la URL de una clase no permite verla.
- El progreso se guarda por una función de servidor que valida permisos y calcula "completada".
- Sin webhooks: la confirmación de subida la dispara el propio navegador (`admin-sync-video`), que siempre
  comprueba con un HEAD directo a R2 antes de marcar el video como listo — nunca confía en lo que diga el cliente.

## Costos de referencia (USD; verificar en la página oficial de Cloudflare)

Cloudflare R2: primeros 10 GB de almacenamiento gratis por mes, sin cargo por egreso (salida de datos) nunca,
1 millón de operaciones Class A y 10 millones Class B gratis por mes. Pasado eso: ~0,015 USD/GB/mes de storage,
sin costo de tráfico.
Supuesto: 40 clases de ~45 min ≈ 80 GB (**a validar en la Fase 34**); al no cobrar egreso, el costo de R2 casi no
depende de cuánto se reproduzcan las clases (a diferencia de un proveedor con CDN por tráfico).

| Almacenamiento | R2 aprox./mes |
|---|---|
| 80 GB (40 clases) | ~1 USD (10 GB gratis + 70 GB pagos) |
| 200 GB | ~3 USD |

Supabase (plan gratuito): alcanza para empezar; los proyectos se pausan tras 1 semana sin actividad (por eso el
ping de UptimeRobot a `/functions/v1/health` cada 5 min) y **no incluye copias de seguridad**.

---

## Fases

> Hoja de ruta puesta al día el 27/09/2026. La **Fase 0** es una foto de "hasta acá se llegó" (no queda
> nada pendiente adentro, salvo lo que depende de cuentas del cliente). A partir de ahí las fases son
> chicas a propósito (una tarde de trabajo cada una, más o menos) para poder cerrar y marcar "cumplida"
> seguido, en vez de tener fases enormes que quedan a medio camino por muchas sesiones. Las Fases 0-16
> están cumplidas y probadas. Las Fases 12-31 son tienda, pagos (**todo con PayPal**, tanto compras
> puntuales como suscripciones — se decidió no sumar un segundo proveedor), perfil de usuario, comentarios
> y la agenda de clases en vivo. De ahí en más son cuentas reales, escalado y entrega. La última
> (**Fase 39**) es el día de entrega.

### Fase 0 · Estado actual — auditoría + modelo de datos + backend de video

- [x] Auditoría inicial: estructura del proyecto, arquitectura propuesta, decisiones con el cliente
      (reproductor propio, Supabase Edge Functions como backend, UptimeRobot, precios en euros)
- [x] Modelo de datos: tablas `classes`, `video_progress`, `profiles`, `entitlements`; RLS y privilegios
      por columna; `can_access_class()` y `save_progress()`; migración probada en PostgreSQL local
- [x] Backend de video sobre **Cloudflare R2**: capa `_shared/r2/` (SigV4 vía `aws4fetch`), subida por PUT
      prefirmado directo desde el navegador, confirmación sin webhooks (`admin-sync-video` hace HEAD
      directo al bucket), borrado seguro (si R2 falla no se borra la clase), URLs de reproducción firmadas
      con vencimiento
- [x] Migración de Bunny a R2 (`20260924120000`) + limpieza de datos (`20260930120000`): si la base ya tenía clases
      con un video de Bunny, quedan despublicadas y en `pending` (con sus metadatos) para volver a subir el video
      desde el panel; las que ya tienen key de R2 no se tocan. Probada en `supabase/tests/legacy_bunny.test.sql`
      (base temporal aparte, verificada rompiendo la migración a propósito)
- [x] `playback` entrega la URL firmada + punto donde retomar; nunca revela si una clase existe a quien
      no tiene acceso
- [x] 47 pruebas automáticas (firmas, permisos, flujos y casos de error, sin red) + tipos y lint limpios:
      `npm run verify` en verde
- [x] Precios de referencia verificados: R2 (gratis hasta 10 GB, sin costo de egreso) y límites del plan
      gratuito de Supabase

- [x] **FASE 0 CUMPLIDA** — el código del backend está completo y probado con simulaciones. Lo único que
      falta para darla por *cerrada en producción* son las cuentas reales del cliente, listadas abajo en
      **Tareas externas pendientes**; se valida con el primer video real en la Fase 33.

### Fase 1 · Reproductor — estructura y controles básicos

- [x] Componente `VideoPlayer` reutilizable sobre `<video>` (reproducción progresiva desde R2) con el
      diseño de YogaPop Up (`js/components/video-player.js`, estilos en `css/app.css`)
- [x] Play/Pause · barra de progreso (click y arrastre) · volumen (slider + silenciar) · pantalla completa
      · duración
- [x] Estados de carga y vacío: spinner mientras carga, botón grande de reproducir antes de empezar,
      página con su propio estado de carga/sin sesión/sin acceso/video no listo/error (`js/pages/clase.js`)
- [x] Cubierto por E2E en Chromium real: duración mostrada, volumen (slider real, no solo la UI), silenciar,
      buscar arrastrando la barra, velocidad, teclado, selector de calidad oculto (R2 no transcodifica)

- [x] **FASE 1 CUMPLIDA** — ya estaba construido de una sesión anterior; esta vuelta se revisó entero,
      se le sumaron las pruebas E2E que le faltaban (duración, volumen, buscar con la barra) y se confirmó
      que sigue funcionando después de la migración a R2.

### Fase 2 · Reproductor — reanudar, renovar y errores

- [x] Continuar desde el último punto guardado (`resume_seconds` de `playback`), con opción "Empezar de cero"
- [x] Renovar la URL firmada sola si vence durante la reproducción: preventivo (antes de que ocurra) y
      reactivo (ante un 401/403), sin cortar la reproducción
- [x] Estado de error con reintento (video no listo, servicio caído, URL que no logra renovarse tras 2 intentos)
- [x] Cubierto por E2E en Chromium real: URL vencida al cargar, renovación preventiva a mitad de reproducción,
      y el caso límite de que la renovación también falle (error visible + reintento que se recupera)

- [x] **FASE 2 CUMPLIDA** — ídem Fase 1: ya estaba hecho, se revisó y quedó confirmado con las pruebas
      existentes (que también se migraron de Bunny/HLS a R2/progresivo).

### Fase 3 · Progreso — guardado periódico

- [x] Función SQL `save_progress()` y tabla `video_progress` (hechas en la Fase 0)
- [x] `ProgressReporter` (`js/lib/progress-reporter.js`): guarda cada `PROGRESS_INTERVAL_SECONDS` de
      reproducción efectiva, no una petición por segundo
- [x] Guarda también al pausar, al terminar, y al ocultar/cerrar la pestaña (`fetch` con `keepalive`,
      sobrevive al cierre) — wireado en `js/pages/clase.js` (`visibilitychange` + `pagehide`)
- [x] No satura al buscar en la barra (mínimo entre guardados); nunca dos peticiones en paralelo
      (coalesce a la última posición); si falla, avisa y reintenta en el siguiente ciclo
- [x] 11 pruebas unitarias (`tests/web/progress-reporter.test.js`) + 5 pruebas E2E en Chromium real
      (guardado periódico, `keepalive` al cambiar de página, "Vista" al terminar)

- [x] **FASE 3 CUMPLIDA** — ídem Fases 1 y 2: ya estaba construido de una sesión anterior; esta vuelta
      se revisó entero (lógica de guardado, wireado en la página, y las dos baterías de pruebas) y se
      confirmó que sigue funcionando.

### Fase 4 · Progreso — interfaz

- [x] Porcentaje de avance en la tarjeta de cada clase (`js/components/class-card.js`, barra `.video-progress`)
- [x] Etiqueta "Continuar · 27:43" en la tarjeta de una clase empezada
- [x] Sección "Continuar viendo" en la videoteca (`js/pages/videoteca.js`) con las clases empezadas y no
      terminadas

- [x] **FASE 4 CUMPLIDA** — también ya estaba hecho; se verificó junto con la Fase 3 por estar en los
      mismos archivos.

### Fase 5 · Autenticación — login, registro y sesión

- [x] Autorización en el servidor: `can_access_class()` + `playback` (hechas en la Fase 0)
- [x] Login / registro / cierre de sesión con Supabase Auth (`js/lib/session.js`, `js/ui/auth-modal.js`):
      formulario con pestañas, confirmación de correo, mensajes de error traducidos
- [x] Ícono "Mi cuenta" (`js/ui/account-menu.js`): sin sesión abre el modal, con sesión muestra nombre/correo,
      enlace a Videoteca y a Panel de negocio (si es admin), y cerrar sesión
- [x] Recuperar y cambiar contraseña: pantalla "Olvidaste tu contraseña", el enlace del correo abre
      directo el formulario de contraseña nueva (`PASSWORD_RECOVERY`), y cambiarla ya con sesión iniciada
      desde `cuenta.html`. El envío real del correo depende del SMTP propio (Fase 37); el flujo ya está
      completo del lado de la web.

- [x] **FASE 5 CUMPLIDA** — ídem Fases 1-4: ya estaba construido de una sesión anterior; se revisó entero
      y se confirmó con las pruebas E2E existentes (registro, sesión persistente, recuperación de
      contraseña de punta a punta, editar nombre/contraseña).

### Fase 6 · Autenticación — páginas protegidas

- [x] `clase.html`, `cuenta.html` y `panel.html` protegidas: sin sesión, cada página muestra su propio
      mensaje con un botón para iniciar sesión (no hace falta redirigir a otra URL)
- [x] Al iniciar sesión desde el gate de `clase.html` se retoma esa misma clase al toque
      (`session.onChange` vuelve a correr `start()`), sin perder el lugar
- [x] Mensaje claro por cada caso: clase restringida sin acceso (`no_access`), video no listo, clase
      inexistente, sesión vencida — cada uno con su acción (ver otras clases, reintentar, iniciar sesión)
- [x] El catálogo (`videoteca.html`) es público a propósito: se puede explorar sin sesión, y solo se pide
      iniciar sesión al entrar a una clase puntual

- [x] **FASE 6 CUMPLIDA** — también ya estaba hecho.

### Fase 7 · Autenticación — conectar la home

- [x] Estructura extensible a gratuito / premium / curso / suscripción (`entitlements`, hecha en la Fase 0)
- [x] La home (`js/pages/home.js`) carga las últimas 3 clases publicadas de verdad (no tarjetas de ejemplo),
      con su estado vacío/error
- [x] Filtros de la videoteca por texto, nivel y categoría (`js/pages/videoteca.js`)

- [x] **FASE 7 CUMPLIDA** — también ya estaba hecho.

### Fase 8 · Panel administrativo — listado

- [x] Listado de clases: título/categoría, nivel, estado del video, publicada/sin publicar, fecha y acciones
- [x] Acceso solo para admin y developer (rol `admin` o `developer`, `session.isStaff()`)
- [x] Filtros básicos: Todas / Publicadas / Borradores / Con error (nuevo esta vuelta)

- [x] **FASE 8 CUMPLIDA** — el listado, el acceso por rol y la subida (Fase 10) ya estaban hechos de una
      sesión anterior; lo único que faltaba de verdad eran los filtros, que se agregaron ahora.

### Fase 9 · Panel administrativo — alta y edición

- [x] Formulario: título, descripción, categoría, nivel, acceso (gratis/restringido), orden
- [x] Miniatura: subida de imagen a Supabase Storage (se reduce en el navegador antes de subir)
- [x] Editar una clase existente sin tocar el video (`openClassForm({ mode: 'edit' })`, nuevo esta vuelta):
      cambia título/descripción/categoría/nivel/acceso/orden y puede reemplazar la miniatura (borra la
      vieja recién después de confirmar que la nueva se guardó)

- [x] **FASE 9 CUMPLIDA** (E2E de crear y editar, ver la nota de las Fases 9-11) — el alta ya estaba hecha; el hueco real era editar una clase ya creada (el
      propio código lo admitía: "pendiente para más adelante"), que era justo lo que faltaba de esta fase.

### Fase 10 · Panel administrativo — subida de video

- [x] Subida del video con barra de progreso (PUT directo a R2)
- [x] Confirmación automática al terminar (`admin-sync-video` + duración calculada en el navegador)
- [x] Reintentar una subida que quedó pendiente o con error (mismo formulario, modo `retry`)

- [x] **FASE 10 CUMPLIDA** (E2E de la subida y del reintento, ver la nota de las Fases 9-11) — ya estaba hecho de una sesión anterior.

### Fase 11 · Panel administrativo — publicar y borrar

- [x] Publicar / despublicar (deshabilitado si el video no está listo; la base además lo impide con un CHECK)
- [x] Eliminar clase (`admin-delete-class` borra el objeto en R2 primero; si falla, no borra nada)
- [x] Confirmación (`confirm()`) antes de eliminar

- [x] **FASE 11 CUMPLIDA** (E2E de publicar, despublicar y borrar, ver la nota de las Fases 9-11) — ya estaba hecho de una sesión anterior.

> **Cierre de este bloque (9-11) — 30/09/2026:** el backend de pruebas (`tests/e2e/fake-backend.mjs`) ahora implementa
> `admin-create-upload`, `admin-sync-video` y `admin-delete-class` con el mismo contrato que las funciones reales, el
> `PATCH` de `classes` con su CHECK ("publicada ⇒ video listo") y el `PUT` prefirmado a R2. Con eso hay 4 pruebas E2E en
> Chromium real: (1) crear una clase con un video mp4 real, que llega a R2 por PUT directo con la duración leída en
> el navegador, queda lista **sin publicar**, se publica (aparece en la videoteca), se edita sin tocar el video, se
> despublica (desaparece) y se borra junto con su video; (2) si la subida falla se avisa y el reintento **reanuda la
> misma clase** con la misma key de R2; (3) cerrar el formulario tras un fallo deja la clase "Pendiente" visible y sin
> poder publicarse, y "Subir video" la completa; (4) un usuario común no puede usar ninguna función de administración
> ni escribir en `classes`. Verificadas deshaciendo cada arreglo y cada comportamiento a propósito: en los tres casos
> falla la prueba que corresponde.
>
> **Dos errores reales que encontró este trabajo, ya corregidos en `js/ui/class-form-modal.js`:** (a) si la subida
> fallaba después de crear la clase y se volvía a apretar el botón, se creaba **otra clase** (duplicada y sin
> video) en vez de reanudar la primera; (b) si se cerraba el formulario tras ese fallo, el panel **no refrescaba la
> lista** y la clase recién creada quedaba invisible hasta recargar.
>
> **Lo que sigue sin probarse (y no se puede sin tus cuentas):** que el PUT llegue de verdad a tu bucket de Cloudflare
> R2. Falta crear el bucket, el token y desplegar las Edge Functions; la primera prueba con un video real es la
> Fase 33. Hasta entonces, `supabase/functions/_tests/` prueba esos tres endpoints a fondo (47 pruebas, sin red).

### Fase 12 · Tienda — modelo de datos de productos

- [x] Tabla `products` (`supabase/migrations/20260927120000_products.sql`): título, descripción, imagen,
      precio en **céntimos de euro** (entero, nunca float), stock opcional (`null` = sin control de
      stock), orden, activo/inactivo
- [x] RLS: cualquiera (incluso sin sesión) lee los productos activos; solo admin/developer
      ve los inactivos y crea/edita/borra (`is_staff()`, mismo criterio que `classes`)
- [x] `price_cents >= 0` y `stock >= 0` garantizados por CHECK en la base
- [x] 4 bloques de pruebas SQL (`supabase/tests/products.test.sql`, enganchado en `npm run test:db`):
      visibilidad anon/usuario/admin, permisos de escritura, precio no negativo, `updated_at`.
      Verificado rompiendo la política a propósito (el test falla como debe).
- Fuera de esta fase, a propósito: el bucket de imágenes de producto (Fase 14) y el proveedor de pago
  (Fase 17+): el catálogo no sabe nada de cómo se cobra.

- [x] **FASE 12 CUMPLIDA**

### Fase 13 · Tienda — página pública

- [x] `pages/tienda.html`: grilla de productos activos (`js/pages/tienda.js`), buscador (sin distinguir
      acentos/mayúsculas, mismo criterio que la videoteca) y filtro por categoría
- [x] `producto.html?id=<uuid>`: ficha individual (imagen, descripción, precio, stock) +
      "también te puede gustar"; producto inexistente o inactivo da el mismo estado "no encontrado"
      (no revela que existe, mismo criterio que `clase.html`)
- [x] `js/components/product-card.js`, reusable entre la tienda y la ficha de producto
- [x] Precio en céntimos de euro formateado en español (`formatPrice`) y disponibilidad según stock
      (`stockInfo`: `null` = sin control de stock, `0` = agotado, `≤5` = "Últimas N unidades")
- [x] El botón "agregar al carrito" existe pero está deshabilitado ("Próximamente"): el carrito es la
      Fase 15-16, así que por ahora no simula una compra que no existe
- [x] La sección "Merchandising" de la home y su navegación ya apuntaban a un ancla `#tienda` sin
      página real; ahora enlazan a `tienda.html`
- [x] 6 pruebas unitarias (`tests/web/tienda.test.js`) para `formatPrice`/`stockInfo`/`filterProducts`/
      `categoriesOf` — encontraron y corrigieron un bug real: buscar la palabra "null" en la tienda
      devolvía productos sin descripción (el `null` de JavaScript se colaba en el texto de búsqueda);
      el mismo defecto existía en la videoteca y se corrigió ahí también
- [x] 2 pruebas E2E nuevas (catálogo con buscador/filtro/agotado, y ficha de producto) — no las pude
      ejecutar en este entorno (sin Chrome disponible, ver la nota de siempre), quedan para correrlas
      del lado del cliente junto con el resto de `test:e2e`

- [x] **FASE 13 CUMPLIDA**

### Fase 14 · Tienda — panel administrativo de productos

- [x] Alta / edición / borrado de productos desde el panel, mismo patrón de roles que `classes`: pestaña
      "Productos" en `panel.html` (`js/ui/products-admin.js` + `js/ui/product-form-modal.js`), con filtros
      (todos / visibles / ocultos / agotados), publicar/ocultar y confirmación antes de borrar. La base sigue
      decidiendo el permiso (RLS de la Fase 12); la interfaz solo ordena
- [x] Subida de imagen del producto (reutiliza `resizeImage`; bucket `product-images` público con tope de 2 MB y
      solo JPG/PNG/WebP, migración `20260929120000`; escribir, reemplazar y borrar: solo admin/developer).
      La imagen vieja se borra recién con el cambio ya guardado, y si el guardado falla se borra la nueva
      (no quedan huérfanas), y solo si la URL es de nuestro bucket (`storagePathFromPublicUrl`)
- [x] Precio ingresado en euros y guardado en **céntimos** con aritmética de enteros (`js/lib/product-form.js`):
      rechaza separadores de miles, más de 2 decimales, negativos y valores fuera de rango
- [x] 10 pruebas unitarias (`tests/web/product-form.test.js`) — encontraron un bug real: un precio ausente (`null`)
      se rellenaba como `0` (`Number(null) === 0`), o sea "gratis"
- [x] Pruebas de base de datos del bucket (`supabase/tests/products.test.sql`, sección 6): configuración del bucket,
      usuario común y anon rechazados al subir/renombrar/borrar, admin permitido. Verificadas rompiendo la
      política de subida a propósito (la prueba falla) y restaurándola (pasa)
- [x] **E2E en navegador** (`tests/e2e/run.mjs`, backend simulado ampliado con lectura por rol, escrituras de `products`
      con sus CHECK y un Storage simulado): sin sesión y usuario común → no ven el panel; el admin ve todo (borradores
      incluidos); precio inválido → mensaje y nada se escribe; crear con imagen (12,5 € → 1250 céntimos, nace oculto,
      imagen en `product-images/<id>/…`); oculto no aparece en la tienda, publicado sí; editar (precio rellenado en euros);
      borrar (borra también la imagen); un usuario común recibe 403 al escribir productos o subir imágenes
- [x] **Validada contra el Supabase real (30/09/2026):** migraciones aplicadas con `npm run sb:db-push` y recorrido
      a mano hecho con la cuenta `developer` (crear un producto con imagen, ocultarlo, publicarlo, editarlo y
      borrarlo): todo se guarda en la base y se puede modificar sin errores

- [x] **FASE 14 CUMPLIDA**

### Fase 15 · Carrito — estado y persistencia

- [x] Estado del carrito en el navegador (`localStorage`; no hace falta sesión para armarlo) — `js/lib/cart.js`,
      lógica pura que recibe el almacenamiento por parámetro. Guarda **solo `{id, qty}`** por línea, nunca precios ni
      títulos: lo guardado en el navegador no es de fiar, así que precio y stock se leen siempre de la base. Lo que
      haya en `localStorage` se lee como dato no confiable (`parseCart`): JSON roto, versión desconocida, ids o
      cantidades inválidas, duplicados y campos extra (un `price_cents` inyectado) se descartan sin lanzar. Topes:
      10 unidades por producto (o el stock, si es menor) y 30 productos distintos. Si `localStorage` no está
      disponible (modo privado, cookies bloqueadas) o la cuota se llena, el carrito sigue en memoria y
      `store.persistent` pasa a `false` para que la interfaz pueda avisarlo. Se entera de cambios hechos desde
      otra pestaña (evento `storage`)
- [x] Validar stock/disponibilidad antes de ir a pagar — `validateCart(cart, productosActivos)` compara contra los
      productos que devuelve la base (`listActiveProducts()`): cada línea queda `ok`, `reduced` (pedías más de lo
      que hay), `soldout` o `unavailable` (oculto/borrado), calcula el subtotal en céntimos enteros y devuelve un
      `fixedCart` ya corregido. Un precio ausente o inválido en la base cuenta como no disponible, **nunca como
      gratis**. Es una ayuda para la interfaz: la autoridad es el servidor, que en la Fase 18 vuelve a validar
      precio y stock antes de crear la orden
- [x] 32 pruebas unitarias (`tests/web/cart.test.js`) — encontraron un bug real mientras se escribían: un precio
      `null` en la base se contaba como 0 (`Number(null) === 0`), o sea "gratis". Verificadas rompiendo el código a
      propósito en cuatro puntos (conservar campos inyectados, ignorar el stock, no persistir, `Number(null)`): en
      los cuatro la prueba falla, y con el código original pasan
- [x] Persistencia en un navegador real: verificada en la Fase 16 (E2E) — el carrito sobrevive a recargar la página,
      a cambiar de página y se sincroniza entre dos pestañas. En la Fase 15 estaba cubierta solo con un
      almacenamiento falso de la misma interfaz que `localStorage` y con `browserStorage()` probado ante los
      fallos típicos (acceso denegado, cuota llena, sin `localStorage`)

- [x] **FASE 15 CUMPLIDA**

### Fase 16 · Carrito — interfaz

- [x] Ícono del carrito en el encabezado con el conteo de ítems — en todas las páginas (`js/ui/layout.js` para las
      nuevas, el encabezado de `index.html` para la home). El conteo sale del carrito guardado en el navegador, no de
      la base; se oculta con 0 y muestra "99+" si son muchos
- [x] Agregar / quitar / cambiar cantidad, resumen con subtotal — cajón lateral (`js/ui/cart-drawer.js`). Los botones
      "Agregar al carrito" de la tienda, la ficha y la home son reales; el "+" se bloquea al llegar al stock (o a
      10 unidades), el "−" se bloquea en 1 (para sacar un producto está la X) y hay "Vaciar carrito". Cada vez que se
      abre el cajón se vuelven a leer precio y stock de la base: si el stock bajó o un producto se ocultó, lo avisa
      por línea, el subtotal solo cuenta lo que realmente se puede comprar y "Actualizar carrito" lo corrige. Si la
      base falla, muestra el error con reintento y **ningún precio**. "Finalizar compra" queda deshabilitado hasta
      el pago (Fases 17-18)
- [x] Se quitó el carrito de ejemplo de la home (3 productos fijos y su JavaScript) y las 8 tarjetas de producto de
      ejemplo: ahora la home muestra los primeros productos activos reales, con el mismo patrón de carga/vacío/error
      que las clases. `js/lib/cart-view.js` concentra las reglas de presentación (textos de aviso, tope del "+",
      mensajes al agregar) para probarlas sin navegador: 5 pruebas unitarias
- [x] 8 pruebas E2E en Chromium real (`carrito: …` y `home: productos reales…`): agregar con tope de stock y
      persistencia al recargar y entre páginas, sin sesión; cajón con cantidades, subtotal, quitar y vaciar; precio
      manipulado en `localStorage` (el cajón usa el de la base) y contenido corrupto; stock que baja / producto
      oculto con corrección; error de la base con reintento; datos que cambian entre dos aperturas; home con
      productos reales; y dos pestañas sincronizadas (evento `storage` real). Verificadas rompiendo el código a
      propósito en cuatro puntos (ignorar el stock, no bloquear el "+", sin sincronía entre pestañas, no releer la
      base al reabrir): en los cuatro falla la prueba que corresponde. La cuarta rotura, al principio, pasaba sin
      que fallara nada: faltaba una prueba y se agregó
- [x] Regresión corregida de una entrega anterior: al quitar el código muerto de HLS del reproductor (post-migración
      a R2) se rompió el E2E `reproductor: controles…`, que buscaba el selector de calidad por posición. Se corrigió
      el test (ahora comprueba que no existe selector de calidad) y la suite completa volvió a 40 de 40

- [x] **FASE 16 CUMPLIDA**

### Fase 17 · Pagos — modelo de datos

- [ ] Tablas `orders` / `order_items`: compras puntuales (tienda y clases sueltas), todas por **PayPal**
- [ ] `entitlements` (ya existe desde la Fase 0) para la suscripción: `scope='all', source='paypal'`
- [ ] RLS: el usuario ve solo lo suyo; solo el backend escribe

- [ ] **FASE 17 CUMPLIDA**

### Fase 18 · Checkout — compra puntual con PayPal

- [ ] Botón de PayPal (PayPal Checkout SDK) en el checkout de la tienda y al comprar una clase suelta
- [ ] Edge Function que crea la orden y la verifica contra la API de PayPal antes de confirmarla —
      nunca se confía en lo que dice el navegador, mismo criterio que ya se usa con R2

- [ ] **FASE 18 CUMPLIDA**

### Fase 19 · Suscripciones con PayPal — alta

- [ ] Plan de suscripción creado en PayPal (PayPal Subscriptions / Billing Plans)
- [ ] Botón "Suscribirme" en la web con el mismo SDK de PayPal (no hace falta una segunda pasarela)
- [ ] Al confirmarse, se crea el `entitlements` correspondiente y el usuario pasa a tener acceso premium

- [ ] **FASE 19 CUMPLIDA**

### Fase 20 · Suscripciones con PayPal — baja

- [ ] Cancelar la suscripción desde `cuenta.html` (llama a la API de PayPal, no solo borra en la base)
- [ ] Que el acceso premium se corte cuando vence, no al cancelar (ya pagó ese período)

- [ ] **FASE 20 CUMPLIDA**

### Fase 21 · Pagos — webhook de PayPal

- [ ] `paypal-webhook`: firma verificada (PayPal Webhook Signature Verification API), nunca se procesa
      un evento sin verificar
- [ ] Idempotente: un mismo evento reenviado dos veces no duplica la orden ni el `entitlement`
- [ ] Cubre tanto compras puntuales como eventos de suscripción (activada, cancelada, pago fallido)

- [ ] **FASE 21 CUMPLIDA**

### Fase 22 · Pagos — conciliación y errores

- [ ] Qué pasa si el webhook no llega: PayPal reintenta solo, y además un botón "verificar de nuevo"
      en el panel para forzar la conciliación a mano
- [ ] Probado contra el sandbox de PayPal (compra y suscripción) antes de ir a producción

- [ ] **FASE 22 CUMPLIDA**

### Fase 23 · Perfil — progreso de videos

- [ ] Sección "Mi progreso" en `cuenta.html`: agrupa `video_progress` (ya se guarda desde la Fase 3)
      en clases completadas y en progreso, con acceso directo a "continuar"

- [ ] **FASE 23 CUMPLIDA**

### Fase 24 · Perfil — historial de compras

- [ ] Listado de `orders` del usuario (tienda y clases sueltas), con su estado

- [ ] **FASE 24 CUMPLIDA**

### Fase 25 · Perfil — estado de la suscripción

- [ ] Plan activo, próximo cobro y botón para cancelar (llama a la Fase 20)

- [ ] **FASE 25 CUMPLIDA**

### Fase 26 · Comentarios — modelo de datos y formulario

- [ ] Tabla `testimonials` (usuario, texto, fecha, visible/oculto); RLS: cualquiera lee los visibles,
      solo el dueño del comentario o el admin lo edita/borra
- [ ] Formulario para dejar un comentario en la página de "Sobre nosotros" (requiere sesión)

- [ ] **FASE 26 CUMPLIDA**

### Fase 27 · Comentarios — moderación

- [ ] El comentario no se muestra en público hasta que el panel lo aprueba
- [ ] Aprobar / ocultar / borrar un comentario desde el panel

- [ ] **FASE 27 CUMPLIDA**

### Fase 28 · Súper-admin — modelo de datos de la agenda

- [ ] Tablas `live_sessions` (fecha, hora, cupo, presencial/virtual) y `live_bookings` (quién se anotó a cuál)
- [ ] La agenda es del rol `admin`/`developer` que ya existe (Fase 0); no hace falta un rol nuevo

- [ ] **FASE 28 CUMPLIDA**

### Fase 29 · Súper-admin — vista de agenda

- [ ] Vista por día: cuántos alumnos anotados, en qué horario, presencial o virtual
- [ ] Alta rápida de una clase en vivo desde el panel (fecha, hora, cupo)

- [ ] **FASE 29 CUMPLIDA**

### Fase 30 · Agenda — inscripción de alumnos

- [ ] El alumno se anota a una clase en vivo desde su cuenta, respetando el cupo
- [ ] "Mis próximas clases" en el perfil del usuario

- [ ] **FASE 30 CUMPLIDA**

### Fase 31 · Notificaciones — aviso de clase en vivo el mismo día

- [ ] Tarea programada (Supabase cron) que revisa `live_bookings` del día y avisa por correo a cada
      alumno anotado esa jornada (no hay app propia con notificaciones push)
- [ ] Depende del SMTP propio (misma cuenta que la recuperación de contraseña, ver Fase 37)

- [ ] **FASE 31 CUMPLIDA**

### Fase 32 · Cuentas reales — infraestructura

- [ ] Crear el proyecto en Supabase y aplicar la migración (`npm run sb:db-push`)
- [ ] Crear el bucket en Cloudflare R2 y el token de API (permiso Object Read & Write, ver Fase 0)
- [ ] Cargar los secretos del backend (`npm run sb:secrets`) y correr `npm run doctor:online`

- [ ] **FASE 32 CUMPLIDA**

### Fase 33 · Prueba con un solo video real

- [ ] Upload a R2 real · confirmación de subida (`admin-sync-video`) · asociación con Supabase
- [ ] Reproducción · autenticación · seguridad (probar que una URL suelta no sirve)
- [ ] `npm run test:integration` en verde contra las cuentas reales

- [ ] **FASE 33 CUMPLIDA**

### Fase 34 · Prueba con un solo video — progreso, responsive y costo

- [ ] Progreso y "continuar" con el video real
- [ ] Responsive: escritorio y móvil (Chrome, Safari iOS)
- [ ] Validar el costo real de almacenamiento y ajustar la estimación de la Fase 0

- [ ] **FASE 34 CUMPLIDA**

### Fase 35 · Escalado — varios videos

- [ ] 1 → 3 → 10 videos, cargados desde el panel sin tocar código
- [ ] Revisar tiempos de subida y de listado con más contenido

- [ ] **FASE 35 CUMPLIDA**

### Fase 36 · Escalado — catálogo completo

- [ ] Cargar el catálogo completo (~40 videos)
- [ ] Revisar costos con uso real (almacenamiento en R2, base de Supabase)

- [ ] **FASE 36 CUMPLIDA**

### Fase 37 · Entrega — dominio y correo

- [ ] Dominio propio conectado y `ALLOWED_ORIGINS` con el dominio final (sin `localhost` ni comodines)
- [ ] SMTP propio configurado para la recuperación de contraseña y las notificaciones de agenda
      (Fase 31) + SPF/DKIM/DMARC

- [ ] **FASE 37 CUMPLIDA**

### Fase 38 · Entrega — monitoreo y respaldo

- [ ] Monitor de UptimeRobot activo y probado (que el proyecto gratuito de Supabase no se pause)
- [ ] Copia de seguridad manual de la base antes de abrir el registro al público (el plan gratuito no la incluye)

- [ ] **FASE 38 CUMPLIDA**

### Fase 39 · Entrega — recorrido, traspaso y cierre (día de entrega del proyecto)

- [ ] Recorrido completo con el cliente: subir un video, publicarlo, verlo como usuario, comprar en la
      tienda, suscribirse, anotarse a una clase en vivo y recibir el aviso
- [ ] Traspaso de accesos: quién queda con las claves de Supabase, Cloudflare, PayPal y Hostinger
- [ ] Documentación de puesta en marcha entregada y revisada (`docs/PUESTA-EN-MARCHA.md`)
- [ ] Todas las fases anteriores cumplidas, última pasada de `npm run verify` + `npm run test:e2e` en
      verde, y firma de conformidad del cliente

- [ ] **FASE 39 CUMPLIDA — PROYECTO ENTREGADO**

---

## Tareas externas pendientes

Dependen de las cuentas del cliente (yo no tengo acceso a ellas); bloquean el cierre de cada fase que las
usa:

- [ ] Crear el proyecto en **Supabase** y aplicar la migración
- [ ] Crear el **bucket en Cloudflare R2** y el token de API con permiso de Object Read & Write
- [ ] Cuenta de **PayPal Business** — necesaria para la Fase 18 en adelante (compras y suscripciones,
      todo con el mismo proveedor)
- [ ] Acceso a **Hostinger** (FTP o Git) para publicar `dist/`
- [ ] Crear el monitor de **UptimeRobot** hacia `/functions/v1/health`
- [ ] Confirmar con el cliente los **precios reales** y los textos para España
- [ ] Definir el **dominio** (para `ALLOWED_ORIGINS`)

## Hallazgos de la revisión

**Corregidos**

- La migración inicial (hoy Fase 0) había desaparecido del repositorio (un commit la borró por cómo se empaquetó una entrega
  anterior). Restaurada; este proyecto completo la incluye.
- Un servidor estático sirve `/.env` por defecto: si se subiera la carpeta entera a Hostinger quedaría descargable.
  Ahora se publica solo `dist/` y el `.htaccess` bloquea archivos sensibles (probado en Apache).

**A tener en cuenta (no modifiqué el diseño ni la web existente)**

- Regla para el frontend: con `classes` **no usar `select('*')`** (la key de R2 está restringida);
  listar las columnas explícitamente.
- La web usa imágenes de Unsplash enlazadas directamente y Bootstrap/fuentes por CDN sin SRI: conviene alojarlas o
  fijarlas antes de producción.
- 16 enlaces `href="#"` y el ícono de cuenta sin acción (se resuelven en las Fases 6 y 7); la navegación no tiene
  enlace a "Videoteca".
- Los textos usan voseo argentino y "Envíos a todo el país": revisar para España.
- Límite de frecuencia por usuario en las 4 funciones con sesión (ver `docs/BLINDAJE-FASES-0-16.md`); los topes
  (60/min reproducción y confirmación, 20/min subir y borrar) se ajustan en `supabase/functions/_shared/rate-limit.ts`.
- Aún no verificado con servicios reales: CORS del bucket de R2 y los adaptadores de Supabase.
