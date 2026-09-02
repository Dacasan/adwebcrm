'use client';

import { useEffect, useState } from 'react';
import { EmailTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { EmailTemplateEditor } from '@/components/settings/email-template-editor';
import { Loader2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

interface EmailTemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** contactId del contacto al que se envía (requiere email). */
  contactId: string;
}

/**
 * Selector de templates de email para "Send email" desde el detalle de un
 * contacto y desde el inbox. Lista `email_templates` vía /api/email/templates
 * y envía con `/api/email/send` (mismo route que el inbox — interpola
 * `{{ name }}`, `{{ tags }}`, etc. con `contactText`).
 *
 * Dos modos en pestañas: **Plantillas** (lista compacta con scroll — el
 * footer con Cancelar/Enviar SIEMPRE visible) y **Redactar** (composición
 * libre reusando `EmailTemplateEditor`, la primitiva de email > new
 * template, enviando subject + body_html inline por el mismo route).
 */
export function EmailTemplatePicker({
  open,
  onOpenChange,
  contactId,
}: EmailTemplatePickerProps) {
  const t = useTranslations('Contacts.detailView.emailPicker');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<EmailTemplate | null>(null);
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState<'templates' | 'compose'>('templates');
  // Estado del modo Redactar (composición libre, sin guardar template).
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setSelected(null);
      setTab('templates');
      setComposeSubject('');
      setComposeBody('');
      try {
        const res = await fetch('/api/email/templates', { cache: 'no-store' });
        const data = (await res.json()) as { templates?: EmailTemplate[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'failed to list');
        if (!cancelled) setTemplates(data.templates ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const composing = tab === 'compose';
  const composeReady = !!composeSubject.trim() && !!composeBody.trim();

  async function handleSend() {
    if (sending) return;
    // Modo Plantillas: requiere selección. Modo Redactar: requiere subject+body.
    if (!composing && !selected) return;
    if (composing && !composeReady) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          composing
            ? { contactId, subject: composeSubject, body_html: composeBody }
            : { contactId, template: selected?.name },
        ),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(payload.error ?? `HTTP ${res.status}`);
        return;
      }
      toast.success(
        composing
          ? t('toastSentCustom')
          : t('toastSent', { name: selected?.name ?? '' }),
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'network error');
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Header, tabs y footer FIJOS; solo la lista/compónedor scrollea.
          Así Cancelar/Enviar nunca quedan fuera del viewport. */}
      <DialogContent className="flex max-h-[90vh] flex-col border-border bg-popover sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('subtitle')}
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as 'templates' | 'compose')}
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <TabsList>
            <TabsTrigger value="templates">{t('templatesTab')}</TabsTrigger>
            <TabsTrigger value="compose">{t('composeTab')}</TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="mt-0 min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex h-32 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : error ? (
              <p className="py-6 text-center text-sm text-red-400">{error}</p>
            ) : templates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('empty')}
              </p>
            ) : (
              // Lista compacta seleccionable: una fila por template en vez
              // de cards altas — N filas visibles y scroll dentro del dialog.
              <div className="space-y-1">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => setSelected(template)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected?.id === template.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {template.name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {template.subject}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="compose" className="mt-0 min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4">
              <EmailTemplateEditor
                name=""
                subject={composeSubject}
                bodyHtml={composeBody}
                hideName
                onChange={(patch) => {
                  if (patch.subject !== undefined) setComposeSubject(patch.subject);
                  if (patch.bodyHtml !== undefined) setComposeBody(patch.bodyHtml);
                }}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
            className="border-border text-muted-foreground"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleSend}
            disabled={(composing ? !composeReady : !selected) || sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {t('send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
