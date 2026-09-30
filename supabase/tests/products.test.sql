-- Pruebas de la Fase 12: RLS y permisos de la tabla products.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado en la misma base (usa el mismo
-- helper t.raises). Usuarios PROPIOS (no se reutiliza a1/b1/etc.: roles_and_audit.test.sql los muta
-- a lo largo de sus propias pruebas de cambio de rol, igual que hace classes_publish_audit.test.sql).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a3', 'owner3@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000a4', 'comprador@test.dev', '{}');
update public.profiles set role = 'owner' where id = '00000000-0000-4000-8000-0000000000a3';

-- 1. Un producto activo lo ve cualquiera, incluso sin sesión (anon); uno inactivo, nadie salvo el dueño.
do $$ declare pid_active uuid; pid_draft uuid; begin
  insert into public.products (title, price_cents, is_active) values ('Mat de yoga', 2999, true) returning id into pid_active;
  insert into public.products (title, price_cents, is_active) values ('Bloque (borrador)', 1499, false) returning id into pid_draft;

  set local role anon;
  assert exists (select 1 from public.products where id = pid_active), 'anon debe ver un producto activo';
  assert not exists (select 1 from public.products where id = pid_draft), 'anon NO debe ver un producto inactivo';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  assert not exists (select 1 from public.products where id = pid_draft), 'un usuario común tampoco ve un producto inactivo';
  reset role;

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  assert exists (select 1 from public.products where id = pid_draft), 'el propietario sí ve los productos inactivos (para poder editarlos)';
  reset role;
end $$;

-- 2. Solo el propietario/desarrollador puede crear, editar y borrar productos.
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.products (title, price_cents) values ('intento de usuario común', 100) $q$, '42501');
  reset role;
end $$;

do $$ declare pid uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  insert into public.products (title, price_cents, is_active) values ('Remera', 1999, true) returning id into pid;
  reset role;

  -- Un usuario común no puede editar ni borrar (la fila no le es visible para UPDATE/DELETE: 0 filas
  -- afectadas, sin excepción, pero tampoco cambia nada).
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  update public.products set price_cents = 1 where id = pid;
  delete from public.products where id = pid;
  reset role;
  assert (select price_cents from public.products where id = pid) = 1999, 'un usuario común no puede editar el precio';
  assert exists (select 1 from public.products where id = pid), 'un usuario común no puede borrar el producto';

  -- El propietario sí puede.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  update public.products set price_cents = 1799 where id = pid;
  reset role;
  assert (select price_cents from public.products where id = pid) = 1799, 'el propietario sí puede editar el precio';
end $$;

-- 3. El precio nunca puede ser negativo (protege contra un error de cálculo en el carrito/checkout).
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  perform t.raises($q$ insert into public.products (title, price_cents) values ('precio inválido', -100) $q$, '23514');
  reset role;
end $$;

-- 4. updated_at se actualiza solo al editar (mismo trigger genérico que profiles). now() es fijo dentro de
--    una transacción, así que el alta y la edición van en bloques (= transacciones) separados.
create temp table _p4 (id uuid, t0 timestamptz);

do $$ declare pid uuid; t0 timestamptz; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  insert into public.products (title, price_cents) values ('Botella', 1200) returning id, updated_at into pid, t0;
  reset role;
  insert into _p4 values (pid, t0);
end $$;

select pg_sleep(0.05);

do $$ declare pid uuid; v_t0 timestamptz; v_t1 timestamptz; begin
  select id, t0 into pid, v_t0 from _p4;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  update public.products set title = 'Botella de agua' where id = pid;
  reset role;
  select updated_at into v_t1 from public.products where id = pid;
  assert v_t1 > v_t0, 'updated_at debe avanzar al editar';
end $$;

-- 5. Fase 13: la categoría es opcional, la escribe solo el propietario y no admite textos larguísimos.
do $$ declare pid uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  insert into public.products (title, price_cents, category, is_active) values ('Top deportivo', 3299, 'Ropa', true) returning id into pid;
  insert into public.products (title, price_cents) values ('Sin categoría', 500);
  perform t.raises(format($q$ update public.products set category = %L where id = %L $q$, repeat('x', 61), pid), '23514');
  reset role;
  assert (select category from public.products where id = pid) = 'Ropa', 'la categoría se guarda';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  update public.products set category = 'Hackeada' where id = pid;
  reset role;
  assert (select category from public.products where id = pid) = 'Ropa', 'un usuario común no puede cambiar la categoría';
end $$;

-- 6. Fase 14: el bucket de imágenes de producto es público con tope de tamaño/tipo, y solo el
--    propietario/desarrollador escribe. (Los usuarios a3 = owner y a4 = comprador se crearon arriba.)
do $$ declare b record; begin
  select * into b from storage.buckets where id = 'product-images';
  assert found, 'el bucket product-images debe existir';
  assert b.public, 'el bucket de imágenes de producto debe ser público (la tienda las muestra sin sesión)';
  assert b.file_size_limit = 2097152, 'tope de 2 MB por imagen';
  assert b.allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'], 'solo JPG, PNG y WebP';
end $$;

do $$ begin
  -- Un usuario común no puede subir (la política de insert lo rechaza).
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('product-images', 'x/intruso.webp') $q$, '42501');
  reset role;

  -- Tampoco alguien sin sesión (anon).
  set local role anon;
  perform t.raises($q$ insert into storage.objects (bucket_id, name) values ('product-images', 'x/anon.webp') $q$, '42501');
  reset role;

  -- El propietario sí puede subir.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  insert into storage.objects (bucket_id, name) values ('product-images', 'p1/foto.webp');
  reset role;
  assert exists (select 1 from storage.objects where bucket_id = 'product-images' and name = 'p1/foto.webp'),
    'el propietario debe poder subir una imagen de producto';
end $$;

do $$ begin
  -- Un usuario común no ve, no reemplaza y no borra objetos del bucket (0 filas afectadas, sin excepción).
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a4', true);
  set local role authenticated;
  assert not exists (select 1 from storage.objects where bucket_id = 'product-images'),
    'un usuario común no lista los objetos del bucket (las URL públicas no necesitan esta política)';
  update storage.objects set name = 'p1/hackeada.webp' where bucket_id = 'product-images';
  delete from storage.objects where bucket_id = 'product-images';
  reset role;
  assert exists (select 1 from storage.objects where bucket_id = 'product-images' and name = 'p1/foto.webp'),
    'un usuario común no puede renombrar ni borrar imágenes de producto';

  -- El propietario sí puede reemplazar y borrar.
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a3', true);
  set local role authenticated;
  update storage.objects set name = 'p1/nueva.webp' where bucket_id = 'product-images' and name = 'p1/foto.webp';
  reset role;
  assert exists (select 1 from storage.objects where bucket_id = 'product-images' and name = 'p1/nueva.webp'),
    'el propietario puede reemplazar una imagen';

  set local role authenticated;
  delete from storage.objects where bucket_id = 'product-images' and name = 'p1/nueva.webp';
  reset role;
  assert not exists (select 1 from storage.objects where bucket_id = 'product-images'),
    'el propietario puede borrar una imagen';
end $$;
