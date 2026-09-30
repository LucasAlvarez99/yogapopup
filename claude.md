# CLAUDE.md · YogaPop Up

Instrucciones permanentes para trabajar en este repositorio. Léelas antes de tocar código.
La hoja de ruta por fases (0-39) está en el [`README.md`](README.md#fases).

## 1. Qué es esto

YogaPop Up pasa de **prueba técnica a producto real** (MVP comercial). Un sitio de yoga con videoteca protegida,
cursos, suscripciones y tienda física.

| Capa | Tecnología |
|---|---|
| Frontend | HTML + CSS + JavaScript estático (ES modules, sin build ni framework), Bootstrap 5.3.3 |
| Backend | Supabase Edge Functions, TypeScript sobre Deno |
| Datos | Supabase Postgres con RLS + Supabase Auth + Storage |
| Vídeo | Cloudflare R2: PUT prefirmado directo desde el navegador, reproducción progresiva con URL firmada (SigV4) |
| Pagos (por construir) | Todo con **PayPal** (compras puntuales y suscripciones) y Stripe o Shopify para la tienda física si hiciera falta, detrás de adaptadores |

**No se reescribe lo que ya funciona.** Ya existen y se conservan: autenticación y permisos en servidor, RLS,
progreso (`save_progress`), firmas R2 (SigV4 vía `aws4fetch`), confirmación de subida sin webhooks (HEAD directo
al bucket en `admin-sync-video`) y pruebas.

## 2. Tres niveles de acceso (deben estar siempre separados)

| Nivel | Superficie | Puede | No puede |
|---|---|---|---|
| **Usuario final** | Sitio público (`index.html`, `videoteca.html`, `clase.html`, cuenta) | Ver catálogo, reproducir lo que tenga permitido, guardar su progreso, editar su perfil, comprar | Ver o llamar nada de administración |
| **Propietario** (`owner`) | Panel de negocio (`/panel`), fuera de la app de usuarios | Clases, publicación, catálogo, usuarios, entitlements, pedidos, métricas | Recibir secretos, service role, claves de R2 o acceso directo a Supabase/R2/infra |
| **Desarrollador** (`developer`) | Panel técnico interno (`/interno`), separado del de negocio | Diagnóstico, reconciliación, configuración, mantenimiento | — (todo queda auditado) |

- La autorización se valida **siempre en el servidor** (RLS + Edge Functions). Ocultar un botón nunca es un control.
- Cada superficie tiene su propia entrada, sus propias funciones y sus propias pruebas de "acceso denegado".
- Todo cambio de rol, entitlement o dato sensible deja un registro en el historial de auditoría.

## 3. Módulos

Cada módulo tiene **una responsabilidad**, un **contrato público** (`index` con tipos) y **no importa la implementación
interna de otro**. Sin dependencias circulares. Lo compartido vive solo en `common`.

| Módulo | Responsabilidad | Puede depender de |
|---|---|---|
| `common` | HTTP, errores, validación, config, rate limiting, idempotencia, auditoría | — |
| `auth` | Sesión, roles, guardas (`requireUser/Owner/Developer`) | common |
| `profiles` | Perfil propio (lectura/edición) | common, auth |
| `catalog` | Lectura del catálogo publicado | common |
| `classes` | Alta/edición/publicación/borrado lógico de clases | common, auth, catalog, r2 |
| `playback` | Decidir acceso y entregar URL firmada | common, auth, entitlements, r2 |
| `progress` | Guardado y lectura de progreso | common, auth |
| `entitlements` | Derechos de acceso digital (conceder/revocar/consultar) | common, auth |
| `payments` | Pedidos/cobros, agnóstico del proveedor; activa o revoca entitlements | common, entitlements |
| `business-admin` | Casos de uso del panel de negocio | los módulos anteriores vía contrato |
| `tech-tools` | Diagnóstico, reconciliación, configuración | common, auth, r2, supabase |
| `supabase` | Adaptadores de repositorio y auth (única capa que habla con Supabase) | common |
| `r2` | Adaptador de R2 (única capa que habla con Cloudflare R2) | common |
| `webhooks` | Recepción firmada e idempotente (PayPal, tienda; el video ya no usa webhooks) | common, payments |

Reglas: la **lógica de negocio no conoce Supabase ni R2** (usa puertos/interfaces); los proveedores se enchufan por
**adaptadores**. Hoy el backend vive en `supabase/functions/_shared/` y el frontend en `js/{lib,ui,components,pages}`;
la migración a módulos con contrato es un objetivo futuro y se hace **de forma incremental**, sin reescribir.

## 4. Seguridad: reglas no negociables

1. Nunca exponer en el frontend: service role key, claves de R2, secretos de webhooks, claves de pago.
   El propietario tampoco los recibe.
2. **No** usar `select('*')` en tablas con columnas privadas (`classes` tiene `r2_object_key` restringida): listar columnas.
3. **Nunca** conceder acceso por datos que envía el navegador (ni redirecciones de checkout): solo por webhook
   firmado y verificado en servidor.
4. Toda operación sensible: autorización en servidor + **rate limiting** + entrada validada.
5. Webhooks y operaciones administrativas: **idempotentes** (clave de idempotencia / registro de eventos).
6. No borrar filas de Postgres ni objetos de R2 sin estrategia de reconciliación (borrado lógico + tarea de limpieza).
7. Conservar y revisar las políticas RLS existentes; toda tabla nueva nace con RLS y privilegios mínimos.
8. Los textos de usuarios se insertan como texto (`el()` / `textContent`), nunca con `innerHTML`.

## 5. Cómo trabajar

1. **Audita** antes de cambiar. 2. **Plan por fases** con archivos, migraciones y pruebas. 3. **Una fase a la vez.**
4. Tras cada cambio corre la **prueba más específica posible**. 5. Al cerrar una fase: formato, lint, typecheck,
tests y build.

**Definición de "hecho"**: una fase no está terminada hasta tener una **prueba ejecutable** que la respalde.
Si una integración externa no se puede probar sin credenciales, hay una prueba de integración **claramente separada**
(`*.integration.*`, se omite sin credenciales) y el paso manual queda documentado.

**Pruebas por módulo**: unitarias + de contrato (su interfaz) + de integración (conexión con otros módulos) + E2E de los
flujos críticos. Un cambio en un módulo debe poder validarse solo y no romper a otro sin que una prueba lo detecte.

**Evitar**: refactors amplios o cambios cosméticos innecesarios; dependencias nuevas sin justificar (anotar el porqué
en el PR); cambiar el diseño visual sin necesidad. **Sí** reemplazar datos falsos por datos reales y eliminar
`href="#"` y acciones simuladas.

## 6. Comandos

```bash
nvm use && npm ci            # instalación reproducible (Node y lockfile fijados)
npm run dev                  # sitio en http://localhost:3000 (serve + serve.json; también sirve Live Server)
npm run verify               # formato + lint + tipos + pruebas unitarias
npm run test:web             # pruebas unitarias del frontend y de doctor (Deno, sin dependencias nuevas)
npm run test:db              # base de datos: migraciones + permisos por rol (requiere PostgreSQL)
npm run doctor[:online]      # revisa la configuración para producción
npm run test:integration     # prueba real contra Supabase+R2 (se omite sin credenciales)
npm run test:e2e             # E2E en navegador (requiere Chrome/Chromium: ver README)
npm run build                # arma dist/ con solo los archivos públicos
npm run sb:db-push | sb:secrets | sb:deploy   # despliegue (ver supabase/README.md)
```

## 7. Trampas conocidas (ya nos mordieron)

- `classes.classes_published_requires_ready`: no se puede publicar sin `video_status = 'ready'`; al fallar un video hay
  que despublicar en la misma operación.
- R2 no transcodifica: no existe un estado "processing" real, solo se conserva por compatibilidad con datos viejos.
  `admin-sync-video` decide todo con un HEAD directo al objeto, nunca confiando en lo que diga el cliente.
- La regex que valida las keys de R2 debe rechazar explícitamente `".."` y `"/"` al inicio: permitir `.` y `/` para
  rutas tipo `classes/<id>/archivo.mp4` casi habilita path traversal por accidente (bug real, atrapado por las pruebas).
- Al capturar un valor "anterior" de una fila, hacerlo **antes** de actualizarla (bug real detectado por las pruebas).
- Las carpetas `_tests` y `_shared` empiezan con guion bajo para que el CLI de Supabase no las despliegue como funciones.
- Un `.env` servido por un servidor estático queda público: publicar **solo** `dist/`.
- Bootstrap ignora `show()`/`hide()` y los clics mientras un modal se anima (~300 ms): en las pruebas se espera a que
  termine de abrirse (`modalReady`) y en el código se usa `closeModal()` y se espera `hidden` antes de reabrir.
- `supabase-js` emite `PASSWORD_RECOVERY` durante su inicialización: hay que suscribirse a `onAuthStateChange`
  **antes** de `getSession()`.
- Con `package.json` en la raíz, Deno resuelve desde `node_modules`: los scripts pasan `--config supabase/functions/deno.json`.
- Las páginas `.html` viven en la RAÍZ (no hay carpeta `pages/`): lo que ves en `npm run dev`/Live Server es lo publicado.
  Enlaces y recursos siempre RELATIVOS y sin `/` inicial (`videoteca.html`, `css/app.css`): con `/x.html` se rompe en GitHub
  Pages, que sirve bajo `/nombre-del-repo/`. `tests/web/pages-links.test.js` falla si algún enlace o recurso no existe o es absoluto.
- Nunca comparar rutas con `startsWith(base + '/')`: en Windows `path` usa `\` y todo da 404 (pasó con un servidor de
  desarrollo propio, ya eliminado). Para servir estáticos se usa `serve`, que ya lo resuelve.
- Un elemento `position:absolute` que va antes en el DOM queda TAPADO por uno posterior (p. ej. `.yp-controls` sobre
  `.yp-resume`): ponerle `z-index`. Un E2E lo atrapó ("Empezar de cero" no recibía el clic).
- `Number(null)` es `0`: al convertir un precio o stock ausente hay que chequear `null`/`undefined` antes, o "sin precio" se
  muestra como "gratis" (bug real de la Fase 14, atrapado por las pruebas).
- Imágenes en Storage (miniaturas y productos): subir la nueva, guardar el cambio y **recién entonces** borrar la vieja; si
  el guardado falla, borrar la nueva. Borrar solo si la URL es del bucket propio (`storagePathFromPublicUrl`).

## 8. Primera entrega (alcance actual)

Estado a 29/09/2026 (la hoja de ruta completa, Fases 0-39, está en el `README.md`). Leyenda: [x] hecho y probado · [~] hecho, con algo pendiente · [ ] pendiente.

- [~] Reproducibilidad de npm/Deno: versiones exactas, `deno.lock` congelado, `.nvmrc` y CI escrito
  (**el CI todavía no se ejecutó en GitHub**)
- [x] Autenticación en el frontend: registro, login, logout, sesión persistente, perfil, cambio de contraseña y
  recuperación por enlace del correo (E2E en verde; el bug del evento `PASSWORD_RECOVERY` se detecta con mutación)
- [x] Catálogo real desde Supabase (carga, error, vacío y filtros)
- [x] Página de detalle de clase (sin sesión, sin acceso, no encontrada, en preparación, error y reintento)
- [x] Reproductor de un solo vídeo (progresivo desde R2 con URL firmada, velocidad, teclado, retomar; sin selector de
  calidad ni HLS: R2 no transcodifica)
- [x] Pruebas de carga, error, acceso denegado, URL expirada (al cargar, siempre y preventiva) y progreso
  (periódico, al pausar, al salir, al terminar, retomar y empezar de cero)
- [~] README con comandos de instalación y pruebas; faltan los pasos de despliegue definitivos con cuentas reales

- [x] **Roles y auditoría** (`user`/`owner`/`developer`, historial inmutable): base de datos con `npm run test:db` y guardas
  con pruebas de "acceso denegado" por nivel
- [~] **Puesta en marcha con cuentas reales**: guía (`docs/PUESTA-EN-MARCHA.md`), `npm run doctor[:online]` y
  `npm run test:integration` listos; **falta que el cliente cree las cuentas**

- [~] **Panel de negocio** (Fases 8-11: clases; Fase 14: productos): código completo. La Fase 8 (lista y acceso por rol) tiene E2E; las 9-11 no se dan por cerradas sin sus pruebas. Productos (Fase 14 ✅): probado en navegador
  (E2E), en base de datos y a mano contra el Supabase real (30/09/2026). Clases: solo la lista tiene E2E; crear/editar/subir/publicar/borrar aún no
- [x] **Tienda pública** (Fases 12-13): modelo de datos con RLS, catálogo con buscador y ficha de producto
- [ ] Carrito, pagos (**todo con PayPal**), reconciliación programada y panel técnico interno

Lo que falta está planificado por fases en la hoja de ruta del `README.md` y **no** se empieza sin cerrar la fase anterior.
