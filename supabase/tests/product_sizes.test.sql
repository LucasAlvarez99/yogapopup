-- Talles con stock por talle e IVA por producto (migración 20261004120000).
-- Requiere el helper t.raises de tests/roles_and_audit.test.sql. Usuarios propios (ids ...0e*).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-000000000ea1', 'sz-user@test.dev',  '{}'),
  ('00000000-0000-4000-8000-000000000ea2', 'sz-admin@test.dev', '{}'),
  ('00000000-0000-4000-8000-000000000ea3', 'sz-dev@test.dev',   '{}');
update public.profiles set role = 'admin'     where id = '00000000-0000-4000-8000-000000000ea2';
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-000000000ea3';

create table t.sz (name text primary key, id uuid);
insert into public.products (title, price_cents, is_active) values ('sz-activo', 3500, true), ('sz-oculto', 3500, false), ('sz-otro', 1000, true);
insert into t.sz select title, id from public.products where title like 'sz-%';
grant select on t.sz to public;
create function t.pid(n text) returns uuid language sql as $$ select id from t.sz where name = n $$;
grant execute on function t.pid(text) to public;

-- =============================================================================
-- 1. IVA por producto: 21 % por defecto, rango válido, y el personal puede cambiarlo (con rastro)
-- =============================================================================
do $$ begin
  assert (select tax_rate_bps from public.products where id = t.pid('sz-activo')) = 2100, 'por defecto 21 %';
  perform t.raises($q$ update public.products set tax_rate_bps = -1 where id = t.pid('sz-activo') $q$, '23514');
  perform t.raises($q$ update public.products set tax_rate_bps = 2501 where id = t.pid('sz-activo') $q$, '23514');
  perform t.raises($q$ insert into public.products (title, price_cents, tax_rate_bps) values ('mal iva', 100, 99999) $q$, '23514');

  -- el usuario común no lo cambia
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea1', true);
  set local role authenticated;
  update public.products set tax_rate_bps = 0 where id = t.pid('sz-activo');
  reset role;
  assert (select tax_rate_bps from public.products where id = t.pid('sz-activo')) = 2100, 'el usuario común no cambia el IVA (RLS)';

  -- el admin sí; queda auditado con actor y valores
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  update public.products set tax_rate_bps = 1000 where id = t.pid('sz-activo');
  update public.products set tax_rate_bps = 1000 where id = t.pid('sz-activo');   -- mismo valor: no audita
  insert into public.products (title, price_cents, tax_rate_bps) values ('sz-con-iva-0', 500, 0);
  reset role;
  assert (select count(*) from public.audit_log where entity_id = t.pid('sz-activo')::text and action = 'product.tax_change') = 1, 'un solo cambio de IVA auditado';
  assert (select details from public.audit_log where entity_id = t.pid('sz-activo')::text and action = 'product.tax_change') = '{"to": 1000, "from": 2100, "title": "sz-activo"}'::jsonb, 'valores anterior y nuevo';
  assert (select actor_id from public.audit_log where entity_id = t.pid('sz-activo')::text and action = 'product.tax_change') = '00000000-0000-4000-8000-000000000ea2', 'y quién lo hizo';
  assert (select tax_rate_bps from public.products where title = 'sz-con-iva-0') = 0, 'se puede crear exento';
  update public.products set tax_rate_bps = 2100 where id = t.pid('sz-activo');
end $$;

