
-- Public bucket for inbound WhatsApp media downloaded by webhook
insert into storage.buckets (id, name, public)
values ('whatsapp-media', 'whatsapp-media', true)
on conflict (id) do update set public = true;

-- Public read access
drop policy if exists "Public read whatsapp-media" on storage.objects;
create policy "Public read whatsapp-media"
on storage.objects for select
using (bucket_id = 'whatsapp-media');

-- Service role bypasses RLS, but add explicit allow for clarity (no-op for service role)
drop policy if exists "Service write whatsapp-media" on storage.objects;
create policy "Service write whatsapp-media"
on storage.objects for insert
with check (bucket_id = 'whatsapp-media');
