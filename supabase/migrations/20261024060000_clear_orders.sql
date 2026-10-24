-- Clear the order history only through the staff-authorized Edge Function.
-- The daily counter row is locked so order creation cannot race the reset.
create or replace function public.clear_orders_secure(p_actor_id uuid)
returns table (deleted_orders integer)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_business_date date;
  v_deleted_count integer;
begin
  if p_actor_id is null or not exists (
    select 1 from public.staff_members sm
    where sm.user_id = p_actor_id and sm.active
  ) then
    raise exception 'staff_access_required';
  end if;

  v_business_date := public.current_restaurant_business_date();

  insert into public.daily_order_counters as counters (business_date, last_order_number)
  values (v_business_date, 0)
  on conflict (business_date) do nothing;

  perform counters.business_date
  from public.daily_order_counters as counters
  where counters.business_date = v_business_date
  for update;

  delete from public.orders where true;
  get diagnostics v_deleted_count = row_count;

  update public.daily_order_counters as counters
  set last_order_number = 0, updated_at = now()
  where counters.business_date is not null;

  return query select v_deleted_count;
end;
$$;

revoke all on function public.clear_orders_secure(uuid) from public, anon, authenticated;
grant execute on function public.clear_orders_secure(uuid) to service_role;

notify pgrst, 'reload schema';
