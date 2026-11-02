-- ============================================================
-- 082) Inbox soft delete + trash
--
-- Deleting a thread is user-visible state, not data loss: the row
-- stays in `conversations` and every query that lists the inbox
-- filters `deleted_at IS NULL`. The trash view reads the opposite.
-- A permanent delete (only from the trash, after re-authenticating
-- an owner/admin of the same account) is a real DELETE and keeps
-- cascading to messages as the 001 FK already defines.
--
-- Inbound traffic resurrects the thread: the webhook bump RPC
-- clears `deleted_at` so a new email/SMS/WhatsApp message cannot
-- land in a conversation the UI hides.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_account_deleted
  ON public.conversations (account_id, deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      updated_at        = NOW(),
      -- New inbound activity restores a trashed thread. Without this
      -- the message would be stored but invisible in every list.
      deleted_at        = NULL,
      deleted_by        = NULL
  WHERE id = p_conversation_id;
$$;
