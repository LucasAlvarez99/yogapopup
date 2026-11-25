-- Cursos (serie de videos): forma de los datos, alta solo del developer, acceso heredado del curso y compra por el carrito.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuarios PROPIOS (aa..af).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000aa', 'curso-dev@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000ab', 'curso-admin@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000ac', 'curso-comprador@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000ad', 'curso-nivel1@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000ae', 'curso-nivel3@test.dev', '{}'),
  ('00000000-0000-4000-8000-0000000000af', 'curso-sin-acceso@test.dev', '{}');
update public.profiles set role = 'developer' where id = '00000000-0000-4000-8000-0000000000aa';
update public.profiles set role = 'admin'     where id = '00000000-0000-4000-8000-0000000000ab';

create table t.coursetest (name text primary key, id uuid);
grant all on t.coursetest to public;
create function t.crsid(n text) returns uuid language sql as $$ select id from t.coursetest where name = n $$;
grant execute on function t.crsid(text) to public;

-- 1. Crear un curso: solo el developer; nace sin publicar, sin video propio y queda auditado
do $$ declare cid uuid; begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
  set local role authenticated;
  cid := public.create_course('Curso de Vinyasa', '  Seis videos  ', 'Vinyasa', 'principiante', 'restricted', 2::smallint, 5);
  reset role;
  insert into t.coursetest values ('pago', cid);

  assert (select kind = 'course' and video_status = 'ready' and r2_object_key is null and not is_published
                 and access_level = 'restricted' and min_tier = 2 and sort_order = 5
                 and description = 'Seis videos' and category = 'Vinyasa' and level = 'principiante'
            from public.classes where id = cid), 'el curso nace con sus datos, sin publicar y sin video propio';
  assert exists (select 1 from public.audit_log where action = 'course.create' and entity_id = cid::text
                    and actor_id = '00000000-0000-4000-8000-0000000000aa' and actor_role = 'developer'), 'crear un curso queda auditado';

  -- El admin y una persona común no crean cursos (igual que no suben videos)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ab', true);
  set local role authenticated;
  perform t.raises($q$ select public.create_course('Curso del admin', null, null, null, null, null, null) $q$, '42501');
  reset role;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000af', true);
  set local role authenticated;
  perform t.raises($q$ select public.create_course('Curso de un usuario', null, null, null, null, null, null) $q$, '42501');
  reset role;
  set local role anon;
  perform t.raises($q$ select public.create_course('Curso anónimo', null, null, null, null, null, null) $q$, '42501');
  reset role;

  -- Datos inválidos: los rechazan las restricciones de la tabla
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000aa', true);
  set local role authenticated;
  perform t.raises($q$ select public.create_course('', null, null, null, null, null, null) $q$, '23514');
  perform t.raises($q$ select public.create_course('x', null, null, 'experto', null, null, null) $q$, '23514');
  perform t.raises($q$ select public.create_course('x', null, null, null, null, 9::smallint, null) $q$, '23514');
  reset role;
end $$;

