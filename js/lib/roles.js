/**
 * Las tres escalas de usuario. Solo ordena la interfaz (qué botones se muestran): el permiso real lo deciden
 * el servidor (Edge Functions) y la base de datos (RLS), que repiten estas reglas por su cuenta.
 *
 *   user       usuario final.
 *   admin      gestiona el contenido: editar, publicar/despublicar y borrar clases; productos. NO sube videos.
 *   developer  todo lo del admin + subir videos + cambiar roles + historial interno.
 */
export const ROLES = ['user', 'admin', 'developer'];

/** Personal de gestión: admin o developer. Cualquier otro valor (incluido el antiguo 'owner') NO tiene privilegios. */
export const isStaffRole = (role) => role === 'admin' || role === 'developer';
export const isDeveloperRole = (role) => role === 'developer';
/** Subir videos (crear clases, reintentar o reemplazar el video) es exclusivo del developer. */
export const canUploadRole = (role) => role === 'developer';

export const ROLE_LABELS = { user: 'Usuario', admin: 'Admin', developer: 'Developer' };
