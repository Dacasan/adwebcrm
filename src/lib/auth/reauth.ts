// ============================================================
// Re-authentication for destructive actions.
//
// The caller already has a session; this proves they also know the
// password of an owner/admin **of the same account**. Used before a
// permanent delete from the inbox trash.
//
// The credential is checked with an isolated Supabase client
// (persistSession/autoRefreshToken off) so nothing touches the
// caller's cookies. signOut MUST be scoped to 'local': the default
// scope is 'global' and would sign the admin out of every device.
// ============================================================

import { createClient } from "@supabase/supabase-js";

import { hasMinRole, isAccountRole } from "./roles";

/**
 * True iff `password` is the password of an owner/admin whose profile
 * belongs to `accountId`. Any failure — bad credentials, non-admin,
 * another account — returns false; the route deliberately does not
 * distinguish them on the wire.
 */
export async function verifyAdminPassword(
  email: string,
  password: string,
  accountId: string,
): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("[reauth] missing Supabase public env vars");
    return false;
  }

  const client = createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error || !data.user) return false;

    // The signed-in client can read this user's own profile row
    // (profiles_select: auth.uid() = user_id), so no service role needed.
    const { data: profile, error: profileErr } = await client
      .from("profiles")
      .select("account_id, account_role")
      .eq("user_id", data.user.id)
      .maybeSingle();
    if (profileErr || !profile) return false;

    return (
      profile.account_id === accountId &&
      isAccountRole(profile.account_role) &&
      hasMinRole(profile.account_role, "admin")
    );
  } catch (err) {
    console.error("[reauth] admin credential check failed:", err);
    return false;
  } finally {
    // Local only. Global would revoke the admin's other sessions.
    await client.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
}
