-- Apply only after the EdgeHQ build containing /api/public/booking/photos is
-- deployed and verified. This avoids interrupting the current public booking
-- upload flow during a staged release.

drop policy if exists "booking_uploads_public_insert" on storage.objects;
drop policy if exists "booking_uploads_authenticated_insert" on storage.objects;

create policy "booking_uploads_authenticated_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'booking-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
    and lower(storage.extension(name)) in ('jpg','jpeg','png','webp','heic','heif')
  );
