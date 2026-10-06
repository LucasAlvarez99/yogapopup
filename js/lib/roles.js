/**
 * Las cuatro escalas de usuario. Solo ordena la interfaz (qué botones se muestran): el permiso real lo deciden
 * el servidor (Edge Functions) y la base de datos (RLS), que repiten estas reglas por su cuenta.
 *
 *   user       usuario final: ve el sitio, reserva clases en vivo, compra.
 *   profesor   da clases: edita SU perfil (foto, bio) y gestiona SU agenda. NO es gestión: no toca productos ni videos.
 *   admin      gestiona el contenido: editar, publicar/despublicar y borrar clases; productos. NO sube videos.
 *   developer  todo lo del admin + subir videos + cambiar roles + historial interno.
 */
export const ROLES = ['user', 'profesor', 'admin', 'developer'];

/** Personal de gestión: admin o developer. Cualquier otro valor (incluido el antiguo 'owner') NO tiene privilegios. */
export const isStaffRole = (role) => role === 'admin' || role === 'developer';
export const isDeveloperRole = (role) => role === 'developer';
/** Subir videos (crear clases, reintentar o reemplazar el video) es exclusivo del developer. */
export const canUploadRole = (role) => role === 'developer';

/**
 * Profesor por ROL (alguien que solo enseña). Ojo: un admin o developer también puede dar clases (Manu): eso lo dice
 * su perfil de profesor (tabla `teachers`, ver session.isTeacher()), no el rol.
 */
export const isProfesorRole = (role) => role === 'profesor';

export const ROLE_LABELS = { user: 'Usuario', profesor: 'Profesor', admin: 'Admin', developer: 'Developer' };
