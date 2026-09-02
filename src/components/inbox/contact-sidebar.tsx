"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useRealtime } from "@/hooks/use-realtime";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag, Call } from "@/types";
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Smartphone,
  Loader2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmailTemplatePicker } from "@/components/email/email-template-picker";
import { countSmsSegments } from "@/lib/sms/segments";
import { format } from "date-fns";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
}

/** mm:ss a partir de segundos (duración de llamada). */
function formatDuration(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [emailPickerOpen, setEmailPickerOpen] = useState(false);
  const [smsComposerOpen, setSmsComposerOpen] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, tags and recent calls in parallel
    const [dealsRes, notesRes, tagsRes, callsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      // Historial real de llamadas (Fase 1): iniciadas por el webhook
      // Telnyx, contact_id resuelto server-side (migración 039).
      supabase
        .from("calls")
        .select("*")
        .eq("contact_id", contact.id)
        .order("initiated_at", { ascending: false })
        .limit(5),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (callsRes.data) setCalls(callsRes.data);
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  // Realtime 'calls' (canal aditivo, migración 042): la llamada entrante o
  // saliente del webhook Telnyx aparece en la lista sin recargar la página.
  useRealtime({
    channelName: `calls-${contact?.id ?? "none"}`,
    enabled: !!contact,
    onCallEvent: (event) => {
      const row = event.new;
      if (!row || row.contact_id !== contact?.id) return;
      setCalls((prev) => {
        const others = prev.filter((c) => c.id !== row.id);
        return [row, ...others].slice(0, 5);
      });
    },
  });

  const handleCall = useCallback(async () => {
    if (!contact || calling) return;
    setCalling(true);
    setCallError(null);
    try {
      const res = await fetch("/api/telnyx/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "call failed");
    } catch (e) {
      setCallError(e instanceof Error ? e.message : "call failed");
    } finally {
      setCalling(false);
    }
  }, [contact, calling]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {/* Email: abre el mismo picker/composer que el detalle del
                contacto (lista de templates con scroll + redactar ad-hoc).
                Va encima de Llamar — solo si el contacto tiene email. */}
            {contact.email && (
              <button
                onClick={() => setEmailPickerOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Mail className="h-4 w-4" />
                {tSidebar("email")}
              </button>
            )}

            {/* SMS: hermano del botón Email — mismo estilo outline, mismo
                patrón (abre un compositor en diálogo que postea al route
                del canal). A diferencia del email, este SÍ se pinta siempre:
                un contacto sin teléfono lo ve deshabilitado con el motivo
                debajo, porque "no puedo mandarle un SMS" es información
                útil, no un botón que desaparece sin explicación. */}
            <button
              onClick={() => setSmsComposerOpen(true)}
              disabled={!contact.phone}
              title={!contact.phone ? tSidebar("smsNoPhone") : undefined}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <Smartphone className="h-4 w-4" />
              {tSidebar("sms")}
            </button>
            {!contact.phone && (
              <p className="px-1 text-xs text-muted-foreground">
                {tSidebar("smsNoPhone")}
              </p>
            )}

            {/* Botón Llamar (Fase 1): forward nativo Telnyx vía /api/telnyx/call */}
            <button
              onClick={handleCall}
              disabled={calling || !contact.phone}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Phone className="h-4 w-4" />
              {calling ? tSidebar("calling") : tSidebar("call")}
            </button>
            {callError && (
              <p className="px-1 text-xs text-destructive">{callError}</p>
            )}

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {contact.email && (
            <EmailTemplatePicker
              open={emailPickerOpen}
              onOpenChange={setEmailPickerOpen}
              contactId={contact.id}
            />
          )}

          {contact.phone && (
            <SmsComposer
              open={smsComposerOpen}
              onOpenChange={setSmsComposerOpen}
              contactId={contact.id}
              phone={contact.phone}
            />
          )}

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Recent Calls */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <PhoneMissed className="h-3 w-3" />
              {tSidebar("calls")}
            </div>
            <div className="mt-2 space-y-2">
              {calls.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noCalls")}</p>
              ) : (
                calls.map((call) => {
                  const Icon = call.direction === "inbound" ? PhoneIncoming : PhoneOutgoing;
                  return (
                    <div key={call.id} className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                      <Icon
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          call.disposition === "missed" ? "text-destructive" : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-foreground">
                            {call.direction === "inbound" ? call.from_number : call.to_number}
                          </span>
                          {call.disposition === "missed" && (
                            <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              {tSidebar("missed")}
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {format(new Date(call.initiated_at), "MMM d, HH:mm")}
                          {call.duration_sec ? ` · ${formatDuration(call.duration_sec)}` : ""}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              {tSidebar("deals")}
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

interface SmsComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Contacto destinatario; el route resuelve el teléfono server-side. */
  contactId: string;
  /** Solo para enseñar a qué número va — el envío no lo usa. */
  phone: string;
}

/**
 * Compositor mínimo de SMS: un textarea y enviar. Es el hermano pobre del
 * `EmailTemplatePicker` a propósito — el SMS no tiene plantillas de Meta,
 * ni interactivos, ni adjuntos: solo texto plano que se factura por
 * segmento, y por eso lo único que añade al textarea es el contador.
 *
 * Sigue el mismo patrón que el picker de email (diálogo controlado por el
 * padre, POST al route del canal, toast con el error del servidor, cierre
 * en éxito), con una diferencia a favor: `/api/sms/send` SÍ persiste el
 * saliente en `messages` con `channel:'sms'`, así que el mensaje aparece
 * en el hilo del inbox por realtime sin que este componente avise a nadie.
 * El email enviado desde aquí, en cambio, todavía no se ve en el hilo.
 *
 * Vive en este fichero y no en un módulo propio para no pisar el bloque de
 * otra sesión; si el detalle de contacto acaba necesitando el mismo
 * diálogo, extraerlo es mover estas líneas y cambiar el import.
 */
function SmsComposer({
  open,
  onOpenChange,
  contactId,
  phone,
}: SmsComposerProps) {
  const t = useTranslations("Inbox.sidebar.smsComposer");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const trimmed = text.trim();
  // Se cuenta el texto TAL CUAL se escribe (sin recortar): los espacios
  // finales también viajan y también se pagan.
  const info = countSmsSegments(text);

  // El borrador se limpia al cerrar, no en un efecto de apertura: cerrar
  // el diálogo es la señal de "esto no se manda", y así no hace falta un
  // efecto que escriba estado en el primer render.
  function handleOpenChange(next: boolean) {
    if (!next) setText("");
    onOpenChange(next);
  }

  async function handleSend() {
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId, text: trimmed }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        // El route ya distingue proveedor sin configurar (400), contacto
        // dado de baja (403) y fallo del proveedor (502) con un mensaje
        // accionable; se enseña tal cual en vez de inventar uno genérico.
        toast.error(t("toastFailed", { reason: payload.error ?? `HTTP ${res.status}` }));
        return;
      }
      toast.success(t("toastSent"));
      setText("");
      onOpenChange(false);
    } catch (err) {
      toast.error(
        t("toastFailed", {
          reason: err instanceof Error ? err.message : "network error",
        }),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {t("title")}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("subtitle", { phone })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("placeholder")}
            rows={5}
            autoFocus
            disabled={sending}
            className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 disabled:opacity-50"
          />
          {/* Contador: cada segmento se factura aparte y un solo carácter
              fuera de GSM-7 (un emoji, una "á") baja la capacidad de 160 a
              70. Verlo mientras se escribe evita la sorpresa en la factura. */}
          {text.length > 0 && (
            <p className="px-1 text-right text-[11px] text-muted-foreground">
              {t("counter", { chars: info.characters, segments: info.segments })}
            </p>
          )}
        </div>

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={sending}
            className="border-border text-muted-foreground"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleSend}
            disabled={!trimmed || sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
