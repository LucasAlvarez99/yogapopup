/*
 * Configuración PÚBLICA del frontend (se descarga en el navegador de cualquier visitante).
 *
 * Estos valores NO son secretos: la "anon key" está pensada para el navegador y la protegen
 * las políticas RLS de la base. NUNCA pegar acá la service role key ni claves de R2:
 * esas viven solo en supabase/.env (backend).
 *
 * Completar con: Supabase > Project Settings > API.
 */
window.YOGAPOPUP_CONFIG = Object.freeze({
  SUPABASE_URL: 'https://txpiizhfzjajkeyycigb.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4cGlpemhmemphamtleXljaWdiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4ODc4NjQsImV4cCI6MjEwNTQ2Mzg2NH0.C0utCJT0607o9iKKC7E1q9PLN0_4SW2m13N_WIxEjXw',
  // Opcional (por defecto: SUPABASE_URL + '/functions/v1')
  FUNCTIONS_URL: 'https://txpiizhfzjajkeyycigb.supabase.co/functions/v1',
  // Dirección pública del sitio (ej.: 'https://tudominio.com', sin barra final). Es a donde vuelven los enlaces de los correos de
  // acceso (recuperar contraseña, confirmar cuenta). Vacío = vuelven a la página desde la que se pidió el correo; si se pidió
  // desde localhost, el enlace apunta a localhost y no abre en otro equipo. También hay que ponerla en Supabase > Authentication >
  // URL Configuration (Site URL y Redirect URLs).
  SITE_URL: '',
  // URL de la política de privacidad. Con valor, el registro exige aceptarla (RGPD/LOPDGDD) y guarda cuándo y qué versión.
  // Relativa al sitio ('privacidad.html') o una URL https completa.
  PRIVACY_URL: 'privacidad.html',
  // Responsable del tratamiento (lo muestra privacidad.html). COMPLETAR con los datos reales del titular del negocio:
  // mientras estén vacíos la página muestra "pendiente de completar" y `npm run doctor` lo avisa.
  LEGAL: {
    NAME: 'YogaPopup',     // nombre y apellidos, o razón social
    TAX_ID: '27-38902210-7',   // NIF / CIF
    ADDRESS: "Carrer Montnegre (o Carretera de l'Aeroport, km 4), 07817 Sant Jordi de ses Salines, Sant Josep de sa Talaia, Illes Balears, España.",  // domicilio (calle, número, código postal, localidad, provincia)
    EMAIL: 'Manuelaperuzzotti@gmail.com',    // correo para ejercer derechos de privacidad
  },
  // Pagos con PayPal (fases 17-22). Guía: docs/PAYPAL.md.
  //   CLIENT_ID: el "Client ID" de tu app de PayPal (Sandbox para pruebas, Live para cobrar). Es PÚBLICO: el SECRETO
  //              va solo en supabase/.env. Debe ser el mismo que PAYPAL_CLIENT_ID del backend.
  //   Vacío = no se muestran botones de pago (la tienda y las suscripciones quedan en "pronto").
  //   Los 3 niveles de suscripción (nombre, beneficios y precio) se editan desde el panel > Pagos > Planes de suscripción.
  PAYPAL: {
    CLIENT_ID: 'BAAVo6AljWRup6BRDRI31E_kuH6ZDJwIPJogr8-0t1YhC9SoTGdkTy_nxud3L3C8qbCgqh0bWu8dtCzAIo',
  },
  // Cada cuántos segundos de reproducción se guarda el progreso.
  PROGRESS_INTERVAL_SECONDS: 15,
});
