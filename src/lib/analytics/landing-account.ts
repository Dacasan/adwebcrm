// ============================================================
// landing-account — resuelve el account_id de la landing (eventos
// anónimos de /api/events y /api/track). DAD §9.1: "los eventos
// anónimos tienen account_id de la clínica".
//
// El deploy es single-account (una clínica por instancia, verificado:
// 1 fila en public.accounts). Resolución: env var LANDING_ACCOUNT_ID
// si está definida (multi-instancia explícita), si no la primera
// cuenta creada (order by created_at). Memoizada por proceso.
//
// FAIL-CLOSED: sin LANDING_ACCOUNT_ID Y con más de una cuenta en la
// base, la resolución devuelve null (no adivina "la primera") — todo
// internet NO puede escribir en el tenant más antiguo. En ese caso los
// endpoints de tracking fallan con 500 hasta que el operador fije la
// env var. El deploy single-account legítimo (1 fila) sigue funcionando
// sin env var.
//
// Nunca se expone al cliente: corre SOLO server-side con service role.
// ============================================================

import { supabaseAdmin } from "@/lib/automations/admin-client";

let _cached: string | null | undefined;

export async function resolveLandingAccountId(): Promise<string | null> {
  if (_cached !== undefined) return _cached;

  if (process.env.LANDING_ACCOUNT_ID) {
    _cached = process.env.LANDING_ACCOUNT_ID;
    return _cached;
  }

  // Fail-closed multi-tenant: si hay más de una cuenta y no hay env var
  // explícita, no elegimos "la primera" (molde público) — devolvemos null
  // y los endpoints de tracking fallan hasta que se configure.
  const { count } = await supabaseAdmin()
    .from("accounts")
    .select("id", { count: "exact", head: true });

  if ((count ?? 0) > 1) {
    console.error(
      "[analytics] resolveLandingAccountId: " +
        `${count} accounts but LANDING_ACCOUNT_ID not set — tracking disabled (fail-closed). ` +
        "Set LANDING_ACCOUNT_ID to the landing's account.",
    );
    _cached = null;
    return null;
  }

  const { data, error } = await supabaseAdmin()
    .from("accounts")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.error("[analytics] resolveLandingAccountId error:", error);
    _cached = null;
    return null;
  }
  _cached = data.id;
  return _cached ?? null;
}