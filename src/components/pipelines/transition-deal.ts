import type { DealStatus } from "@/types";

/**
 * Cliente de `POST /api/deals/[id]/transition`, compartido por los tres sitios
 * que mueven un deal (kanban, cambio de etapa del formulario y botones
 * won/lost/reopen).
 *
 * Por qué una ruta y no `supabase.rpc("transition_deal", ...)` desde el
 * navegador, como se hacía antes: la RPC es SQL y no puede llamar al motor de
 * automatizaciones (Node). La ruta es el único punto donde el servidor se
 * entera del cambio de etapa, así que es donde se despacha el trigger
 * `deal_stage_changed`. La transición en sí sigue siendo la MISMA RPC —
 * optimistic locking por `version`, `state_changed` y prioridad derivada
 * incluidos (DAD §7.1); el update directo de stage/status sigue prohibido.
 */

/** El jsonb de `transition_deal` tal cual: la ruta lo reenvía sin envolver. */
export interface TransitionDealResult {
  ok: boolean;
  /** 'VERSION_CONFLICT' | 'NO_OP' cuando `ok` es false. */
  code?: string;
  version?: number;
  priority?: string;
  status?: DealStatus;
}

export interface TransitionDealBody {
  to_stage_id: string;
  /** Optimistic locking; null desactiva la comprobación (versión desconocida). */
  expected_version?: number | null;
  /** Solo para won/lost/reopen: sin él la RPC deriva el status de `stage_status`. */
  new_status?: DealStatus | null;
}

/**
 * Devuelve el jsonb de la transición, o `null` si la petición no llegó a
 * ejecutarla (red caída, o 4xx de auth/tenencia/validación de la ruta). Los
 * llamantes tratan ese `null` igual que trataban el `error` de PostgREST:
 * fallo genérico. Los fallos "suaves" (VERSION_CONFLICT, NO_OP) viajan con 200
 * y `ok: false`, así que el `code` se sigue pudiendo leer para el toast.
 */
export async function transitionDeal(
  dealId: string,
  body: TransitionDealBody,
): Promise<TransitionDealResult | null> {
  try {
    const res = await fetch(
      `/api/deals/${encodeURIComponent(dealId)}/transition`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggered_by: "agent", ...body }),
      },
    );
    if (!res.ok) {
      console.error("Failed to transition deal:", res.status);
      return null;
    }
    return (await res.json()) as TransitionDealResult;
  } catch (err) {
    console.error("Failed to transition deal:", err);
    return null;
  }
}
