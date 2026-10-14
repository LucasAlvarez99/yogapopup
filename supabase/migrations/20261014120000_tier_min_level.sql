-- =============================================================================
-- YogaPop Up · Niveles acumulativos: cada clase pide un NIVEL MÍNIMO
--
--   Regla de negocio:
--     Nivel 1  ve todas las clases menos las marcadas para nivel 2 o 3.
--     Nivel 2  ve todo lo del nivel 1 + las marcadas para nivel 2.
--     Nivel 3  ve el 100 % de las clases, sin excepciones.
--   Antes (20261013120000) cada clase guardaba una lista de niveles (access_tiers). Esa lista dejaba que una clase
--   quedara fuera del nivel 3 (por ejemplo '{1}'), y el negocio no lo quiere. Pasa a una sola columna: min_tier.
--   Un acceso manual sin nivel (entitlements.tier null) sigue valiendo para todo. Las clases sueltas no dependen del nivel.
-- =============================================================================

-- 1. Columna nueva, con los datos actuales convertidos (el nivel más bajo que antes la veía)
alter table public.classes
  add column min_tier smallint not null default 1
    constraint classes_min_tier_chk check (min_tier between 1 and 3);

update public.classes c
   set min_tier = (select min(t) from unnest(c.access_tiers) as t);

comment on column public.classes.min_tier is
  'Nivel de suscripción mínimo para ver esta clase (solo importa si access_level = restricted). 1 = todos los niveles; el nivel 3 ve siempre todo.';

-- 2. La lista anterior se elimina para no tener dos fuentes de verdad
alter table public.classes drop column access_tiers;

grant select (min_tier) on public.classes to authenticated;
grant insert (min_tier) on public.classes to authenticated;
grant update (min_tier) on public.classes to authenticated;

-- 3. Regla de acceso (la misma en web y backend)
create or replace function public.can_access_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.is_admin()
    or exists (
      select 1
      from public.classes c
      where c.id = p_class_id
        and c.is_published
        and c.video_status = 'ready'
        and auth.uid() is not null
        and (
          c.access_level = 'free'
          or exists (
            select 1 from public.entitlements e
            where e.user_id = auth.uid()
              and (e.expires_at is null or e.expires_at > now())
              and (
                (e.scope = 'all' and (e.tier is null or e.tier >= c.min_tier))
                or (e.scope = 'class' and e.class_id = c.id)
              )
          )
        )
    );
$$;

create or replace function public.payments_has_class_access(p_user uuid, p_class uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.entitlements e
    where e.user_id = p_user
      and (e.expires_at is null or e.expires_at > now())
      and (
        (e.scope = 'all' and (e.tier is null or exists (
           select 1 from public.classes c where c.id = p_class and e.tier >= c.min_tier)))
        or (e.scope = 'class' and e.class_id = p_class)
      )
  );
$$;
