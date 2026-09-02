'use client';

import type { ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ============================================================
// Primitivas del formulario de plantillas.
//
// La forma visual nació en Settings > Templates (WhatsApp): diálogo ancho
// con scroll, campos `label + control + pista` y footer fijo de
// cancelar/guardar. Email necesitaba exactamente lo mismo, así que vive
// aquí y la usan los dos — un solo sitio donde cambiar el aspecto.
// El contenido (qué campos, qué validación, a qué API se envía) lo pone
// cada manager; estas piezas solo aportan estructura.
// ============================================================

interface TemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Aviso destacado entre la cabecera y los campos (ver TemplateFormNotice). */
  notice?: ReactNode;
  children: ReactNode;
  cancelLabel: string;
  submitLabel: ReactNode;
  /** Texto del botón mientras `submitting` — por defecto, `submitLabel`. */
  submittingLabel?: ReactNode;
  onSubmit: () => void;
  submitting?: boolean;
  submitDisabled?: boolean;
  /** Clases extra del popup (por defecto `sm:max-w-2xl`). */
  className?: string;
}

/**
 * Diálogo de creación/edición de una plantilla: ancho, con scroll propio
 * y footer de acciones. Los hijos son los campos, ya envueltos por
 * `TemplateField`.
 */
export function TemplateFormDialog({
  open,
  onOpenChange,
  title,
  description,
  notice,
  children,
  cancelLabel,
  submitLabel,
  submittingLabel,
  onSubmit,
  submitting = false,
  submitDisabled = false,
  className,
}: TemplateFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'bg-popover border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto',
          className,
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-muted-foreground">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>

        {notice}

        <div className="space-y-4 py-2">{children}</div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={submitting || submitDisabled}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {submittingLabel ?? submitLabel}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TemplateFieldProps {
  label: ReactNode;
  /** Pista bajo el control. */
  hint?: ReactNode;
  /** Control alineado a la derecha de la etiqueta (pestañas, «+ Añadir»…). */
  action?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Un campo del formulario: etiqueta (+ acción), control y pista. */
export function TemplateField({
  label,
  hint,
  action,
  htmlFor,
  children,
  className,
}: TemplateFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-muted-foreground">
          {label}
        </Label>
        {action}
      </div>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Dos campos en paralelo; se apilan en móvil. */
export function TemplateFieldGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('grid gap-4 sm:grid-cols-2', className)}>{children}</div>;
}

/** Aviso ámbar sobre el formulario (limitaciones, avisos de revisión…). */
export function TemplateFormNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
      <AlertCircle className="size-4 mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