-- 2. Forma: un curso no tiene video propio ni cuelga de otro; el padre de un video tiene que ser un curso
do $$ declare cid uuid := t.crsid('pago'); v uuid; begin
  perform t.raises($q$ insert into public.classes (title, kind, video_status, r2_object_key) values ('curso con video', 'course', 'ready', 'k/x') $q$, '23514');
  perform t.raises($q$ insert into public.classes (title, kind, video_status) values ('curso sin listo', 'course', 'pending') $q$, '23514');
  perform t.raises($q$ insert into public.classes (title, kind) values ('tipo raro', 'serie') $q$, '23514');
  perform t.raises(format($q$ insert into public.classes (title, kind, video_status, course_id) values ('curso dentro de curso', 'course', 'ready', %L) $q$, cid), '23514');

  insert into public.classes (title, video_status, r2_object_key) values ('Video suelto', 'ready', 'k/suelto') returning id into v;
  perform t.raises(format($q$ insert into public.classes (title, course_id) values ('hijo de un video', %L) $q$, v), '23514');

  -- Videos del curso: cantidad ilimitada, con su orden
  for i in 1..12 loop
    insert into public.classes (title, video_status, r2_object_key, course_id, sort_order, is_published)
      values ('Clase ' || i, 'ready', 'k/pago-' || i, cid, i, true);
  end loop;
  assert (select count(*) from public.classes where course_id = cid) = 12, 'un curso admite muchos videos';
  insert into public.classes (title, video_status, r2_object_key, course_id, sort_order, is_published)
    values ('Clase 13 (agregada después)', 'ready', 'k/pago-13', cid, 13, true);
  assert (select count(*) from public.classes where course_id = cid) = 13, 'se pueden sumar videos más adelante';

  -- Con videos adentro el curso no se borra
  perform t.raises(format($q$ delete from public.classes where id = %L $q$, cid), '23503');

  -- Ni el navegador puede cambiar el tipo o el curso de una clase
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ab', true);
  set local role authenticated;
  perform t.raises(format($q$ update public.classes set course_id = %L where id = %L $q$, cid, v), '42501');
  perform t.raises(format($q$ update public.classes set kind = 'course' where id = %L $q$, v), '42501');
  reset role;
end $$;

-- 3. Lectura pública: kind y course_id se ven sin sesión (la key de R2 sigue restringida)
do $$ begin
  update public.classes set is_published = true where id = t.crsid('pago');
  set local role anon;
  assert (select count(*) from public.classes where course_id = t.crsid('pago')) = 13, 'el catálogo público ve los videos del curso';
  assert (select kind from public.classes where id = t.crsid('pago')) = 'course', 'y el tipo';
  perform t.raises($q$ select r2_object_key from public.classes limit 1 $q$, '42501');
  reset role;
end $$;

-- 4. Acceso: manda el curso (nivel 2, 50 €), no el video
do $$ declare lesson uuid; other uuid; begin
  select id into lesson from public.classes where course_id = t.crsid('pago') and sort_order = 3;
  select id into other  from public.classes where course_id = t.crsid('pago') and sort_order = 9;
  insert into t.coursetest values ('leccion3', lesson), ('leccion9', other);
  update public.classes set price_cents = 5000, tax_rate_bps = 2100 where id = t.crsid('pago');
  insert into public.classes (title, access_level, video_status, r2_object_key, is_published, price_cents, tax_rate_bps)
    values ('Otro video restringido', 'restricted', 'ready', 'k/otro-restringido', true, 1000, 2100) returning id into other;
  insert into t.coursetest values ('ajeno', other);

  insert into public.entitlements (user_id, scope, tier, source, external_ref, expires_at)
    values ('00000000-0000-4000-8000-0000000000ad', 'all', 1, 'paypal', 'I-CURSO-1', now() + interval '20 days'),
           ('00000000-0000-4000-8000-0000000000ae', 'all', 3, 'paypal', 'I-CURSO-3', now() + interval '20 days');

  -- Sin suscripción: nada
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000af', true);
  set local role authenticated;
  assert not public.can_access_class(t.crsid('leccion3')), 'sin acceso al curso no ve sus videos';
  reset role;
  -- Nivel 1 no alcanza (el curso pide nivel 2)
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ad', true);
  set local role authenticated;
  assert not public.can_access_class(t.crsid('leccion3')), 'el nivel 1 no ve un curso de nivel 2';
  reset role;
  -- Nivel 3 ve todo el curso
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ae', true);
  set local role authenticated;
  assert public.can_access_class(t.crsid('leccion3')) and public.can_access_class(t.crsid('leccion9')), 'el nivel 3 ve todos los videos del curso';
  reset role;
  -- Admin: todo
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ab', true);
  set local role authenticated;
  assert public.can_access_class(t.crsid('leccion3')), 'el admin ve todo';
  reset role;
  -- Sin sesión: ni se puede consultar (la función no es ejecutable por anon)
  set local role anon;
  perform t.raises(format($q$ select public.can_access_class(%L) $q$, t.crsid('leccion3')), '42501');
  reset role;
