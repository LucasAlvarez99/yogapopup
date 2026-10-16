# Fases 32 a 36 · De las pruebas a las cuentas reales

Estas cinco fases son **pasos con tus cuentas reales** (Supabase, Cloudflare R2, un video de verdad y los costos que cobran).
El código ya está listo y probado con dobles; lo que falta es correrlo contra la realidad. Esta guía te dice **qué hacer, con qué
comando y cómo saber que salió bien**. Los detalles de cada paso están en [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md).
Recién cuando cada criterio se cumple, tildá la fase en el README (🟡 → ✅).

## Fase 32 · Cuentas reales — infraestructura

| Qué | Cómo |
|---|---|
| Proyecto de Supabase y migraciones | PUESTA-EN-MARCHA §2: `npm run sb:login` → `sb:link` → `npm run sb:db-push` (aplica **todas**, hasta `20261020…_live_reminders`) |
| Bucket de R2, CORS y token | §4 (permiso *Object Read & Write*) |
| Secretos y funciones | §5: completar `supabase/.env` → `npm run sb:secrets` → `npm run sb:deploy` |
| Comprobación | `npm run doctor:online` → **0 errores** |

✅ **Cumplida cuando:** `doctor:online` termina sin errores, en Supabase existen las tablas (`profiles`, `classes`, `orders`,
`live_bookings`…) y las funciones (`playback`, `admin-*`, `paypal-*`, `live-reminders`) figuran desplegadas.

## Fase 33 · Prueba con un solo video real

1. Con una cuenta `developer`: panel → *Clases* → *Nueva clase* con **un mp4 (H.264/AAC)** corto (§8). Publicarlo.
2. Verlo con otra cuenta y probar que **una URL suelta no sirve**: copiá la URL firmada, esperá a que venza (o cambiale la firma) y
   comprobá que ya no reproduce.
3. `YP_SUPABASE_URL=… YP_ANON_KEY=… YP_TEST_EMAIL=… YP_TEST_PASSWORD=… YP_CLASS_ID=<id> npm run test:integration`

✅ **Cumplida cuando:** el video sube directo a R2, se publica, se reproduce con sesión y permite adelantar, y `test:integration`
sale con los 9 pasos ✓ (el 7 = Range, el 8 = sin firma no se ve).

## Fase 34 · Un solo video — progreso, responsive y costo

- **Progreso:** ver la mitad, cerrar la pestaña y volver → pregunta si continuar; "Continuar viendo" en la home lo lista; al terminar
  queda "Vista".
- **Responsive:** escritorio, un móvil Android (Chrome) y un iPhone (Safari iOS). Revisar el reproductor a pantalla completa y girando.
- **Costo:** miralo en Cloudflare → R2 → tu bucket → *Métricas* y proyectalo:
  ```bash
  npm run cost -- --videos 1 --gb <lo que ocupa el bucket> --target 40
  ```
  Ajustá la estimación del README (hoy 80 GB para 40 clases) con el promedio real.

✅ **Cumplida cuando:** el progreso se guarda y retoma, el sitio se ve bien en los tres dispositivos y la estimación de costo quedó
corregida en el README con el número real.

## Fase 35 · Escalado — varios videos

1. Subir **3**, luego **10** videos **desde el panel** (sin tocar código ni la base a mano).
2. Anotar cuánto tarda cada subida (según tu conexión) y cuánto tarda en cargar la videoteca con 10 videos.
3. `npm run cost -- --videos 10 --gb <GB del bucket> --target 40`

✅ **Cumplida cuando:** los 10 están publicados, la videoteca y la búsqueda siguen ágiles y las subidas no fallan (si alguna falla,
el panel la deja en *Falló* y se puede reintentar: anotá el motivo).

## Fase 36 · Escalado — catálogo completo

1. Cargar el catálogo completo (~40 videos) desde el panel.
2. Revisar el uso real: R2 (almacenamiento) y Supabase (base, ancho de banda) en sus paneles.
3. `npm run cost -- --videos 40 --gb <GB del bucket>` → comparar con lo cobrado.

✅ **Cumplida cuando:** el catálogo completo está cargado, la videoteca responde bien y el costo real coincide (o se ajustó) con la
estimación del README. Antes de abrir al público, **copia de seguridad manual de la base** (el plan gratuito no la incluye; Fase 38).

## Si algo se traba

La tabla "Si algo falla" de [`PUESTA-EN-MARCHA.md`](PUESTA-EN-MARCHA.md) cubre lo más común (casi siempre es el CORS del bucket o
`ALLOWED_ORIGINS`). Pegame el mensaje exacto y la salida de `npm run doctor:online` y lo resolvemos.
