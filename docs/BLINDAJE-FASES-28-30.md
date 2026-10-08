# Blindaje · Profesores, agenda de clases en vivo e idioma (Fases 28-30)

Revisión del 06/10/2026 sobre el repositorio completo (no solo lo nuevo). Cómo se verificó: `npm run verify`, `npm run build`,
`npm run test:db` (PostgreSQL real), la suite E2E completa en Chromium real (también contra `dist/` con la CSP de producción),
`npm audit`, ESLint con reglas estrictas (`no-undef`, `no-unused-vars`, `no-dupe-keys`, `prefer-const`…) y un recorrido
de cada página (ids duplicados, `alt`, `rel=noopener`, `href="#"`, estilos y handlers inline que la CSP bloquea).

## Corregido en esta revisión

| # | Hallazgo | Arreglo | Cómo queda cubierto |
|---|---|---|---|
| 1 | **Los mensajes de validación nunca llegaban a la pantalla**: el formulario de clases siempre decía "Revisá los datos ingresados" en vez de "El título es obligatorio", etc. (`messageFor` prioriza el texto genérico del código `invalid_input`). | Los errores de formulario usan el código `validation`, sin texto genérico, así se muestra el mensaje real. | `tests/web/agenda.test.js` + E2E del panel (título vacío, fecha pasada). |
| 2 | **Dar de alta a un admin como profesor le quitaba el rol admin** (le pasó a Manuela). | Migración `20261006120000`: `add_teacher_by_email` nunca baja de rango; casilla "También es admin". | `profesores_agenda.test.sql` §11 + E2E. |
| 3 | `teachers.photo_url` aceptaba cualquier texto (`javascript:`, `http:`) y `specialties` aceptaba 8 textos gigantes. | Migración `20261007120000`: solo `https://…` sin espacios; cada especialidad de 1 a 30 caracteres. | `profesores_agenda.test.sql` §12. |
| 4 | Una política RLS para `anon` llamaba a `is_staff()` (sin permiso para `anon`): la home fallaba para visitantes sin sesión. | Políticas separadas para `anon` y `authenticated`. | `profesores_agenda.test.sql` §4. |
| 5 | **El E2E de CI no conocía las tablas nuevas** y no cubría el carrusel, la reserva, el idioma ni el panel de profesores. | Backend simulado ampliado + 11 pruebas E2E nuevas (incluye la CSP). | `npm run test:e2e`, `npm run test:e2e:csp`. |
| 6 | Calendario vacío cuando este mes no tiene clases pero el siguiente sí (parecía que no había agenda). | Al abrir un profesor salta al primer mes con clases. | E2E "salta al primer mes con clases". |
| 7 | ARIA inválido (`listbox`/`option`/`tab`/`grid` sin la navegación con flechas que exigen). | Botones con `aria-pressed` / `aria-current`; tabla simple. | Revisión manual + E2E. |
| 8 | La política de privacidad no mencionaba reservas, la lista de asistentes que ve el profesor, los datos públicos de los profesores ni el idioma recordado. | Texto actualizado y `PRIVACY_VERSION` → `2026-10-06` (regla del propio archivo). | `tests/web/privacy.test.js`, E2E de la política. |
| 9 | Enlaces del pie que no llevaban a ningún lado (`href="#"`: Preguntas frecuentes, Medios de pago, Envíos). | Retirados hasta que existan esas páginas. | Guarda de enlaces (`tests/web/pages-links.test.js`). |
| 10 | Textos sin traducir: pie con año, "Tu carrito (", "Entrar", "Nombre", "Volver", "Entendido", "Todas". | Diccionario completado. | `tests/web/i18n.test.js`. |
| 11 | Detalles de código: `prefer-const`, importación duplicada, URL temporal sin liberar, reporte del E2E que señalaba la ayuda y no el test. | Corregidos. | ESLint limpio. |

## Decisiones que NO son técnicas (te tocan a vos / al titular)

1. **Datos del responsable vacíos** (`js/config.js` → `LEGAL`): la política de privacidad muestra "pendiente de completar" y `npm run doctor` lo avisa.
   Hay que completarlos antes de abrir el registro al público, y revisar el texto de la política con un asesor legal (es redacción base).
2. ~~**Tarjetas de cursos de ejemplo en la home**~~ **Resuelto:** los cursos son los videos que se suben a Cloudflare R2 (tabla `classes`).
   Se retiraron las maquetas (precios inventados y botones "Ver curso" sin acción) y la sección `#cursos` de la home ahora carga los últimos
   cursos publicados (`#homeVideos`); "Ver todos los cursos" lleva a `videoteca.html`. Cobrar un curso (precio/entitlement) queda para la fase de pagos.
3. **"Ver clases gratis"** en el hero da por hecho que reservar es gratis. Si se va a cobrar, cambiar el texto y sumar el pago a la reserva.
4. **Cupos y cuentas falsas**: reservar exige una cuenta con correo confirmado, pero una persona con muchas cuentas podría ocupar los lugares de una clase.
   Si pasa, el siguiente paso es un límite de reservas por persona y por semana (no se hizo: hoy no hay evidencia de abuso).
5. **Idioma en la política legal**: el texto legal se queda en español (se marcó `translate="no"`); traducirlo requiere revisión de un profesional.
6. El **id** de cada profesor (el mismo de su cuenta) es público porque forma parte de su perfil en la home. No da acceso a nada, pero conviene saberlo.
