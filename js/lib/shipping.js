/**
 * Envío (sin DOM ni red): provincias, validación del formulario de domicilio y cuentas del pedido.
 * El costo REAL del envío lo fija el servidor (shop_settings); acá solo se muestra. Se prueba en tests/web/shipping.test.js.
 */

export const SHIP_COUNTRY = 'ES';
export const SHIP_COUNTRY_NAME = 'España';

/** Illes Balears primero (de ahí es el negocio); después el resto por orden alfabético. */
export const PROVINCES = Object.freeze([
  'Illes Balears',
  'A Coruña', 'Álava', 'Albacete', 'Alicante', 'Almería', 'Asturias', 'Ávila', 'Badajoz', 'Barcelona', 'Burgos', 'Cáceres',
  'Cádiz', 'Cantabria', 'Castellón', 'Ceuta', 'Ciudad Real', 'Córdoba', 'Cuenca', 'Girona', 'Granada', 'Guadalajara',
  'Gipuzkoa', 'Huelva', 'Huesca', 'Jaén', 'La Rioja', 'Las Palmas', 'León', 'Lleida', 'Lugo', 'Madrid', 'Málaga', 'Melilla',
  'Murcia', 'Navarra', 'Ourense', 'Palencia', 'Pontevedra', 'Salamanca', 'Santa Cruz de Tenerife', 'Segovia', 'Sevilla',
  'Soria', 'Tarragona', 'Teruel', 'Toledo', 'Valencia', 'Valladolid', 'Bizkaia', 'Zamora', 'Zaragoza',
]);

export const SHIP_FIELDS = Object.freeze(['name', 'address_line_1', 'address_line_2', 'postal_code', 'city', 'region', 'phone', 'email']);

// Mismos límites que el servidor (supabase/functions/_shared/payments/request.ts > parseShipTo).
const PHONE_RE = /^\+?[0-9][0-9 ()-]{5,19}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const clean = (v) => String(v ?? '').trim().replace(/ +/g, ' ');

/**
 * Valida el formulario. Devuelve `{ ok, errors, value }`: `errors` por campo (mensajes para la persona) y `value` ya limpio
 * y con el país fijo, listo para mandar. La línea 2 es opcional.
 */
export function validateShipTo(form = {}) {
  const v = Object.fromEntries(SHIP_FIELDS.map((f) => [f, clean(form[f])]));
  const errors = {};
  if (v.name.length < 2) errors.name = 'Escribe tu nombre y apellido.';
  else if (v.name.length > 100) errors.name = 'El nombre es demasiado largo.';
  if (v.address_line_1.length < 3) errors.address_line_1 = 'Escribe la calle y el número.';
  else if (v.address_line_1.length > 120) errors.address_line_1 = 'La dirección es demasiado larga.';
  if (v.address_line_2.length > 120) errors.address_line_2 = 'Es demasiado largo.';
  if (!/^[0-9]{5}$/.test(v.postal_code)) errors.postal_code = 'El código postal tiene 5 números (ej. 07800).';
  if (v.city.length < 2) errors.city = 'Escribe la ciudad.';
  else if (v.city.length > 80) errors.city = 'El nombre de la ciudad es demasiado largo.';
  if (!PROVINCES.includes(v.region)) errors.region = 'Elige la provincia.';
  if (!PHONE_RE.test(v.phone)) errors.phone = 'Escribe un teléfono de contacto (ej. +34 600 111 222).';
  if (!EMAIL_RE.test(v.email) || v.email.length > 254) errors.email = 'Escribe un correo válido.';
  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { ...v, address_line_2: v.address_line_2 || null, country_code: SHIP_COUNTRY },
  };
}

/** Domicilio en líneas de texto (resumen del pago y panel). Acepta el de la persona (`ship_to`) o el de PayPal (`shipping`). */
export function shipToLines(s) {
  if (!s || typeof s !== 'object') return [];
  const place = [s.postal_code, s.city].filter(Boolean).join(' ');
  const region = [s.region, s.country_code === SHIP_COUNTRY ? SHIP_COUNTRY_NAME : s.country_code].filter(Boolean).join(', ');
  return [s.name, s.address_line_1, s.address_line_2, place, region].filter(Boolean).map(String);
}

/** Contacto del pedido en líneas ("Tel: …", "Mail: …"); vacío si no hay. */
export function shipContactLines(s) {
  if (!s || typeof s !== 'object') return [];
  return [s.phone ? `Tel: ${s.phone}` : '', s.email ? `Mail: ${s.email}` : ''].filter(Boolean);
}

/** Envío que se cobra: solo si el carrito tiene productos físicos; un costo inválido cuenta como 0. */
export function shippingFor(hasProducts, shippingCents) {
  const n = Number(shippingCents);
  return hasProducts && Number.isInteger(n) && n > 0 ? n : 0;
}

/** Cuentas que se muestran: compra + envío = total. (El IVA ya está incluido en cada precio; el del envío, al 21 %.) */
export function checkoutTotals(validation, shippingCents) {
  const ship = shippingFor(validation.hasProducts, shippingCents);
  const shipTax = ship > 0 ? Math.round((ship * 2100) / 12100) : 0;
  return {
    subtotalCents: validation.subtotalCents,
    shippingCents: ship,
    totalCents: validation.subtotalCents + ship,
    taxCents: validation.taxCents + shipTax,
  };
}
