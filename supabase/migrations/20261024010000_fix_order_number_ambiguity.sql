-- Fix SQLSTATE 42702 in create_order_secure. The RETURNS TABLE output variable
-- business_date can conflict with the counter table's business_date column in
-- an ON CONFLICT column list. Naming the primary-key constraint is unambiguous.
create or replace function public.create_order_secure(
  p_actor_id uuid,
  p_items jsonb,
  p_notes text,
  p_estimated_prep_minutes smallint,
  p_code_salt bytea,
  p_code_digest bytea,
  p_pepper_version smallint default 1
)
returns table (order_id uuid, business_date date, order_number smallint, estimated_ready_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
#variable_conflict use_column
declare
  v_business_date date;
  v_order_number smallint;
  v_order_id uuid := gen_random_uuid();
  v_ready_at timestamptz;
  v_item_count integer;
begin
  if not exists (select 1 from public.staff_members sm where sm.user_id = p_actor_id and sm.active) then
    raise exception 'staff_authorization_required' using errcode = '42501';
  end if;
  if p_estimated_prep_minutes not between 5 and 240 then raise exception 'invalid_prep_minutes'; end if;
  if p_notes is not null and char_length(p_notes) > 2000 then raise exception 'notes_too_long'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'invalid_order_items'; end if;
  v_item_count := jsonb_array_length(p_items);
  if v_item_count < 1 or v_item_count > 100 then raise exception 'invalid_order_items'; end if;
  if octet_length(p_code_salt) < 16 or octet_length(p_code_digest) <> 32 or p_pepper_version < 1 then
    raise exception 'invalid_verification_material';
  end if;

  v_business_date := public.current_restaurant_business_date();
  insert into public.daily_order_counters (business_date, last_order_number)
    values (v_business_date, 1)
    on conflict (business_date) do update
      set last_order_number = daily_order_counters.last_order_number + 1,
          updated_at = now()
      where daily_order_counters.last_order_number < 999
    returning last_order_number into v_order_number;
  if v_order_number is null then raise exception 'daily_order_number_limit_reached'; end if;

  v_ready_at := now() + make_interval(mins => p_estimated_prep_minutes);
  insert into public.orders (id, business_date, order_number, status, notes,
    estimated_prep_minutes, estimated_ready_at, created_by)
  values (v_order_id, v_business_date, v_order_number, 'received', nullif(btrim(p_notes), ''),
    p_estimated_prep_minutes, v_ready_at, p_actor_id);

  insert into public.order_items (order_id, item_name, quantity, position)
    select v_order_id, btrim(i.item_name), i.quantity, elem.ordinality - 1
    from jsonb_array_elements(p_items) with ordinality as elem(value, ordinality)
    cross join lateral jsonb_to_record(elem.value) as i(item_name text, quantity smallint)
    where char_length(btrim(i.item_name)) between 1 and 160
      and i.quantity between 1 and 99
      and elem.ordinality <= 100;
  if (select count(*) from public.order_items oi where oi.order_id = v_order_id) <> v_item_count then
    raise exception 'invalid_order_items';
  end if;

  insert into private.order_verification_secrets (order_id, code_salt, code_digest, pepper_version)
  values (v_order_id, p_code_salt, p_code_digest, p_pepper_version);

  return query select v_order_id, v_business_date, v_order_number, v_ready_at;
end;
$$;
revoke all on function public.create_order_secure(uuid, jsonb, text, smallint, bytea, bytea, smallint) from public, anon, authenticated;
grant execute on function public.create_order_secure(uuid, jsonb, text, smallint, bytea, bytea, smallint) to service_role;
