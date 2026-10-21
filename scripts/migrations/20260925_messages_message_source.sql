-- Histórico unificado: origem da mensagem.
-- Echo do WhatsApp Business App grava message_source = 'whatsapp_business_app'.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS message_source TEXT;
