-- =============================================================================
-- Endurece los datos que un profesor escribe en su perfil público (lo ve cualquier visitante de la home).
-- La web ya valida estos límites, pero la base es la que manda: alguien con sesión de profesor puede hablarle
-- a la API directamente, saltándose el formulario.
--   · photo_url: solo https (nunca javascript:, data: ni http), sin espacios.
--   · specialties: cada una de 1 a 30 caracteres (antes solo se limitaba la cantidad: 8 textos gigantes pasaban).
-- =============================================================================
create or replace function public.teacher_specialties_ok(p_items text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(char_length(btrim(s)) between 1 and 30), true) from unnest(p_items) as s;
$$;

alter table public.teachers
  add constraint teachers_photo_url_https_chk check (photo_url is null or photo_url ~ '^https://[^[:space:]]+$'),
  add constraint teachers_specialties_len_chk check (public.teacher_specialties_ok(specialties));
