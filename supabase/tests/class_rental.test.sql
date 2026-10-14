-- Clases sueltas: el acceso dura 30 días desde el pago y, vencido, se vuelve a comprar.
-- Requiere el esquema de tests/roles_and_audit.test.sql ya aplicado (helper t.raises). Usuario PROPIO (b7).

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000b7', 'alquiler@test.dev', '{}');

do $$ declare c uuid; o uuid; o2 uuid; e public.entitlements; begin
  insert into public.classes (title, access_level, video_status, is_published, r2_object_key, price_cents, tax_rate_bps)
    values ('Clase de alquiler', 'restricted', 'ready', true, 'k/alquiler', 1000, 2100) returning id into c;

  o := public.payments_create_order('00000000-0000-4000-8000-0000000000b7', format('[{"type":"class","id":"%s"}]', c)::jsonb);
  assert public.payments_mark_paid(o, 'CAP-ALQ1', 1000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'pagado';

  -- Vence a los 30 días del pago
  select * into e from public.entitlements where source = 'paypal' and external_ref like o::text || ':%';
  assert e.scope = 'class' and e.class_id = c, 'acceso a esa clase';
  assert e.expires_at between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour', 'vence a los 30 días';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b7', c), 'durante los 30 días tiene acceso';

  -- Con el acceso vigente no se vuelve a comprar
  perform t.raises(format($q$ select public.payments_create_order('00000000-0000-4000-8000-0000000000b7', '[{"type":"class","id":"%s"}]'::jsonb) $q$, c), '23505');

  -- Pasados los 30 días: bloqueada (web y backend)
  update public.entitlements set expires_at = now() - interval '1 minute' where source = 'paypal' and external_ref like o::text || ':%';
  assert not public.payments_has_class_access('00000000-0000-4000-8000-0000000000b7', c), 'vencido: sin acceso (backend)';
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000b7', true);
  set local role authenticated;
  assert not public.can_access_class(c), 'vencido: sin acceso (web)';
  reset role;

  -- Se vuelve a comprar y se renueva por otros 30 días (el alquiler viejo queda como historial)
  o2 := public.payments_create_order('00000000-0000-4000-8000-0000000000b7', format('[{"type":"class","id":"%s"}]', c)::jsonb);
  assert public.payments_mark_paid(o2, 'CAP-ALQ2', 1000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'paid', 'recompra pagada';
  assert public.payments_has_class_access('00000000-0000-4000-8000-0000000000b7', c), 'recomprada: vuelve a tener acceso';
  assert (select expires_at from public.entitlements where source = 'paypal' and external_ref like o2::text || ':%') > now() + interval '29 days', 'otros 30 días';
  assert (select count(*) from public.entitlements where user_id = '00000000-0000-4000-8000-0000000000b7' and class_id = c) = 2, 'un acceso por compra';
  assert public.payments_mark_paid(o2, 'CAP-ALQ2', 1000, 'EUR', 'P', null, 'COMPLETED', 'COMPLETED') = 'already_paid', 'idempotente: no duplica ni extiende';

  -- Reembolso total de la recompra: se quita ESE acceso
  assert public.payments_apply_refund(o2, 'REF-ALQ', 1000) = 'applied';
  assert not public.payments_has_class_access('00000000-0000-4000-8000-0000000000b7', c), 'reembolsada: sin acceso';
end $$;
