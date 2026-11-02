import { beforeEach, describe, expect, it, vi } from "vitest";

// verifyAdminPassword — the guard before a permanent delete. The
// signOut scope is load-bearing: 'global' would log the admin out of
// every device, so it must stay 'local'.

const state = vi.hoisted(() => ({
  signInError: null as { message: string } | null,
  user: { id: "user-1" } as { id: string } | null,
  profile: { account_id: "acct-1", account_role: "admin" } as {
    account_id: string;
    account_role: string;
  } | null,
  signIn: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: state.profile,
      error: null,
    }));
    return {
      auth: {
        signInWithPassword: state.signIn,
        signOut: state.signOut,
      },
      from: vi.fn(() => chain),
    };
  }),
}));

import { verifyAdminPassword } from "./reauth";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  state.signInError = null;
  state.user = { id: "user-1" };
  state.profile = { account_id: "acct-1", account_role: "admin" };
  state.signIn.mockReset();
  state.signIn.mockImplementation(async () => ({
    data: { user: state.user, session: {} },
    error: state.signInError,
  }));
  state.signOut.mockClear();
});

describe("verifyAdminPassword", () => {
  it("accepts an admin of the same account and signs out locally", async () => {
    const ok = await verifyAdminPassword(
      " Admin@Acme.com ",
      "secret",
      "acct-1",
    );

    expect(ok).toBe(true);
    expect(state.signIn).toHaveBeenCalledWith({
      email: "admin@acme.com",
      password: "secret",
    });
    expect(state.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("rejects an agent even with a valid password", async () => {
    state.profile = { account_id: "acct-1", account_role: "agent" };
    expect(await verifyAdminPassword("a@acme.com", "secret", "acct-1")).toBe(
      false,
    );
  });

  it("rejects an admin from another account", async () => {
    state.profile = { account_id: "acct-2", account_role: "owner" };
    expect(await verifyAdminPassword("a@acme.com", "secret", "acct-1")).toBe(
      false,
    );
    expect(state.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("rejects bad credentials", async () => {
    state.signInError = { message: "Invalid login credentials" };
    expect(await verifyAdminPassword("a@acme.com", "wrong", "acct-1")).toBe(
      false,
    );
    expect(state.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
