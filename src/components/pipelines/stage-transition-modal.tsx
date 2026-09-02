"use client";

import { useEffect, useState } from "react";
import type { ChecklistItem, PipelineStage } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ListChecks, ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

interface StageTransitionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromStage: PipelineStage | null;
  toStage: PipelineStage | null;
  onConfirm: () => void;
}

/**
 * Modal de confirmación antes de mover un trato a una etapa con checklist
 * (migración 067).
 *
 * Es una LISTA DE CONFIRMACIÓN, no un muro: los checks son para que el agente
 * revise y no se le escape nada, pero el botón "Estoy de acuerdo y mover"
 * está SIEMPRE habilitado — un CRM que bloquea al vendedor se deja de usar.
 *
 * Este componente NO toca Supabase y NO decide: solo muestra la lista y
 * reporta la confirmación. El checklist nunca viaja a transition_deal (la
 * transición es la misma de siempre); los checks son estado local que se
 * descarta al cerrar.
 */
export function StageTransitionModal({
  open,
  onOpenChange,
  fromStage,
  toStage,
  onConfirm,
}: StageTransitionModalProps) {
  const t = useTranslations("Pipelines.transitionModal");
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());

  // Reset local state every time the dialog opens — each transition starts
  // with a clean checklist (legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) setCheckedIds(new Set());
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const checklist: ChecklistItem[] = toStage?.checklist ?? [];
  const noChecklistRequired = checklist.length === 0;

  function toggle(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleConfirm() {
    onConfirm();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-popover border-border">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <ListChecks className="h-4 w-4 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>
            {fromStage && toStage ? (
              <>
                <span className="font-medium text-foreground">
                  {fromStage.name}
                </span>
                <ArrowRight className="mx-1 inline h-3.5 w-3.5 align-[-2px] text-muted-foreground" />
                <span className="font-medium text-foreground">
                  {toStage.name}
                </span>
              </>
            ) : (
              t("unknownStage")
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {noChecklistRequired ? (
            <p className="text-sm text-muted-foreground">
              {t("noChecklistRequired")}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {t("checklistIntro")}
              </p>
              <ul className="space-y-2">
                {checklist.map((item) => (
                  <li key={item.id}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-muted/50 p-3 hover:bg-muted transition-colors">
                      <Checkbox
                        checked={checkedIds.has(item.id)}
                        onCheckedChange={() => toggle(item.id)}
                        className="mt-0.5"
                        aria-label={item.text}
                      />
                      <span
                        className={`text-sm ${
                          checkedIds.has(item.id)
                            ? "text-muted-foreground line-through"
                            : "text-foreground"
                        }`}
                      >
                        {item.text}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border bg-transparent text-muted-foreground hover:bg-muted"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleConfirm}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {t("confirmAndMove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}