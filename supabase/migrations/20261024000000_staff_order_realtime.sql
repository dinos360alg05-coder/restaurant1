-- Staff-only order updates. Postgres Changes still checks the signed-in staff RLS policy.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
     ) then
    execute 'alter publication supabase_realtime add table public.orders';
  end if;
end;
$$;