-- =============================================================================
-- 2. Quién puede guardar talles: solo admin y developer, y SOLO por la función
-- =============================================================================
do $$ begin
  set local role anon;
  perform t.raises(format($q$ select * from public.save_product_variants(%L, '[]') $q$, t.pid('sz-activo')), '42501');
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea1', true);
  set local role authenticated;
  perform t.raises(format($q$ select * from public.save_product_variants(%L, '[{"size":"M"}]') $q$, t.pid('sz-activo')), '42501');
  reset role;

  -- ni siquiera el personal escribe la tabla directamente
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  perform t.raises(format($q$ insert into public.product_variants (product_id, size) values (%L, 'S') $q$, t.pid('sz-activo')), '42501');
  perform t.raises($q$ update public.product_variants set stock = 99 $q$, '42501');
  perform t.raises($q$ delete from public.product_variants $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea3', true);
  set local role authenticated;
  perform t.raises(format($q$ insert into public.product_variants (product_id, size) values (%L, 'S') $q$, t.pid('sz-activo')), '42501');
  reset role;
  assert not exists (select 1 from public.product_variants), 'nada se escribió';
end $$;

-- =============================================================================
-- 3. Guardar, reordenar, conservar ids, quitar
-- =============================================================================
do $$
declare ids_before uuid[]; ids_after uuid[]; r record; n int;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;

  -- alta: el orden del arreglo es el orden en pantalla; stock null = sin control
  select count(*) into n from public.save_product_variants(t.pid('sz-activo'),
    '[{"size":"S","stock":3},{"size":"M","stock":5},{"size":"L","stock":0},{"size":"XL","stock":null},{"size":"2XL"}]');
  assert n = 5, 'devuelve los 5 talles';
  reset role;
  assert (select string_agg(size, ',' order by sort_order) from public.product_variants where product_id = t.pid('sz-activo')) = 'S,M,L,XL,2XL', 'orden respetado';
  assert (select stock from public.product_variants where product_id = t.pid('sz-activo') and size = 'L') = 0, 'L agotado';
  assert (select stock from public.product_variants where product_id = t.pid('sz-activo') and size = 'XL') is null, 'XL sin control de stock';
  assert (select stock from public.product_variants where product_id = t.pid('sz-activo') and size = '2XL') is null, 'sin "stock" = sin control';

  -- edición: los talles que siguen CONSERVAN su id; se quita L, se agrega 3XL, cambia el orden y los stocks
  select array_agg(id order by lower(size)) into ids_before from public.product_variants where product_id = t.pid('sz-activo') and lower(size) in ('s', 'm', 'xl');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea3', true);
  set local role authenticated;
  perform public.save_product_variants(t.pid('sz-activo'),
    '[{"size":"XL","stock":2},{"size":" m ","stock":9},{"size":"S","stock":3},{"size":"3XL","stock":1},{"size":"2XL"}]');
  reset role;
  select array_agg(id order by lower(size)) into ids_after from public.product_variants where product_id = t.pid('sz-activo') and lower(size) in ('s', 'm', 'xl');
  assert ids_before = ids_after, 'los ids de los talles que siguen no cambian (los carritos y pedidos los usan)';
  assert (select string_agg(size, ',' order by sort_order) from public.product_variants where product_id = t.pid('sz-activo')) = 'XL,m,S,3XL,2XL',
    'nuevo orden; "m" con espacios se limpia y adopta la grafía enviada';
  assert not exists (select 1 from public.product_variants where product_id = t.pid('sz-activo') and size = 'L'), 'L se quitó';
  assert (select stock from public.product_variants where product_id = t.pid('sz-activo') and lower(size) = 'm') = 9, 'stock actualizado';

  -- no toca los talles de OTRO producto
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  perform public.save_product_variants(t.pid('sz-otro'), '[{"size":"Única","stock":4}]');
  perform public.save_product_variants(t.pid('sz-activo'), '[{"size":"XL","stock":2},{"size":"M","stock":9}]');
  reset role;
  assert (select count(*) from public.product_variants where product_id = t.pid('sz-otro')) = 1, 'el otro producto intacto';
  assert (select count(*) from public.product_variants where product_id = t.pid('sz-activo')) = 2, 'se quitaron los que no vinieron';

  -- lista vacía = sin talles
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  select count(*) into n from public.save_product_variants(t.pid('sz-otro'), '[]');
  reset role;
  assert n = 0 and not exists (select 1 from public.product_variants where product_id = t.pid('sz-otro')), 'vacío quita todos';
end $$;

-- =============================================================================
-- 4. Validaciones: todo o nada (si UNA fila es inválida no se escribe ninguna)
-- =============================================================================
do $$
declare pid uuid := t.pid('sz-activo'); bad text; before_ids uuid[];
begin
  select array_agg(id order by id) into before_ids from public.product_variants where product_id = pid;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  foreach bad in array array[
    '[{"size":"S"},{"size":"s"}]',                                   -- repetido sin importar mayúsculas
    '[{"size":"S"},{"size":" S "}]',                                 -- repetido tras limpiar espacios
    '[{"size":""}]', '[{"size":"   "}]',                             -- vacío
    '[{"size":"123456789012345678901"}]',                            -- 21 caracteres
    '[{"size":"M","stock":-1}]', '[{"size":"M","stock":1.5}]', '[{"size":"M","stock":1000001}]',
    '[{"size":"M","stock":"5"}]', '[{"size":"M","stock":true}]',     -- tipo incorrecto
    '[{"size":5}]', '[{"size":null}]', '[{"stock":3}]', '["M"]', '[1]', '[null]',
    '{"size":"M"}', '"M"', 'null', '5',                              -- no es un arreglo
    '[{"size":"a\tb"}]'                                              -- carácter de control
  ] loop
    begin
      perform public.save_product_variants(pid, bad::jsonb);
      raise exception 'debió rechazar: %', bad;
    exception when sqlstate '22023' then null;
    end;
  end loop;
  -- demasiados talles (21)
  begin
    perform public.save_product_variants(pid, (select jsonb_agg(jsonb_build_object('size', 'T' || g)) from generate_series(1, 21) g));
    raise exception 'debió rechazar 21 talles';
  exception when sqlstate '22023' then null;
  end;
  -- 20 sí
  perform public.save_product_variants(pid, (select jsonb_agg(jsonb_build_object('size', 'T' || g, 'stock', g)) from generate_series(1, 20) g));
  assert (select count(*) from public.product_variants where product_id = pid) = 20, '20 talles es el tope y entra';
  -- producto inexistente
  perform t.raises($q$ select * from public.save_product_variants(gen_random_uuid(), '[]') $q$, 'P0002');
  perform t.raises($q$ select * from public.save_product_variants(null, '[]') $q$, 'P0002');
  perform t.raises(format($q$ select * from public.save_product_variants(%L, null) $q$, pid), '22023');
  reset role;

  -- los rechazos no dejaron escrituras a medias: antes de los 20 estaban XL y M; ahora los 20 de T1..T20
  assert not exists (select 1 from public.product_variants where product_id = pid and size = 'XL'), 'se reemplazó el conjunto (ya no están XL/M)';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  perform public.save_product_variants(pid, '[{"size":"S","stock":3},{"size":"M","stock":5}]');
  begin
    perform public.save_product_variants(pid, '[{"size":"S","stock":99},{"size":"M","stock":-5}]');   -- la 2.ª es inválida
  exception when sqlstate '22023' then null;
  end;
  reset role;
  assert (select stock from public.product_variants where product_id = pid and size = 'S') = 3, 'la fila válida NO se aplicó: todo o nada';
  assert (select count(*) from public.product_variants where product_id = pid) = 2, 'y no se borró nada';
end $$;

-- =============================================================================
-- 5. Quién ve los talles
-- =============================================================================
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  perform public.save_product_variants(t.pid('sz-oculto'), '[{"size":"S","stock":1}]');
  reset role;

  set local role anon;
  assert (select count(*) from public.product_variants where product_id = t.pid('sz-activo')) = 2, 'el público ve los talles de un producto activo';
  assert not exists (select 1 from public.product_variants where product_id = t.pid('sz-oculto')), 'y NO los de un producto oculto';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea1', true);
  set local role authenticated;
  assert not exists (select 1 from public.product_variants where product_id = t.pid('sz-oculto')), 'un usuario común tampoco';
  assert (select count(*) from public.product_variants where product_id = t.pid('sz-activo')) = 2, 'pero sí los del producto activo';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000ea2', true);
  set local role authenticated;
  assert exists (select 1 from public.product_variants where product_id = t.pid('sz-oculto')), 'el admin ve los talles de un producto oculto';
  reset role;
end $$;

-- =============================================================================
-- 6. Si el producto se oculta, sus talles dejan de verse; si se borra, se borran con él
-- =============================================================================
do $$ begin
  update public.products set is_active = false where id = t.pid('sz-activo');
  set local role anon;
  assert not exists (select 1 from public.product_variants where product_id = t.pid('sz-activo')), 'ocultar el producto oculta sus talles';
  reset role;
  update public.products set is_active = true where id = t.pid('sz-activo');

  delete from public.products where id = t.pid('sz-otro');
  assert not exists (select 1 from public.product_variants where product_id = t.pid('sz-otro')), 'borrar el producto borra sus talles';
end $$;
