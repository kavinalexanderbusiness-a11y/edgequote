-- New customer-supplied quote photos are private by default. Existing objects
-- remain in booking-uploads so historical public URLs continue to work during a
-- deliberate backfill; no production object is moved or deleted here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, avif_autodetection)
values (
  'customer-uploads', 'customer-uploads', false, 12582912,
  array['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']::text[], false
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Deliberately no anon/authenticated storage policies. Public uploads cross a
-- rate-limited server route, and owner reads cross an authenticated signing route.
drop policy if exists "customer_uploads_public_read" on storage.objects;
drop policy if exists "customer_uploads_public_insert" on storage.objects;
drop policy if exists "customer-uploads: read own" on storage.objects;
drop policy if exists "customer-uploads: insert own" on storage.objects;

-- The compatibility application writes to booking-uploads only while the new
-- bucket is absent. Once this migration commits, make the historical bucket
-- read-only at both enforcement layers: remove browser INSERT policies and set a
-- MIME allowlist which rejects image uploads even from a stale service-role route.
-- Existing public object reads and the backfill's download/delete phases continue
-- to work; no new customer image can land in public storage after cutover.
drop policy if exists "booking_uploads_public_insert" on storage.objects;
drop policy if exists "booking_uploads_authenticated_insert" on storage.objects;
update storage.buckets
set allowed_mime_types = array['application/x-edgehq-read-only-legacy']::text[]
where id = 'booking-uploads';

-- Portal request rows keep historical booking-uploads paths, while new clients
-- store private durable references. The CHECK accepts exactly those two shapes.
create or replace function public.portal_request_photos_ok(p text[])
returns boolean language sql immutable parallel safe
as $function$
  select coalesce(array_length(p, 1), 0) <= 6
     and coalesce(array_length(p, 1), 0) = (
       select count(*) from unnest(p) as u where
         u ~ ('^portal/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
              || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
              || '\.(jpg|jpeg|png|webp|heic|heif)$')
         or u ~ ('^customer-upload:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
              || '/portal/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
              || '/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
              || '\.(jpg|jpeg|png|webp|heic|heif)$')
     )
$function$;

comment on column public.service_requests.photos is
  'Historical booking-uploads paths or private customer-upload refs for photos a customer attached.';
