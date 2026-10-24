-- Admin-only employee management and lightweight online presence.
-- The bootstrap UUID is the staff Auth user ID the owner shared while setting up this project.
alter table public.staff_members
  add column if not exists is_admin boolean not null default false,
  add column if not exists display_name text,
  add column if not exists last_seen_at timestamptz;

update public.staff_members
set is_admin = true
where user_id = 'b8c39a9f-308c-4278-b6db-7180105d3e32'::uuid
  and active = true;

do $$
begin
  if not exists (
    select 1 from public.staff_members
    where user_id = 'b8c39a9f-308c-4278-b6db-7180105d3e32'::uuid
      and active and is_admin
  ) then
    raise exception 'Admin bootstrap user was not found as an active staff member. Replace the bootstrap UUID with the correct Auth user ID, then rerun this migration.';
  end if;
end;
$$;

create or replace function public.set_staff_active_secure(
  p_actor_id uuid,
  p_target_id uuid,
  p_active boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_target_is_admin boolean;
  v_active_admin_count integer;
begin
  -- Serialize staff access changes so concurrent requests cannot remove every admin.
  perform pg_advisory_xact_lock(914202610, 1);

  if p_actor_id is null or p_target_id is null or p_active is null then
    raise exception 'invalid_staff_change';
  end if;

  if not exists (
    select 1 from public.staff_members sm
    where sm.user_id = p_actor_id and sm.active and sm.is_admin
  ) then
    raise exception 'admin_access_required';
  end if;

  if p_actor_id = p_target_id then
    raise exception 'cannot_change_own_access';
  end if;

  select sm.is_admin into v_target_is_admin
  from public.staff_members sm
  where sm.user_id = p_target_id
  for update;

  if not found then
    raise exception 'staff_not_found';
  end if;

  if not p_active and v_target_is_admin then
    select count(*) into v_active_admin_count
    from public.staff_members sm
    where sm.active and sm.is_admin;
    if v_active_admin_count <= 1 then
      raise exception 'cannot_disable_last_admin';
    end if;
  end if;

  update public.staff_members sm
  set active = p_active
  where sm.user_id = p_target_id;
end;
$$;

revoke all on function public.set_staff_active_secure(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_staff_active_secure(uuid, uuid, boolean) to service_role;

notify pgrst, 'reload schema';
