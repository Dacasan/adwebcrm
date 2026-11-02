"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  Smartphone,
  Mail,
  Trash2,
  RotateCcw,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { TrashPurgeDialog } from "./trash-purge-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /** Applies a soft delete / restore to the parent's conversation list. */
  onConversationDeleted: (id: string, deleted: boolean) => void;
  /** Removes a permanently deleted conversation from the parent state. */
  onConversationPurged: (id: string) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

/**
 * Canal de un mensaje (`messages.channel`, migración 041 ampliada por la
 * 078). Se declara local en vez de importar el `ThreadChannel` del thread
 * para no acoplar la lista a un módulo que otra sesión está editando; los
 * valores son los mismos del contrato: whatsapp | sms | email.
 */
type MessageChannel = "whatsapp" | "sms" | "email";

/** Canales que se marcan con chip en la lista. */
type ChippedChannel = Exclude<MessageChannel, "whatsapp">;

/**
 * Iconos de los canales que SÍ llevan chip. WhatsApp no está: es el canal
 * por defecto del inbox y no se marca (ver {@link ChannelChip}).
 */
const CHANNEL_ICONS: Record<ChippedChannel, typeof Smartphone> = {
  sms: Smartphone,
  email: Mail,
};

function isMessageChannel(value: unknown): value is MessageChannel {
  return value === "whatsapp" || value === "sms" || value === "email";
}

/**
 * Cuántos mensajes recientes se miran para derivar el canal de cada hilo.
 * Ver el efecto que la usa: es una ventana, no una garantía.
 */
const CHANNEL_LOOKUP_LIMIT = 1000;

/** Fila mínima de `messages` que necesita la derivación de canal. */
type ChannelRow = {
  conversation_id: string;
  channel: string | null;
  created_at: string;
};

