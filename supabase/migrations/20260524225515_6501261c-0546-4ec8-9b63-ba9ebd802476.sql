ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS media_error text;