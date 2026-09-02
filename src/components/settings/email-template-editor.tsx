'use client';

import { useRef, useState } from 'react';
import { Pencil, Eye, SearchX } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { TemplateField } from '@/components/ui/template-form';

/**
 * Literales de variable interpolables en el asunto y el cuerpo del template.
 * El envío los resuelve (send_email / /api/email/send) vía contactText.
 */
const AVAILABLE_VARIABLES = [
  '{{ name }}',
  '{{ first_name }}',
  '{{ email }}',
  '{{ phone }}',
  '{{ tags }}',
] as const;

const BODY_ID = 'email-template-body';

interface EmailTemplateEditorProps {
  /** Nombre del template (fijo al editar — la API lo usa como clave). */
  name: string;
  subject: string;
  bodyHtml: string;
  /** Nombre bloqueado (solo lectura) al editar un template existente. */
  nameDisabled?: boolean;
  /** Oculta el campo nombre (composición ad-hoc que no guarda template). */
  hideName?: boolean;
  onChange: (patch: { name?: string; subject?: string; bodyHtml?: string }) => void;
}

/**
 * Campos de una plantilla de email: nombre, asunto y cuerpo HTML con
 * **preview en vivo** e **inserción de variables** en el cursor.
 *
 * Usa las mismas primitivas (`TemplateField`) que el formulario de
 * plantillas de WhatsApp, así que los dos diálogos se ven igual.
 */
export function EmailTemplateEditor({
  name,
  subject,
  bodyHtml,
  nameDisabled,
  hideName,
  onChange,
}: EmailTemplateEditorProps) {
  const t = useTranslations('Settings.emailTemplates');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Derive the active tab instead of forcing it in an effect: if the body
  // is emptied while on preview, render the edit pane (the preview trigger
  // is disabled without content anyway). Keeps the composer stateless.
  const activeTab = !bodyHtml.trim() ? 'edit' : tab;

  // Un template de correo real se pega ENTERO (`<!doctype html>…`), con su
  // `<head>`, sus media queries y su `<style>`. Envolverlo otra vez metía
  // un documento dentro de otro y el preview no era lo que recibe el
  // cliente. Si ya es un documento, va tal cual al iframe; si es un
  // fragmento, se envuelve como antes.
  const previewDoc = /^\s*<(!doctype|html)\b/i.test(bodyHtml)
    ? bodyHtml
    : `<!doctype html><html><head><meta charset="utf-8"/></head><body>${bodyHtml}</body></html>`;

  function insertVariable(variable: string) {
    // Inserta donde está el cursor (o reemplaza la selección) y deja el
    // caret detrás de la variable, para poder seguir escribiendo. Sin
    // textarea montado — pestaña de preview — cae a añadir al final.
    const el = bodyRef.current;
    if (!el) {
      onChange({ bodyHtml: bodyHtml ? `${bodyHtml}\n${variable}` : variable });
      return;
    }
    const start = el.selectionStart ?? bodyHtml.length;
    const end = el.selectionEnd ?? start;
    const next = bodyHtml.slice(0, start) + variable + bodyHtml.slice(end);
    onChange({ bodyHtml: next });
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + variable.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <>
      {hideName ? null : (
        <TemplateField label={t('name')} hint={t('nameHint')}>
          <Input
            value={name}
            disabled={nameDisabled}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="missed_call"
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:opacity-60 disabled:cursor-not-allowed"
          />
        </TemplateField>
      )}

      <TemplateField label={t('subject')}>
        <Input
          value={subject}
          onChange={(e) => onChange({ subject: e.target.value })}
          placeholder="Hola {{name}}, vimos tu llamada…"
          className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
        />
      </TemplateField>

      {/* El root de Tabs envuelve todo el campo: los paneles son hijos del
          campo y la lista de pestañas vive junto a la etiqueta, pero ambos
          necesitan el mismo contexto. */}
      <Tabs value={activeTab} onValueChange={(v) => setTab(v as 'edit' | 'preview')}>
        <TemplateField
          label={t('bodyHtml')}
          htmlFor={BODY_ID}
          hint={t('varsHint')}
          action={
            <TabsList>
              <TabsTrigger value="edit">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                {t('editorTab')}
              </TabsTrigger>
              <TabsTrigger value="preview" disabled={!bodyHtml.trim()}>
                <Eye className="mr-1.5 h-3.5 w-3.5" />
                {t('previewTab')}
              </TabsTrigger>
            </TabsList>
          }
        >
          <TabsContent value="edit" className="mt-0 space-y-2">
            <Textarea
              id={BODY_ID}
              ref={bodyRef}
              value={bodyHtml}
              onChange={(e) => onChange({ bodyHtml: e.target.value })}
              rows={14}
              placeholder="<p>Hola {{name}}, …</p>"
              className="bg-muted border-border font-mono text-xs text-foreground placeholder:text-muted-foreground min-h-56 max-h-96 overflow-auto"
            />

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">{t('insertVar')}</span>
              {AVAILABLE_VARIABLES.map((v) => (
                <Button
                  key={v}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => insertVariable(v)}
                  title={t('insertAria', { var: v })}
                  className="h-7 border-border px-2 text-[11px] font-mono text-muted-foreground hover:text-primary hover:bg-primary/10"
                >
                  {v}
                </Button>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="preview" className="mt-0 space-y-2">
            {bodyHtml.trim() ? (
              <div className="overflow-hidden rounded-md border border-border bg-card">
                <div className="border-b border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {subject || t('previewSubjectFallback')}
                </div>
                {/* srcdoc aislado del CSS global del dashboard — preview del
                    template como lo vería el cliente en su cliente de correo. */}
                <iframe
                  title={t('previewFrame')}
                  srcDoc={previewDoc}
                  sandbox=""
                  className="h-96 w-full bg-white"
                />
              </div>
            ) : (
              <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-muted-foreground">
                <SearchX className="h-5 w-5" />
                <p className="text-sm">{t('previewEmpty')}</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('previewHint')}</p>
          </TabsContent>
        </TemplateField>
      </Tabs>
    </>
  );
}
