# Blindaje · Pagos, cuenta y comentarios (Fases 17-27)

Revisión del 10/10/2026 sobre el repositorio completo. Cómo se verificó: `npm run verify`, `npm run test:db` (PostgreSQL real),
la suite E2E completa en Chromium real (con y sin la CSP de producción), `npm audit`, y las revisiones estáticas nuevas
(`npm run security`). Nada de esto toca PayPal: se puede correr hoy.

## Qué se revisó y cómo quedó

| Área | Resultado | Cómo queda cubierto |
|---|---|---|
| Base de datos: RLS | Las 16 tablas de `public` tienen RLS y políticas; ninguna deja leer o escribir de más. | `supabase/tests/security_invariants.test.sql` §1-2 y 10 |
| Base de datos: privilegios | `anon` solo lee (nada de escritura, ni por columna); pedidos, pagos, auditoría y entitlements son de solo lectura para el navegador; `rate_limits` no tiene ningún privilegio. | §3-5 y 10 |
| Base de datos: funciones | Toda `SECURITY DEFINER` fija su `search_path`; las funciones de pago/auditoría solo las ejecuta `service_role`; `anon` solo ejecuta `live_agenda` y un validador sin efectos. | §6, 8 y 9 |
| **Hallazgo 1 (menor)** | Las dos funciones de trigger de comentarios (Fases 26-27) quedaron ejecutables por `anon`/`authenticated` (Supabase da `EXECUTE` por defecto). No era explotable —Postgres no deja ejecutar una función de trigger a mano— pero no tienen por qué estar en la API. | Migración `20261010120000_revoke_trigger_function_execute.sql` (quita el permiso a TODAS las funciones de trigger) + §7 de las invariantes, que falla si vuelve a pasar. |
| **Hallazgo 2** | La política de privacidad no decía que los **comentarios se publican con tu nombre**. | Texto actualizado (datos, finalidad y moderación), `PRIVACY_VERSION` → `2026-10-10` y una prueba que exige que cada función con datos personales figure en la política (`tests/web/privacy.test.js`). |
| **Hallazgo 3** | `npm audit` marcaba 2 vulnerabilidades altas en una dependencia de desarrollo (`compression`, usada por el servidor local `serve`; no llega a producción). | `overrides` en `package.json` → `compression@1.8.2`; `npm audit` en 0. |
| Backend (Edge Functions) | Todas autentican (salvo `health` y el webhook, que verifica la firma de PayPal), limitan el ritmo, validan la entrada y no devuelven detalles internos. Sin cambios necesarios. | `npm test` (120 pruebas) |
| Frontend | Sin `innerHTML`/`eval`/scripts inline; todo enlace externo lleva `rel=noopener`; el texto de los comentarios se inserta siempre como texto (hay una prueba E2E con HTML hostil). | `tests/web/csp.test.js`, `tests/web/security-static.test.js`, E2E |
| Secretos | Ningún secreto en el repo ni en el historial; el único JWT incrustado es la clave pública (`role: anon`). | `tests/web/security-static.test.js` (patrones de secretos, JWT con rol ≠ anon, `.gitignore`) |

## Prueba contra tu Supabase real (sin PayPal)

`npm run test:integration` ahora también comprueba, contra el proyecto real y limpiando lo que crea:

1. que pedidos, pagos, auditoría y reservas ajenas **no se leen sin sesión**;
2. que **sin sesión no se puede escribir** (productos, clases, comentarios, reservas);
3. que la **agenda pública** responde y no expone a los alumnos;
4. que las **migraciones** de pagos y comentarios están aplicadas;
5. una **reserva real** (reservar → verla en "Mis clases" → cancelar);
6. el circuito de **comentarios**: nace pendiente, no es público y la autora no puede aprobarlo (se borra al final).

Si no hay clases en vivo futuras con lugar, o la cuenta de prueba ya tiene un comentario, esos pasos se omiten (con aviso) en vez de fallar.

## Qué falta para pasar cada 🟡 a ✅ (y quién lo hace)

| Fase | Qué falta | Se puede hacer sin PayPal |
|---|---|---|
| 18-22 · Pagos y suscripciones | Probarlos contra el sandbox (o el entorno real) de PayPal, `docs/PAYPAL.md`. | No: es justamente la parte de PayPal. |
| 24-25 · Compras y suscripción en Mi cuenta | Verlas con una compra y una suscripción reales. | No: dependen de que haya pedidos reales. |
| 26-27 · Comentarios | Aplicar la migración (`npm run sb:db-push`) y `npm run test:integration` en verde. | **Sí**, con tu Supabase. |
| 29-30 · Agenda y reservas | Mismo `npm run test:integration` en verde (incluye una reserva real) **y decidir si reservar es gratis o con pago**. | **Sí**, salvo la decisión de negocio. |
| 31 · Aviso de clase en vivo | Necesita un SMTP propio (Fase 37). | Solo preparar el código; no se puede dar por cumplida sin el SMTP. |
| 32-39 · Cuentas reales, escalado y entrega | Son pasos con cuentas, dominio y cliente reales. | No. |
