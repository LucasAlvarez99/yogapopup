Quiero convertir este repositorio de YogaPop Up desde una prueba técnica a un producto real.

Contexto:
- Frontend actual: HTML, CSS y JavaScript estático.
- Backend: Supabase Edge Functions con TypeScript/Deno.
- Base de datos: Supabase Postgres con RLS.
- Vídeos: Bunny Stream mediante subida TUS y reproducción HLS firmada.
- El repositorio ya contiene lógica de autenticación, permisos, progreso, webhooks, firmas Bunny y pruebas unitarias.
- No quiero una reescritura innecesaria ni perder las garantías de seguridad actuales.

Objetivo:
Construir un MVP comercial funcional con:
1. Registro, login, logout, edición de perfil, recuperación de contraseña y sesión persistente.
2. Catálogo real de clases cargado desde Supabase.
3. Videoteca protegida.
4. Reproductor HLS con hls.js.
5. URLs Bunny firmadas y renovación antes de expirar.
6. Guardado de progreso con debounce, al pausar, al cambiar de página y al terminar.
7. Sección “Continuar viendo”.
8. Panel de negocio protegido para el propietario y panel técnico interno separado para los desarrolladores, ambos fuera de la aplicación de usuarios y con permisos diferentes.
9. Creación, edición, publicación, despublicación y eliminación de clases.
10. Subida directa a Bunny con progreso visible.
11. Estados de vídeo: pendiente, subiendo, procesando, listo, fallido y abandonado.
12. Reintentos y reconciliación entre Bunny y Supabase.
13. Base preparada para pagos y entitlements.
14. Tests unitarios, integración y E2E.
15. Deben existir tres niveles de acceso claramente separados: usuarios finales, propietario y desarrolladores. El propietario tendrá un rol de superusuario de negocio y podrá gestionar las operaciones funcionales que necesite, como clases, publicaciones, catálogo, usuarios, entitlements y métricas, siempre mediante un panel de negocio protegido y con autorización validada en el servidor. Los desarrolladores tendrán acceso adicional al panel técnico interno, incluyendo operaciones de diagnóstico, reconciliación, configuración y mantenimiento. El propietario no debe recibir secretos, service role keys, API keys de Bunny ni acceso directo a Supabase, Bunny o a la infraestructura. Los usuarios finales solo podrán utilizar la aplicación pública y sus funciones de cliente.
16. Modulariza todo el proyecto para favorecer la escalabilidad y reducir el riesgo de regresiones. Separa como módulos independientes, como mínimo, autenticación, perfiles, catálogo, clases, reproducción, progreso, entitlements, pagos, administración de negocio, herramientas técnicas, integración con Supabase, integración con Bunny y webhooks. Cada módulo debe tener una responsabilidad clara, una interfaz o contrato definido y no debe acceder directamente a la implementación interna de otro módulo. Evita dependencias circulares y centraliza la lógica compartida en módulos comunes bien delimitados. Añade tests unitarios para cada módulo, tests de contrato para sus interfaces, tests de integración para las conexiones entre módulos y tests E2E para los flujos críticos. Cualquier cambio en un módulo debe poder validarse de forma aislada y no debe romper otros módulos sin que las pruebas lo detecten.
17. Implementa un sistema completo de cobros para todos los productos del negocio, tanto digitales como físicos. Debe contemplar pagos únicos y recurrentes para clases, cursos y suscripciones, y también la venta de ropa, mats y demás productos físicos. Separa claramente los entitlements digitales de los pedidos físicos: los pagos digitales deben activar o revocar accesos, mientras que los pedidos físicos deben gestionar variantes, tallas, colores, stock, dirección de entrega, impuestos, envíos, estados del pedido, devoluciones, reembolsos y cancelaciones. Utiliza proveedores adecuados para cada tipo de producto, por ejemplo Paddle para productos digitales y un proveedor de comercio electrónico o pagos físicos como Shopify o Stripe para la tienda, sin acoplar la lógica de negocio a un proveedor concreto. Todos los proveedores deben integrarse mediante adaptadores y webhooks firmados, idempotentes y validados en el servidor. No concedas acceso digital ni marques un pedido como pagado basándote únicamente en datos del navegador o en la redirección del checkout. Guarda los identificadores externos, el estado de cada operación y un historial auditable, y añade procesos de reintento y reconciliación para evitar pagos cobrados sin acceso, accesos sin pago, pedidos sin stock o estados inconsistentes.

Reglas importantes:
- No expongas nunca service role key, API keys de Bunny ni secretos en el frontend.
- Conserva y revisa las políticas RLS existentes.
- No uses select('*') en tablas que contengan columnas privadas.
- No concedas acceso por datos enviados por el navegador.
- Toda autorización debe validarse en servidor.
- No borres registros de Postgres o vídeos Bunny sin estrategia de reconciliación.
- Añade idempotencia a webhooks y operaciones administrativas.
- Añade rate limiting o una estrategia equivalente para endpoints sensibles.
- Mantén la separación entre lógica de negocio, Supabase y Bunny.
- No añadas dependencias sin justificarlo.
- No modifiques diseño visual sin necesidad, pero reemplaza todos los datos falsos por datos reales.
- No dejes botones con href="#" ni acciones simuladas.
- No consideres terminada una fase hasta tener una prueba ejecutable.

Forma de trabajo:
1. Audita primero el repositorio y enumera los huecos concretos.
2. Propón un plan por fases con archivos afectados, migraciones y pruebas.
3. Implementa una fase cada vez.
4. Después de cada cambio ejecuta la prueba más específica posible.
5. Al final ejecuta formato, lint, typecheck, tests y build.
6. Si una integración externa no puede validarse sin credenciales, crea una prueba de integración claramente separada y documenta el paso manual.
7. No hagas cambios cosméticos ni refactors amplios que no sean necesarios.

Primera entrega:
- Corrige la reproducibilidad de npm/Deno.
- Implementa autenticación frontend.
- Implementa catálogo real desde Supabase.
- Implementa una página de detalle de clase.
- Implementa el reproductor de un solo vídeo.
- Añade pruebas para los estados de carga, error, acceso denegado, URL expirada y progreso.
- Actualiza README con comandos exactos de instalación, pruebas y despliegue.