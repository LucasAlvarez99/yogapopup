/** Error de la app con un código estable (el mismo que devuelven las Edge Functions). */
export class AppError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

const MESSAGES = {
  unauthenticated: 'Tu sesión venció. Inicia sesión de nuevo.',
  developer_only: 'Esta acción es solo para el equipo técnico.',
  admin_only: 'Esta acción es solo para el equipo de gestión.',
  no_access: 'Esta clase no está incluida en tu acceso actual.',
  class_not_found: 'No encontramos esta clase.',
  product_not_found: 'No encontramos este producto (quizá ya se eliminó). Actualiza la lista.',
  video_not_ready: 'Estamos preparando este video. Prueba de nuevo en unos minutos.',
  video_already_attached: 'Esta clase ya tiene un video en uso.',
  video_provider_error: 'El servicio de video no responde. Prueba de nuevo en un momento.',
  invalid_input: 'Revisa los datos ingresados.',
  sizes_invalid: 'Revisa los talles: hay un valor no válido (nombre repetido, vacío o stock fuera de rango).',
  image_too_large: 'La imagen pesa demasiado, incluso reducida. Prueba con otra más pequeña.',
  image_forbidden: 'Tu cuenta no tiene permiso para subir imágenes. Avisa al equipo técnico.',
  storage_missing: 'Falta el almacenamiento de imágenes en Supabase (bucket). Avisa al equipo técnico.',
  rate_limited: 'Demasiados intentos seguidos. Espera un minuto y prueba de nuevo.',
  video_invalid: 'El archivo se subió pero no es un video válido (vacío o de otro formato). Elige otro archivo y vuelve a intentar.',
  upload_unconfirmed: 'No pudimos confirmar que el video llegó completo. Vuelve a intentar la subida.',
  payload_too_large: 'Los datos enviados son demasiado grandes.',
  server_misconfigured: 'El servicio todavía no está configurado.',
  db_unavailable: 'El servicio no está disponible. Prueba de nuevo en un momento.',
  network: 'No pudimos conectar. Revisa tu conexión e intenta de nuevo.',
  not_configured: 'Falta configurar la conexión con Supabase (js/config.js).',
  session_full: 'Esta clase ya no tiene lugares.',
  session_started: 'Esta clase ya empezó.',
  session_not_found: 'No encontramos esta clase en vivo (quizá ya no está disponible).',
  coupon_unavailable: 'Ese cupón ya no se puede usar: ya lo usaste o venció a fin de mes.',
  coupon_not_virtual: 'El cupón de clase gratis vale para clases virtuales. Elige una clase virtual.',
  already_booked: 'Ya estás anotado/a en esa clase, así que no usamos tu cupón.',
  user_not_found: 'No encontramos a nadie con ese correo. La persona tiene que haberse registrado primero.',
  forbidden: 'No tienes permiso para hacer esto.',
  already_commented: 'Ya dejaste un comentario. Puedes editarlo desde esta misma sección.',
  invalid_testimonial: 'El comentario no es válido: tiene que tener entre 10 y 600 caracteres.',
  account_suspended: 'Tu cuenta está suspendida temporalmente por incumplir las normas de convivencia. Puedes volver a comentar cuando termine la suspensión.',
  payments_unavailable: 'No pudimos abrir PayPal. Si usas un bloqueador de anuncios, desactívalo para este sitio y prueba de nuevo.',
  payments_not_configured: 'Los pagos todavía no están disponibles. Prueba más tarde.',
  tier_unavailable: 'Ese nivel de suscripción todavía no está disponible. Elige otro o prueba más tarde.',
  tier_not_found: 'No encontramos ese nivel de suscripción.',
  invalid_price: 'El precio mensual tiene que estar entre 1 y 500 euros.',
  payment_provider_error: 'PayPal no responde en este momento. No se te cobró nada: prueba de nuevo en un minuto.',
  payment_declined: 'PayPal rechazó ese medio de pago. Prueba con otro.',
  payment_failed: 'El pago no se completó. No se te cobró nada.',
  payment_review: 'Estamos verificando tu pago. Si se cobró, te lo vamos a reflejar en unos minutos; no pagues de nuevo.',
  order_not_found: 'No encontramos ese pedido.',
  order_cancelled: 'Ese pedido se canceló. Crea uno nuevo.',
  order_not_approved: 'No llegaste a aprobar el pago en PayPal. Prueba de nuevo.',
  invalid_address: 'Revisa los datos de envío: alguno no es válido.',
  invalid_cart: 'Tu carrito cambió. Actualízalo y prueba de nuevo.',
  size_required: 'Elige un talle para ese producto.',
  product_unavailable: 'Alguno de los productos ya no está disponible. Actualiza tu carrito.',
  class_unavailable: 'Esta clase ya no se vende por separado.',
  insufficient_stock: 'No queda stock suficiente de alguno de los productos. Actualiza tu carrito.',
  already_owned: 'Ya tienes acceso a esta clase.',
  already_subscribed: 'Ya tienes una suscripción activa.',
  subscription_not_found: 'No encontramos esa suscripción.',
  subscription_invalid: 'Esa suscripción no corresponde al plan del sitio.',
  no_subscription: 'No tienes ninguna suscripción activa.',
  too_many_orders: 'Hiciste muchos intentos de compra seguidos. Espera unos minutos.',
  internal_error: 'Ocurrió un error inesperado. Prueba de nuevo.',
};

export function messageFor(err) {
  if (err instanceof AppError && MESSAGES[err.code]) return MESSAGES[err.code];
  if (err instanceof AppError && err.message && err.message !== err.code) return err.message;
  return MESSAGES.internal_error;
}

/**
 * Traduce el error de una función de la base (RPC) de la agenda a un AppError con mensaje claro.
 * Los códigos son los SQLSTATE que levantan las funciones de la migración 20261005120000.
 */
export function agendaError(error) {
  const code = String(error?.code ?? '');
  if (code === '23514') return new AppError('session_full');
  if (code === '22023') return new AppError(/not virtual/i.test(String(error?.message)) ? 'coupon_not_virtual' : 'session_started');
  if (code === '23505') return new AppError('already_booked');
  if (code === 'P0002') {
    const message = String(error?.message);
    if (/coupon unavailable/i.test(message)) return new AppError('coupon_unavailable');
    return new AppError(/user not found/i.test(message) ? 'user_not_found' : 'session_not_found');
  }
  if (code === '42501' || code === 'PGRST301') return new AppError(code === 'PGRST301' ? 'unauthenticated' : 'forbidden');
  if (/failed to fetch|network/i.test(String(error?.message))) return new AppError('network');
  return new AppError('internal_error', error?.message);
}
