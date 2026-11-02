"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, ShieldAlert } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Conversation } from "@/types";

interface TrashPurgeDialogProps {
  /** Conversation to delete forever; null keeps the dialog closed. */
  conversation: Conversation | null;
  onOpenChange: (open: boolean) => void;
  onPurged: (id: string) => void;
}

/**
 * Permanent delete from the inbox trash. Unlike the reversible move to
 * trash, this removes the conversation row and cascades its messages,
 * so the API asks for the credentials of an owner/admin of the same
 * account. The password is forwarded once and never stored.
 */
export function TrashPurgeDialog({
  conversation,
  onOpenChange,
  onPurged,
}: TrashPurgeDialogProps) {
  const t = useTranslations("Inbox.conversationList");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!conversation) return;
    // Prefill with the current user; an admin can overwrite it with
    // their own address. Password/error reset comes from the remount
    // key the list puts on this dialog (one mount per conversation).
    createClient()
      .auth.getUser()
      .then(({ data }) =>
        setEmail((current) => current || data.user?.email || ""),
      );
  }, [conversation]);

  const contact = conversation?.contact;
  const displayName =
    contact?.name || contact?.email || contact?.phone || t("unknown");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/inbox/conversations/${conversation.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        setError(t("purgeFailed"));
        return;
      }
      onPurged(conversation.id);
      onOpenChange(false);
    } catch {
      setError(t("purgeFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={conversation !== null} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <ShieldAlert className="h-4 w-4 text-destructive" />
            {t("purgeTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("purgeDescription", { name: displayName })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="purge-admin-email">{t("adminEmail")}</Label>
            <Input
              id="purge-admin-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="purge-admin-password">{t("adminPassword")}</Label>
            <Input
              id="purge-admin-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t("purgeCancel")}
            </Button>
            <Button type="submit" variant="destructive" disabled={loading}>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("deleteForever")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