type InboxFilter = ConversationStatus | "all" | "unread" | "trash";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  onConversationDeleted,
  onConversationPurged,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  // Trash mutations are agent+ at the RLS/API layer; a viewer sees the
  // list but not the actions.
  const { canSendMessages } = useAuth();

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
    { label: t("filterTrash"), value: "trash" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<Conversation | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Canal por conversación. `conversations` NO tiene columna de canal y no
  // debe tenerla: hay UNA conversación por (cuenta, contacto) y WhatsApp,
  // SMS y email caen en el mismo hilo a propósito (migración 041, "mezcla
  // solo visual en el inbox"). El canal es una propiedad del MENSAJE, así
  // que aquí se deriva del último mensaje de cada hilo.
  const [channelByConversation, setChannelByConversation] = useState<
    Record<string, MessageChannel>
  >({});
  // La query pide los N mensajes más recientes de la cuenta (RLS ya los
  // acota) en vez de filtrar por los ids cargados: PostgREST no sabe hacer
  // "último por grupo" sin una vista, y un `.in()` con cientos de uuids se
  // come el límite de longitud de la URL. Los hilos que quedan fuera de esa
  // ventana no pintan chip — degradar a "sin chip" es preferible a enseñar
  // un canal equivocado.
  const conversationCount = conversations.length;
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("conversation_id, channel, created_at")
        .order("created_at", { ascending: false })
        .limit(CHANNEL_LOOKUP_LIMIT);

      if (cancelled || error || !data) return;

      const next: Record<string, MessageChannel> = {};
      for (const row of data as ChannelRow[]) {
        // Vienen en orden descendente: la primera fila de cada conversación
        // es su último mensaje, las siguientes se descartan.
        if (row.conversation_id in next) continue;
        next[row.conversation_id] = isMessageChannel(row.channel)
          ? row.channel
          : "whatsapp";
      }
      setChannelByConversation(next);
    })();

    return () => {
      cancelled = true;
    };
    // `conversationCount` (no el array entero) para refrescar cuando entra
    // o sale una conversación sin refetchear en cada parche de realtime del
    // padre, que reemplaza el array en cada mensaje nuevo.
  }, [resyncToken, conversationCount]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    const isTrash = filter === "trash";
    // Trashed threads never appear in the inbox filters; the trash
    // filter is the only place they surface (migration 082).
    let result = conversations.filter((c) =>
      isTrash ? !!c.deleted_at : !c.deleted_at,
    );

    if (!isTrash) {
      if (filter === "unread") {
        result = result.filter((c) => c.unread_count > 0);
      } else if (filter !== "all") {
        result = result.filter((c) => c.status === filter);
      }
    }

    // Contact-based filters (tags via OR logic, exact company match).
    // Trash is a flat recovery list, so these don't apply there.
    if (!isTrash && (selectedTagIds.length > 0 || selectedCompany !== null)) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const setDeleted = useCallback(
    async (id: string, deleted: boolean) => {
      setBusyId(id);
      try {
        const res = await fetch(`/api/inbox/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deleted }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onConversationDeleted(id, deleted);
        toast.success(deleted ? t("movedToTrash") : t("restored"));
      } catch (err) {
        console.error("Failed to update conversation trash state:", err);
        toast.error(t("actionFailed"));
      } finally {
        setBusyId(null);
      }
    },
    [onConversationDeleted, t]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              {filter === "trash" ? t("trashEmpty") : t("noConversations")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) =>
              filter === "trash" ? (
                <TrashItem
                  key={conv.id}
                  conversation={conv}
                  busy={busyId === conv.id}
                  canModify={canSendMessages}
                  onRestore={() => setDeleted(conv.id, false)}
                  onPurge={() => setPurgeTarget(conv)}
                  t={t}
                />
              ) : (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  channel={channelByConversation[conv.id]}
                  isActive={conv.id === activeConversationId}
                  onSelect={handleSelect}
                  onTrash={() => setDeleted(conv.id, true)}
                  canTrash={canSendMessages}
                  busy={busyId === conv.id}
                  t={t}
                />
              ),
            )}
          </div>
        )}
      </ScrollArea>

      <TrashPurgeDialog
        key={purgeTarget?.id ?? "closed"}
        conversation={purgeTarget}
        onOpenChange={(open) => {
          if (!open) setPurgeTarget(null);
        }}
        onPurged={(id) => {
          setPurgeTarget(null);
          onConversationPurged(id);
          toast.success(t("purged"));
        }}
      />
    </div>
  );
}

/**
 * Chip de canal del hilo. Solo se pinta para SMS y email: WhatsApp es el
 * canal por defecto de todo el inbox y repetirlo en cada una de las filas
 * de la lista sería ruido — la ausencia de chip ya significa WhatsApp.
 * (La cabecera del hilo sí lo pinta siempre: allí es UN chip y lo que
 * importa es no dejar dudas sobre por dónde va a salir la respuesta.)
 * Un `channel` indefinido —hilo fuera de la ventana de derivación— tampoco
 * pinta nada: mejor sin chip que con el canal equivocado.
 */
function ChannelChip({
  channel,
  t,
}: {
  channel?: MessageChannel;
  t: ReturnType<typeof useTranslations>;
}) {
  if (channel !== "sms" && channel !== "email") return null;

  const Icon = CHANNEL_ICONS[channel];
  const label = channel === "sms" ? t("channelSms") : t("channelEmail");

  return (
    <span
      title={label}
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground"
    >
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  /** Canal del último mensaje del hilo; undefined si no se pudo derivar. */
  channel?: MessageChannel;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Mueve el hilo a la papelera (soft delete, reversible). */
  onTrash: () => void;
  /** Viewer role: render the row without the trash action. */
  canTrash: boolean;
  busy: boolean;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  channel,
  isActive,
  onSelect,
  onTrash,
  canTrash,
  busy,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const handleTrash = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onTrash();
    },
    [onTrash],
  );

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <div className="group relative">
      <button
        onClick={handleClick}
        className={cn(
          "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
          isActive && "border-l-2 border-primary bg-muted/70"
        )}
      >
        {/* Avatar */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2 pr-6">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="truncate text-xs text-muted-foreground">
              {conversation.last_message_text || t("noMessagesYet")}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              <ChannelChip channel={channel} t={t} />
              {conversation.unread_count > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {conversation.unread_count}
                </span>
              )}
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  STATUS_COLORS[conversation.status]
                )}
                title={conversation.status}
              />
            </div>
          </div>
        </div>
      </button>

      {/* Soft delete lives on the row instead of the thread header so
          cleaning the inbox doesn't require opening each conversation. */}
      {canTrash && (
        <button
          type="button"
          onClick={handleTrash}
          disabled={busy}
          title={t("moveToTrash")}
          aria-label={t("moveToTrash")}
          className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground opacity-100 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 disabled:opacity-50 lg:pointer-events-none lg:opacity-0 lg:group-hover:pointer-events-auto lg:group-hover:opacity-100"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      )}
    </div>
  );
}

interface TrashItemProps {
  conversation: Conversation;
  busy: boolean;
  /** Viewer role: rows are visible but recovery actions are not. */
  canModify: boolean;
  onRestore: () => void;
  onPurge: () => void;
  t: ReturnType<typeof useTranslations>;
}

/** Row in the Papelera filter: no thread selection, only recovery actions. */
function TrashItem({
  conversation,
  busy,
  canModify,
  onRestore,
  onPurge,
  t,
}: TrashItemProps) {
  const contact = conversation.contact;
  const displayName =
    contact?.name || contact?.email || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex items-start gap-3 border-b border-border/50 px-3 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {initials}
      </div>

      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {displayName}
        </span>
        <p className="truncate text-xs text-muted-foreground">
          {conversation.last_message_text || t("noMessagesYet")}
        </p>
        {canModify && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              onClick={onRestore}
              disabled={busy}
            >
              <RotateCcw className="h-3 w-3" />
              {t("restore")}
            </Button>
            <Button
              size="xs"
              variant="destructive"
              onClick={onPurge}
              disabled={busy}
            >
              <Trash2 className="h-3 w-3" />
              {t("deleteForever")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
