-- Private customer verification and grant-scoped order retrieval.
-- All callable functions are restricted to service_role and invoked by Edge Functions.

create or replace function public.get_order_verification_material(p_order_number smallint)
returns table (
  order_id uuid,
  code_salt bytea,
  code_digest bytea,
  pepper_version smallint,
  code_version integer
)
language sql
security definer
set search_path = pg_catalog, public, private
as $$
  select o.id, s.code_salt, s.code_digest, s.pepper_version, o.tracking_code_version
  from public.orders o
  join private.order_verification_secrets s on s.order_id = o.id
  where o.business_date = public.current_restaurant_business_date()
    and o.order_number = p_order_number
    and o.created_at > now() - interval '30 days'
  limit 1;
$$;
revoke all on function public.get_order_verification_material(smallint) from public, anon, authenticated;
grant execute on function public.get_order_verification_material(smallint) to service_role;

create or replace function public.record_tracking_verification(
  p_order_number smallint,
  p_expected_order_id uuid,
  p_auth_user_id uuid,
  p_ip_hash bytea,
  p_candidate_valid boolean,
  p_code_version integer,
  p_token_hash bytea
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_order public.orders%rowtype;
  v_attempts integer;
  v_expires_at timestamptz;
  v_verified boolean := false;
begin
  if p_order_number not between 1 and 999
     or p_auth_user_id is null
     or octet_length(p_ip_hash) <> 32
     or octet_length(p_token_hash) <> 32 then
    return jsonb_build_object('verified', false);
  end if;

  -- Serialize attempts from the same network source before checking the rolling limit.
  perform pg_advisory_xact_lock(hashtextextended(encode(p_ip_hash, 'hex'), 0));
  select count(*) into v_attempts
  from private.verification_attempts a
  where a.ip_hash = p_ip_hash and a.attempted_at >= now() - interval '15 minutes';
  if v_attempts >= 8 then return jsonb_build_object('verified', false); end if;

  select o.* into v_order
  from public.orders o
  where o.business_date = public.current_restaurant_business_date()
    and o.order_number = p_order_number
    and o.created_at > now() - interval '30 days'
  limit 1;

  if not found then
    insert into private.verification_attempts (order_id, ip_hash, succeeded)
    values (null, p_ip_hash, false);
    delete from private.verification_attempts a
      where a.order_id is null and a.attempted_at < now() - interval '24 hours';
    return jsonb_build_object('verified', false);
  end if;

  -- Serialize attempts against a particular order, even when they come from different IPs.
  perform pg_advisory_xact_lock(hashtextextended(v_order.id::text, 1));
  select count(*) into v_attempts
  from private.verification_attempts a
  where a.order_id = v_order.id
    and not a.succeeded
    and a.attempted_at >= now() - interval '24 hours';
  if v_attempts >= 10 then return jsonb_build_object('verified', false); end if;

  if p_candidate_valid
     and p_expected_order_id = v_order.id
     and p_code_version = v_order.tracking_code_version
     and (v_order.status not in ('delivered', 'cancelled')
       or v_order.status_updated_at > now() - interval '15 minutes') then
    v_expires_at := least(
      now() + interval '4 hours',
      v_order.created_at + interval '30 days',
      case when v_order.status in ('delivered', 'cancelled')
        then v_order.status_updated_at + interval '15 minutes'
        else 'infinity'::timestamptz end
    );
    if v_expires_at > now() then
      insert into private.tracking_grants (order_id, auth_user_id, token_hash, code_version, expires_at)
      values (v_order.id, p_auth_user_id, p_token_hash, v_order.tracking_code_version, v_expires_at);
      v_verified := true;
    end if;
  end if;

  insert into private.verification_attempts (order_id, ip_hash, succeeded)
  values (v_order.id, p_ip_hash, v_verified);
  delete from private.verification_attempts a
    where a.order_id is null and a.attempted_at < now() - interval '24 hours';

  return jsonb_build_object('verified', v_verified);
end;
$$;
revoke all on function public.record_tracking_verification(smallint, uuid, uuid, bytea, boolean, integer, bytea) from public, anon, authenticated;
grant execute on function public.record_tracking_verification(smallint, uuid, uuid, bytea, boolean, integer, bytea) to service_role;

create or replace function public.get_tracking_order(p_auth_user_id uuid, p_token_hash bytea)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'id', o.id,
    'business_date', o.business_date,
    'order_number', o.order_number,
    'status', o.status,
    'estimated_prep_minutes', o.estimated_prep_minutes,
    'estimated_ready_at', o.estimated_ready_at,
    'created_at', o.created_at,
    'status_updated_at', o.status_updated_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('item_name', oi.item_name, 'quantity', oi.quantity) order by oi.position)
      from public.order_items oi where oi.order_id = o.id
    ), '[]'::jsonb)
  )
  from private.tracking_grants g
  join public.orders o on o.id = g.order_id
  where g.auth_user_id = p_auth_user_id
    and g.token_hash = p_token_hash
    and g.revoked_at is null
    and g.expires_at > now()
    and g.code_version = o.tracking_code_version
    and o.business_date = public.current_restaurant_business_date()
    and o.created_at > now() - interval '30 days'
    and (o.status not in ('delivered', 'cancelled')
      or o.status_updated_at > now() - interval '15 minutes')
  limit 1;
$$;
revoke all on function public.get_tracking_order(uuid, bytea) from public, anon, authenticated;
grant execute on function public.get_tracking_order(uuid, bytea) to service_role;

create or replace function public.revoke_tracking_order(p_auth_user_id uuid, p_token_hash bytea)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
  update private.tracking_grants
  set revoked_at = now()
  where auth_user_id = p_auth_user_id
    and token_hash = p_token_hash
    and revoked_at is null;
  return found;
end;
$$;
revoke all on function public.revoke_tracking_order(uuid, bytea) from public, anon, authenticated;
grant execute on function public.revoke_tracking_order(uuid, bytea) to service_role;
