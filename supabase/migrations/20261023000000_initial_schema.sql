-- Restaurant order system: first reproducible schema migration.
-- Apply to the DEVELOPMENT project first. Do not paste server secrets into SQL.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

do $$ begin
  create type public.order_status as enum ('received', 'preparing', 'ready', 'delivered', 'cancelled');
exception when duplicate_object then null;
end $$;

create table if not exists public.restaurant_settings (
  id smallint primary key default 1 check (id = 1),
  restaurant_name text not null default 'Restaurant' check (char_length(restaurant_name) between 1 and 120),
  time_zone text not null default 'Africa/Algiers',
  business_day_cutoff time not null default time '04:00',
  updated_at timestamptz not null default now(),
  constraint restaurant_settings_timezone_valid check (time_zone <> '')
);

insert into public.restaurant_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.staff_members (
  user_id uuid primary key references auth.users(id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_order_counters (
  business_date date primary key,
  last_order_number smallint not null default 0 check (last_order_number between 0 and 999),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  order_number smallint not null check (order_number between 1 and 999),
  status public.order_status not null default 'received',
  notes text check (notes is null or char_length(notes) <= 2000),
  estimated_prep_minutes smallint not null default 15 check (estimated_prep_minutes between 5 and 240),
  estimated_ready_at timestamptz not null,
  tracking_code_version integer not null default 1 check (tracking_code_version > 0),
  created_by uuid not null references public.staff_members(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  status_updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  cancelled_at timestamptz,
  constraint orders_daily_number_unique unique (business_date, order_number),
  constraint orders_terminal_timestamp check (
    (status <> 'delivered' or delivered_at is not null) and
    (status <> 'cancelled' or cancelled_at is not null)
  )
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  item_name text not null check (char_length(btrim(item_name)) between 1 and 160),
  quantity smallint not null check (quantity between 1 and 99),
  position smallint not null check (position between 0 and 99),
  created_at timestamptz not null default now(),
  unique (order_id, position)
);

create table if not exists private.order_verification_secrets (
  order_id uuid primary key references public.orders(id) on delete cascade,
  code_salt bytea not null check (octet_length(code_salt) >= 16),
  code_digest bytea not null check (octet_length(code_digest) = 32),
  pepper_version smallint not null default 1 check (pepper_version > 0),
  created_at timestamptz not null default now()
);

create table if not exists private.tracking_grants (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  code_version integer not null check (code_version > 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists private.verification_attempts (
  id bigint generated always as identity primary key,
  order_id uuid references public.orders(id) on delete cascade,
  ip_hash bytea not null check (octet_length(ip_hash) = 32),
  succeeded boolean not null default false,
  attempted_at timestamptz not null default now()
);

create table if not exists private.maintenance_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text not null check (outcome in ('running', 'succeeded', 'failed')),
  deleted_orders integer not null default 0 check (deleted_orders >= 0),
  deleted_ip_attempts integer not null default 0 check (deleted_ip_attempts >= 0),
  details text check (details is null or char_length(details) <= 1000)
);

create index if not exists orders_active_created_idx on public.orders (created_at desc) where status in ('received', 'preparing', 'ready');
create index if not exists order_items_order_position_idx on public.order_items (order_id, position);
create index if not exists tracking_grants_order_expiry_idx on private.tracking_grants (order_id, expires_at) where revoked_at is null;
create index if not exists verification_attempts_ip_time_idx on private.verification_attempts (ip_hash, attempted_at desc);
create index if not exists verification_attempts_order_time_idx on private.verification_attempts (order_id, attempted_at desc) where order_id is not null;
create index if not exists maintenance_runs_started_idx on private.maintenance_runs (started_at desc);

-- All application tables have RLS enabled. No customer-facing policies exist.
alter table public.restaurant_settings enable row level security;
alter table public.staff_members enable row level security;
alter table public.daily_order_counters enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table private.order_verification_secrets enable row level security;
alter table private.tracking_grants enable row level security;
alter table private.verification_attempts enable row level security;
alter table private.maintenance_runs enable row level security;

-- Staff membership is checked by a small, non-recursive SECURITY DEFINER helper.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1 from public.staff_members sm
    where sm.user_id = (select auth.uid()) and sm.active
  );
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

drop policy if exists restaurant_settings_staff_read on public.restaurant_settings;
create policy restaurant_settings_staff_read on public.restaurant_settings
  for select to authenticated using (public.is_staff());

drop policy if exists orders_staff_read on public.orders;
create policy orders_staff_read on public.orders
  for select to authenticated using (public.is_staff());

drop policy if exists order_items_staff_read on public.order_items;
create policy order_items_staff_read on public.order_items
  for select to authenticated using (
    public.is_staff() and exists (
      select 1 from public.orders o where o.id = order_items.order_id
    )
  );

-- Explicit privileges: staff can only read through the policies above.
revoke all on public.restaurant_settings, public.staff_members, public.daily_order_counters,
  public.orders, public.order_items from anon, authenticated;
grant select on public.restaurant_settings, public.orders, public.order_items to authenticated;

-- Private schema data and sequences are service-side only.
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
grant all on all tables in schema private to service_role;
grant usage, select on all sequences in schema private to service_role;

-- Server-only business date calculation; cutoff is interpreted in the configured IANA zone.
create or replace function public.current_restaurant_business_date()
returns date
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_settings public.restaurant_settings%rowtype;
  v_local timestamp;
begin
  select * into strict v_settings from public.restaurant_settings where id = 1;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = v_settings.time_zone) then
    raise exception 'invalid_restaurant_timezone';
  end if;
  v_local := now() at time zone v_settings.time_zone;
  return case when v_local::time < v_settings.business_day_cutoff
    then v_local::date - 1 else v_local::date end;
end;
$$;
revoke all on function public.current_restaurant_business_date() from public, anon, authenticated;
grant execute on function public.current_restaurant_business_date() to service_role;

-- Transactional order creation. Called only by a trusted Edge Function using service_role;
-- the actor is rechecked against the trusted staff table inside this transaction.
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

-- Enforce status transitions in the database even when the UI or caller is faulty.
create or replace function public.transition_order_secure(
  p_actor_id uuid,
  p_order_id uuid,
  p_next_status public.order_status,
  p_estimated_prep_minutes smallint default null
)
returns public.orders
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_order public.orders%rowtype;
  v_allowed boolean;
begin
  if not exists (select 1 from public.staff_members sm where sm.user_id = p_actor_id and sm.active) then
    raise exception 'staff_authorization_required' using errcode = '42501';
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'order_unavailable'; end if;
  v_allowed := case v_order.status
    when 'received' then p_next_status in ('preparing', 'cancelled')
    when 'preparing' then p_next_status in ('ready', 'cancelled')
    when 'ready' then p_next_status in ('delivered', 'cancelled')
    else false
  end;
  if not v_allowed then raise exception 'invalid_status_transition'; end if;
  if p_estimated_prep_minutes is not null and p_estimated_prep_minutes not between 5 and 240 then
    raise exception 'invalid_prep_minutes';
  end if;
  update public.orders set
    status = p_next_status,
    estimated_prep_minutes = coalesce(p_estimated_prep_minutes, estimated_prep_minutes),
    estimated_ready_at = case when p_next_status in ('delivered', 'cancelled') then estimated_ready_at
      when p_estimated_prep_minutes is not null then now() + make_interval(mins => p_estimated_prep_minutes)
      else estimated_ready_at end,
    status_updated_at = now(),
    delivered_at = case when p_next_status = 'delivered' then now() else delivered_at end,
    cancelled_at = case when p_next_status = 'cancelled' then now() else cancelled_at end
  where id = p_order_id returning * into v_order;
  return v_order;
end;
$$;
revoke all on function public.transition_order_secure(uuid, uuid, public.order_status, smallint) from public, anon, authenticated;
grant execute on function public.transition_order_secure(uuid, uuid, public.order_status, smallint) to service_role;

comment on table public.staff_members is 'Trusted staff authorization records; maintain manually from a privileged session.';
comment on table public.orders is 'Staff-readable order records. Customer access is only through grant-validating Edge Functions.';
comment on schema private is 'Non-API storage for verification, grants, attempts, and maintenance records.';