end $$;

-- 5. Comprar el curso suelto por el carrito: da acceso a TODOS sus videos (también a los que se agreguen después)
do $$ declare o uuid; e public.entitlements; late uuid; begin
  o := public.payments_create_order('00000000-0000-4000-8000-0000000000ac', format('[{"type":"class","id":"%s"}]', t.crsid('pago'))::jsonb);
  assert (select total_cents from public.orders where id = o) = 5000, 'el curso se cobra con su precio';
  assert (select count(*) from public.order_items where order_id = o and class_id = t.crsid('pago')) = 1, 'un solo ítem: el curso';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ac', true);
  set local role authenticated;
  assert not public.can_access_class(t.crsid('leccion3')), 'antes de pagar no ve los videos';
  reset role;

  assert public.payments_mark_paid(o, 'CAP-CURSO1', 5000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'pagado';
  select * into e from public.entitlements where source = 'paypal' and external_ref like o::text || ':%';
  assert e.scope = 'class' and e.class_id = t.crsid('pago'), 'el acceso es al curso';
  assert e.expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour', 'dura 30 días como una clase suelta';

  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ac', true);
  set local role authenticated;
  assert public.can_access_class(t.crsid('leccion3')) and public.can_access_class(t.crsid('leccion9')), 've los videos del curso';
  assert not public.can_access_class(t.crsid('ajeno')), 'pero no un video que no es del curso';
  reset role;

  -- Un video agregado después queda cubierto sin volver a pagar
  insert into public.classes (title, video_status, r2_object_key, course_id, sort_order, is_published)
    values ('Clase 14 (nueva)', 'ready', 'k/pago-14', t.crsid('pago'), 14, true) returning id into late;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ac', true);
  set local role authenticated;
  assert public.can_access_class(late), 'los videos nuevos del curso ya están incluidos';
  reset role;

  -- Con el acceso vigente no se vuelve a comprar; vencido, sí
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000ac', '[{"type":"class","id":"%s"}]'::jsonb) $q$, t.crsid('pago')), '23505');
  update public.entitlements set expires_at = now() - interval '1 minute' where id = e.id;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ac', true);
  set local role authenticated;
  assert not public.can_access_class(t.crsid('leccion3')), 'vencido: vuelve a bloquearse';
  reset role;

  -- Reembolso total: se quita el acceso
  update public.entitlements set expires_at = now() + interval '5 days' where id = e.id;
  assert public.payments_apply_refund(o, 'REF-CURSO1', 5000) = 'applied', 'reembolsado';
  assert not exists (select 1 from public.entitlements where source = 'paypal' and external_ref like o::text || ':%'), 'el reembolso quita el acceso al curso';
end $$;

-- 6. Curso sin publicar: ni el comprador ve sus videos; un curso gratis lo ve cualquiera con sesión
do $$ declare c uuid; l uuid; begin
  update public.classes set access_level = 'free' where id = t.crsid('pago');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000af', true);
  set local role authenticated;
  assert public.can_access_class(t.crsid('leccion3')), 'curso gratis: cualquiera con sesión ve sus videos';
  reset role;

  update public.classes set is_published = false where id = t.crsid('pago');
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000af', true);
  set local role authenticated;
  assert not public.can_access_class(t.crsid('leccion3')), 'curso sin publicar: sus videos no se ven';
  reset role;
  update public.classes set is_published = true where id = t.crsid('pago');

  -- Un video SUELTO sigue funcionando como siempre (regresión)
  insert into public.classes (title, access_level, video_status, r2_object_key, is_published)
    values ('Video libre', 'free', 'ready', 'k/libre', true) returning id into l;
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000af', true);
  set local role authenticated;
  assert public.can_access_class(l), 'un video suelto gratis se sigue viendo';
  assert not public.can_access_class(t.crsid('ajeno')), 'un video suelto restringido sigue bloqueado';
  reset role;
end $$;
