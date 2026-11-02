import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { verifyAdminPassword } from "@/lib/auth/reauth";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

// ============================================================
// /api/inbox/conversations/[id]
//
//   PATCH  { deleted: boolean }  → move to trash / restore. Agent+.
//   DELETE { email, password }   → permanent delete. Only from the
//                                  trash, and only with the
//                                  credentials of an owner/admin of
//                                  the same account.
//
// Scoping is belt-and-braces: RLS already limits rows to account
// members, and every query repeats `.eq('account_id', ctx.accountId)`.
// ============================================================

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;

    const body = (await request.json().catch(() => null)) as
      | { deleted?: unknown }
      | null;
    if (typeof body?.deleted !== "boolean") {
      return NextResponse.json(
        { error: "'deleted' must be a boolean" },
        { status: 400 },
      );
    }

    const { data, error } = await ctx.supabase
      .from("conversations")
      .update({
        deleted_at: body.deleted ? new Date().toISOString() : null,
        deleted_by: body.deleted ? ctx.userId : null,
      })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id");

    if (error) {
      console.error("[inbox] trash update failed:", error);
      return NextResponse.json(
        { error: "Failed to update conversation" },
        { status: 500 },
      );
    }
    if (!data?.length) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");

    const limit = checkRateLimit(
      `inbox:purge:${ctx.userId}`,
      RATE_LIMITS.reauth,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = (await request.json().catch(() => null)) as
      | { email?: unknown; password?: unknown }
      | null;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!email || !password) {
      return NextResponse.json(
        { error: "Admin email and password are required" },
        { status: 400 },
      );
    }

    const { data: conversation, error: readErr } = await ctx.supabase
      .from("conversations")
      .select("id, deleted_at")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (readErr) {
      console.error("[inbox] purge read failed:", readErr);
      return NextResponse.json(
        { error: "Failed to read conversation" },
        { status: 500 },
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }
    if (!conversation.deleted_at) {
      return NextResponse.json(
        { error: "Move the conversation to the trash first" },
        { status: 409 },
      );
    }

    const authorized = await verifyAdminPassword(
      email,
      password,
      ctx.accountId,
    );
    if (!authorized) {
      return NextResponse.json(
        { error: "Admin credentials required" },
        { status: 403 },
      );
    }

    const { data: deleted, error: deleteErr } = await ctx.supabase
      .from("conversations")
      .delete()
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("id");

    if (deleteErr) {
      console.error("[inbox] permanent delete failed:", deleteErr);
      return NextResponse.json(
        { error: "Failed to delete conversation" },
        { status: 500 },
      );
    }
    if (!deleted?.length) {
      return NextResponse.json(
        { error: "Conversation not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
