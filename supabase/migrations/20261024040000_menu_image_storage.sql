-- Public menu photos; only active staff can upload, replace, or remove files.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-images', 'menu-images', true, 5242880,
  array['image/jpeg','image/png','image/webp','image/avif'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists menu_images_staff_insert on storage.objects;
create policy menu_images_staff_insert on storage.objects
  for insert to authenticated with check (
    bucket_id = 'menu-images' and public.is_staff()
  );

drop policy if exists menu_images_staff_update on storage.objects;
create policy menu_images_staff_update on storage.objects
  for update to authenticated using (
    bucket_id = 'menu-images' and public.is_staff()
  ) with check (
    bucket_id = 'menu-images' and public.is_staff()
  );

drop policy if exists menu_images_staff_delete on storage.objects;
create policy menu_images_staff_delete on storage.objects
  for delete to authenticated using (
    bucket_id = 'menu-images' and public.is_staff()
  );
