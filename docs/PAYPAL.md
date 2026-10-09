# Pagos con PayPal (Fases 17-22)

Guía para poner en marcha, probar y operar los cobros. Todo se cobra en **EUR** con **PayPal**: compras de la tienda,
clases sueltas y la suscripción mensual.

> **Estado honesto.** El código y las pruebas automáticas están listos (base de datos probada contra un Postgres real, backend
> y frontend con dobles de PayPal). Lo que **todavía no se hizo** es probarlo contra el sandbox real de PayPal: nadie debería
> pasar a `live` sin completar la sección [Prueba en el sandbox](#prueba-en-el-sandbox).

## Cómo funciona

```
Navegador                       Edge Functions (servidor)                   PayPal            Base (Postgres)
─────────                       ─────────────────────────                   ──────            ───────────────
"Finalizar compra" ──────────▶  paypal-create-order
 (solo ids y cantidades)         · lee precio, IVA y stock DE LA BASE ─────────────────────────▶ payments_create_order
                                 · reserva el stock                                              (pedido 'created')
                                 · crea la orden en PayPal ─────────────▶ Orders v2
 ◀── id de la orden ─────────────
PayPal pide el pago
 (popup, dirección de envío)
onApprove ───────────────────▶  paypal-capture-order
                                 · consulta la orden a PayPal ◀────────── (nunca confía en el navegador)
                                 · compara monto, moneda y custom_id
                                 · captura ─────────────────────────────▶ capture
                                 · registra el pago ─────────────────────────────────────────▶ payments_mark_paid
 ◀── 'paid' / 'pending' ─────────                                                               (+ acceso si es una clase)

PayPal ──▶ paypal-webhook   firma verificada con la API de PayPal; idempotente (payment_events);
                            reembolsos, contracargos, renovaciones, cancelaciones, pagos fallidos
Panel ──▶ paypal-reconcile  "Verificar de nuevo" y "Conciliar pendientes": mismo código, a pedido
```

**Tres reglas que no se negocian**

1. **PayPal es la fuente de la verdad.** Lo que dice el navegador (o el cuerpo de un webhook) solo sirve para saber *qué
   revisar*; el estado, el monto y las fechas se vuelven a pedir a la API de PayPal.
2. **Todo es idempotente.** Doble clic, recarga, webhook repetido, conciliación manual: nada duplica un pedido, un acceso, el
   stock descontado ni un reembolso.
3. **El monto cobrado tiene que ser exactamente el del pedido.** Si no coincide, no se da nada por pagado y el pedido queda marcado
   para revisión.

### Estados

| Pedido | Qué significa |
|---|---|
| `created` | Existe, el stock (si es de tienda) está **reservado**, todavía no se pagó. Se libera solo pasada 1 hora. |
| `pending` | PayPal recibió el pago pero aún no lo liquidó. No se da acceso hasta que se confirme. |
| `paid` | Cobrado y verificado. Una clase suelta ya concedió el acceso. |
| `failed` / `cancelled` | El pago falló, se abandonó o venció: el stock volvió. |
| `refunded` | Reembolsado por completo (una clase pierde el acceso). Uno parcial deja el pedido en `paid` y suma `refunded_cents`. |

| Suscripción | Acceso |
|---|---|
| `approval_pending` | Ninguno hasta que PayPal la active. |
| `active` | Hasta la próxima fecha de cobro **+ 2 días de gracia** (un cobro que se demora no corta el acceso). |
| `suspended` | PayPal no pudo cobrar. No se extiende: el acceso termina cuando vence lo ya cubierto. |
| `cancelled` / `expired` | Al **cancelar no se corta**: dura hasta el fin del período ya pagado (sin la gracia). |

Un pedido con **`needs_review`** (amarillo en el panel) pide que una persona lo mire:
`amount_mismatch` (PayPal cobró un importe distinto) o `paid_without_stock` (pago tardío cuando ya no quedaba stock: hay que
reembolsar o conseguir el producto).

## Puesta en marcha en sandbox

Orden importante: **primero la base y las funciones, después la web.**

1. **Cuenta de PayPal Developer** → <https://developer.paypal.com> → *Apps & Credentials* → modo **Sandbox** → *Create App*
   (tipo *Merchant*). Copiá el **Client ID** y el **Secret**. En *Sandbox → Accounts* ya hay una cuenta *Business* (la tuya, la que cobra)
   y una *Personal* (la compradora de pruebas).
2. **`supabase/.env`** (secretos, nunca en git):
   ```
   PAYPAL_ENV=sandbox
   PAYPAL_CLIENT_ID=<el Client ID>
   PAYPAL_CLIENT_SECRET=<el Secret>
   ```
3. **Aplicar la migración**: `npm run sb:db-push` (crea `orders`, `order_items`, `subscriptions`, `payment_events`, el precio de las
   clases y las reglas atómicas).
4. **Crear el plan de suscripción** (precio final, IVA incluido):
   ```
   npm run paypal:plan -- --price 9,99
   ```
   > **PowerShell (Windows):** si ves `"9 99" is being parsed as a normal command line argument`, es que PowerShell partió el `9,99`
   > por la coma. Usá el punto y comillas: `npm run paypal:plan -- --price "9.99"`, o directamente
   > `node scripts/paypal-setup.mjs plan --price "9.99"`.
   Imprime `PAYPAL_PLAN_ID=P-…`: pegalo en `supabase/.env`. (Mensual por defecto; `--interval YEAR` para anual; `--tax 21` es el IVA incluido.)
5. **Subir secretos y desplegar**: `npm run sb:secrets` y `npm run sb:deploy`.
6. **Registrar el webhook** (con las funciones ya desplegadas):
   ```
   npm run paypal:webhook -- --url https://TU-PROYECTO.supabase.co/functions/v1/paypal-webhook
   ```
   Imprime `PAYPAL_WEBHOOK_ID=…`: pegalo en `supabase/.env` y volvé a correr `npm run sb:secrets`.
7. **`js/config.js`**: completá `PAYPAL.CLIENT_ID` con el **mismo** Client ID. Si querés ofrecer la suscripción, escribí
   `PAYPAL.PLAN_LABEL` (por ejemplo `'Plan mensual · 9,99 € / mes'`): vacío = no se ofrece.
8. **Precio de las clases sueltas**: panel → pestaña **Pagos** → *Precio de las clases sueltas*. Solo las clases con acceso
   *restringido* se pueden vender; vacío = no se vende suelta. Cada cambio queda auditado.
9. **Construir y publicar la web** (`npm run build`). Con un Client ID configurado, la CSP agrega los hosts de PayPal y la cabecera
   `Cross-Origin-Opener-Policy` pasa a `same-origin-allow-popups` (si no, la ventana de pago no puede hablar con la página).
10. **`npm run doctor`** y **`npm run doctor:online`**: revisan credenciales, que el Client ID del sitio coincida con el del backend,
    que el webhook rechace eventos sin firma y que las tablas de dinero no se lean sin sesión.

Las credenciales son opcionales: sin ellas el sitio funciona igual, las funciones responden `503 payments_not_configured` y el botón
"Finalizar compra" sigue deshabilitado.

## Prueba en el sandbox

Marcá cada punto con la cuenta *Personal* de pruebas. Es la parte que falta para dar por cumplidas las Fases 18-22.

**Compra de la tienda**
- [ ] Agregar productos (uno con talle) → *Finalizar compra* → PayPal pide la dirección → pago → pedido **Pagado** en el panel, con la dirección de envío.
- [ ] El stock bajó exactamente lo comprado (y el del talle, no el del producto).
- [ ] Cerrar el popup de PayPal sin pagar → mensaje "No se te cobró nada" y el pedido queda `created`; pagar de nuevo funciona (el intento nuevo reemplaza al anterior y el stock no queda doble reservado).
- [ ] Con 1 unidad en stock, dos navegadores a la vez: solo uno puede pagar; el otro recibe "no queda stock".
- [ ] Recargar la página justo después de aprobar (antes de ver "gracias"): el pedido igual queda pagado (webhook o *Verificar de nuevo*).
- [ ] Cambiar el precio de un producto con el carrito abierto: lo cobrado es el precio **de la base**, no el que se veía.

**Clase suelta**
- [ ] Clase restringida con precio → *Comprar esta clase* → pago → la clase se reproduce sin recargar. Otra clase restringida sigue bloqueada.
- [ ] Intentar comprarla de nuevo → "Ya tenés acceso".

**Reembolsos**
- [ ] Reembolsar *parcialmente* desde el panel del sandbox → el pedido sigue pagado y suma el reembolso.
- [ ] Reembolsar el resto → pedido **Reembolsado** y la clase vuelve a bloquearse.

**Suscripción**
- [ ] *Suscribirme* → aprobar → en unos segundos *Mi cuenta* dice "Suscripción activa" con la próxima renovación, y las clases restringidas se ven.
- [ ] *Cancelar suscripción* → se cancela **en PayPal** (verificalo en el panel del sandbox) y el acceso sigue hasta la fecha mostrada.
- [ ] Una segunda suscripción con la misma cuenta mientras hay una activa → "Ya tenés una suscripción activa".

**Webhook y conciliación**
- [ ] En *Developer → tu app → Webhooks*, los eventos de las pruebas figuran **entregados (200)**.
- [ ] Con un `PAYPAL_WEBHOOK_ID` equivocado a propósito, los eventos fallan con 401 (y no cambian nada). Después se corrige.
- [ ] *Verificar de nuevo* sobre un pedido pagado → "ya estaba pagado", sin cambios. Sobre uno abandonado → se cancela y devuelve el stock.
- [ ] La pestaña **Pagos** no muestra ningún pedido en amarillo después de todas las pruebas (o, si lo hay, se entiende por qué).

> El *Webhook simulator* de PayPal manda eventos de ejemplo cuyos ids **no existen** en tu cuenta: sirven para ver que la firma se
> verifica, pero el procesamiento falla (a propósito) porque el backend vuelve a pedir el recurso a PayPal. Usá pagos reales del sandbox.

**Si algo se comporta distinto a lo documentado**, lo más probable está en el contrato con PayPal (los cuerpos de `createOrder`
y `createSubscription`, los enlaces de reembolso). Están concentrados en
`supabase/functions/_shared/paypal/paypal.service.ts`: ahí se ajusta, y los tests de ese archivo documentan lo que se espera.

## Pasar a producción (`live`)

- [ ] Todo lo de [Prueba en el sandbox](#prueba-en-el-sandbox) hecho.
- [ ] App **Live** en PayPal (con la cuenta *Business* real verificada) → nuevos `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`; `PAYPAL_ENV=live`.
- [ ] Repetir `npm run paypal:plan -- --price … --confirm-live` y `npm run paypal:webhook -- --url … --confirm-live` (son objetos **distintos** a los del sandbox).
- [ ] `PAYPAL.CLIENT_ID` de `js/config.js` = el Client ID **live**. `npm run doctor` tiene que decir que coinciden.
- [ ] Quitar `localhost` y `127.0.0.1` de `ALLOWED_ORIGINS`.
- [ ] **IVA:** los precios se guardan con el IVA incluido (productos y clases: 21 % por defecto). Confirmar con la gestoría el tipo aplicable a
      cada cosa (servicio digital, producto físico) y ajustar `tax_rate_bps`.
- [ ] **Legal (no cubierto por el código):** datos del responsable completos en `js/config.js > LEGAL`, política de privacidad revisada
      por un profesional (se actualizó para los pagos: versión `2026-10-08`), y las condiciones de compra, el derecho de desistimiento
      y la política de devoluciones que exige la normativa de consumo. Hoy esas páginas **no existen**.
- [ ] Una compra real de importe mínimo con una cuenta propia, y un reembolso, antes de abrir al público.

## Conciliación automática (opcional)

El botón **Conciliar pendientes** del panel hace el barrido a mano. Para que corra solo:

1. Generá un secreto largo y aleatorio y ponelo en `supabase/.env` como `RECONCILE_CRON_SECRET`; `npm run sb:secrets`.
2. Programá una llamada cada 15 minutos (Supabase → *Integrations → Cron*, o cualquier cron externo):
   ```
   curl -X POST https://TU-PROYECTO.supabase.co/functions/v1/paypal-reconcile \
        -H "Content-Type: application/json" -H "x-cron-secret: $RECONCILE_CRON_SECRET" -d '{"sweep":true}'
   ```
   El secreto solo habilita el **barrido**; verificar un pedido o una suscripción puntual exige sesión de gestión.

El barrido: captura las órdenes que la persona aprobó y nunca se capturaron (si tienen menos de 24 h; las más viejas se cancelan),
cancela y libera el stock de los pedidos sin pagar de más de 1 hora, concilia pendientes y descarta suscripciones que nunca se aprobaron en 24 h.
*(Esta programación no se probó acá: la lógica del barrido sí.)*

## Referencia

| Función | Quién | Para qué |
|---|---|---|
| `paypal-create-order` | sesión | Crea el pedido (precio/stock de la base) y la orden de PayPal. |
| `paypal-capture-order` | sesión (dueño del pedido) | Captura, verifica y registra el pago. |
| `paypal-create-subscription` | sesión | Crea la suscripción con el plan del servidor y la persona como `custom_id`. |
| `paypal-activate-subscription` | sesión (dueña) | Consulta a PayPal y concede el acceso si está activa. |
| `paypal-cancel-subscription` | sesión | Cancela en PayPal; el acceso sigue hasta el fin de lo pagado. |
| `paypal-webhook` | PayPal (firma) | Eventos: cobros, reembolsos, contracargos, renovaciones, cancelaciones, pagos fallidos. |
| `paypal-reconcile` | gestión (o cron para el barrido) | "Verificar de nuevo" y barrido. |

Códigos de error nuevos (los muestra la web en español): `payments_not_configured` (503), `payment_provider_error` (502),
`payment_declined` / `payment_failed` (402), `payment_review` / `order_cancelled` / `order_not_approved` (409), `insufficient_stock`,
`product_unavailable`, `class_unavailable`, `already_owned`, `already_subscribed` (409), `invalid_cart` / `size_required` (400),
`too_many_orders` (429), `order_not_found` / `subscription_not_found` / `no_subscription` (404), `invalid_signature` (401).

## Límites y decisiones conocidas

- **Sin costo de envío.** La tienda dice "todos nuestros productos se envían a domicilio" y el pedido cobra solo los productos. Si se
  quiere cobrar el envío hay que modelarlo (hoy no existe).
- **Moneda única: EUR.** Un reembolso de productos **no repone el stock solo** (depende de si el producto vuelve).
- **Una suscripción viva por persona** y un solo plan. Un pedido es de **un solo tipo**: productos físicos o *una* clase (nunca mezclados).
- **Stock reservado 1 hora** mientras se paga; un intento nuevo de la misma persona reemplaza al anterior.
- **Facturas:** el sistema guarda pedidos con su IVA incluido, pero **no emite facturas**.
- **Privacidad:** de cada evento del webhook se guarda solo un resumen (ids, estado, monto), no el cuerpo (trae correo y dirección). La dirección
  de envío vive en `orders.shipping` y la ven solo la persona y la gestión.
- **CSP:** los estilos siguen sin `'unsafe-inline'`. Si en el sandbox los botones salen sin estilo o no aparecen, mirá la consola del
  navegador (violaciones de CSP) antes de aflojarla; los hosts permitidos están en `scripts/lib/security-headers.mjs` (`PAYPAL_HOSTS`).
- **`application_context`:** las órdenes y suscripciones se crean con el bloque `application_context` (marcado como heredado por PayPal pero
  vigente). Si el sandbox lo rechazara, el ajuste es mínimo y está en `paypal.service.ts`.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| Los botones de PayPal no aparecen | `PAYPAL.CLIENT_ID` vacío; un bloqueador de anuncios; o la CSP de una build vieja (volvé a `npm run build`). La consola lo dice. |
| "Los pagos todavía no están disponibles" (503) | Faltan `PAYPAL_ENV` / `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` en los secretos (`npm run sb:secrets`). |
| El pago se aprueba pero falla al confirmar | El Client ID del sitio y el del backend son de apps distintas (`npm run doctor` lo detecta). |
| El webhook devuelve 401 | `PAYPAL_WEBHOOK_ID` no es el de ese entorno (sandbox ≠ live) o el webhook se registró con otra URL. |
| Un pedido quedó "Sin pagar" pero la persona pagó | Falló el webhook y el navegador no confirmó: *Verificar de nuevo*. |
| Pedido amarillo `amount_mismatch` | PayPal cobró otro importe. No se concedió nada; revisalo en PayPal y reembolsá o corregí a mano. |
| Pedido amarillo `paid_without_stock` | Pago tardío sin stock: reembolsar o conseguir el producto. |
