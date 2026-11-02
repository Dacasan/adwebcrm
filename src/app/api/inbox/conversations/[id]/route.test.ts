import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH /api/inbox/conversations/[id] — soft delete / restore (agent+).
// DELETE — permanent delete, only from the trash and only with the
// credentials of an owner/admin of the same account.

const state = {
  userId: "user-1",
  updates: [] as Array<Record<string, unknown>>,
  updateData: [{ id: "conv-1" }] as Array<{ id: string }> | null,
  updateError: null as { message: string } | null,
  readData: { id: "conv-1", deleted_at: "2026-11-02T00:00:00Z" } as {
    id: string;
    deleted_at: string | null;
  } | null,
  readError: null as { message: string } | null,
  deleteData: [{ id: "conv-1" }] as Array<{ id: string }> | null,
  deleteError: null as { message: string } | null,
  adminOk: true,
  client: null as unknown,
};

function makeClient() {
  const readChain: Record<string, unknown> = {};
  readChain.select = vi.fn(() => readChain);
  readChain.eq = vi.fn(() => readChain);
  readChain.is = vi.fn(() => readChain);
  readChain.maybeSingle = vi.fn(async () => ({
    data: state.readData,
    error: state.readError,
  }));

  const updateChain: Record<string, unknown> = {};
  updateChain.eq = vi.fn(() => updateChain);
  updateChain.select = vi.fn(async () => ({
    data: state.updateData,
    error: state.updateError,
  }));

  const deleteChain: Record<string, unknown> = {};
  deleteChain.eq = vi.fn(() => deleteChain);
  deleteChain.select = vi.fn(async () => ({
    data: state.deleteData,
    error: state.deleteError,
  }));

  return {
    from: vi.fn(() => ({
      select: readChain.select,
      update: vi.fn((payload: Record<string, unknown>) => {
        state.updates.push(payload);
        return updateChain;
      }),
      delete: vi.fn(() => deleteChain),
    })),
  };
}

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: state.client,
      userId: state.userId,
      accountId: "acct-1",
      role: "agent",
      account: { id: "acct-1", name: "Acme" },
    })),
  };
});

vi.mock("@/lib/auth/reauth", () => ({
  verifyAdminPassword: vi.fn(async () => state.adminOk),
}));

import { DELETE, PATCH } from "./route";

function patch(body: unknown) {
  const req = new Request("http://localhost/api/inbox/conversations/conv-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(req, { params: Promise.resolve({ id: "conv-1" }) });
}

function del(body: unknown) {
  const req = new Request("http://localhost/api/inbox/conversations/conv-1", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return DELETE(req, { params: Promise.resolve({ id: "conv-1" }) });
}

beforeEach(() => {
  // Unique key per test: the rate-limit bucket survives between tests.
  state.userId = `user-${Math.random()}`;
  state.updates = [];
  state.updateData = [{ id: "conv-1" }];
  state.updateError = null;
  state.readData = { id: "conv-1", deleted_at: "2026-11-02T00:00:00Z" };
  state.readError = null;
  state.deleteData = [{ id: "conv-1" }];
  state.deleteError = null;
  state.adminOk = true;
  state.client = makeClient();
});

describe("PATCH trash state", () => {
  it("rejects a non-boolean deleted flag", async () => {
    expect((await patch({ deleted: "yes" })).status).toBe(400);
  });

  it("sets deleted_at + deleted_by when trashing", async () => {
    const res = await patch({ deleted: true });
    expect(res.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ deleted_by: state.userId });
    expect(typeof state.updates[0].deleted_at).toBe("string");
  });

  it("clears both fields when restoring", async () => {
    const res = await patch({ deleted: false });
    expect(res.status).toBe(200);
    expect(state.updates[0]).toEqual({ deleted_at: null, deleted_by: null });
  });

  it("404s when the conversation is not in the account", async () => {
    state.updateData = null;
    expect((await patch({ deleted: true })).status).toBe(404);
  });
});

describe("DELETE from trash", () => {
  it("requires email and password", async () => {
    expect((await del({ email: "admin@acme.com" })).status).toBe(400);
  });

  it("refuses a conversation that is not in the trash", async () => {
    state.readData = { id: "conv-1", deleted_at: null };
    const res = await del({ email: "admin@acme.com", password: "secret" });
    expect(res.status).toBe(409);
  });

  it("refuses bad or non-admin credentials", async () => {
    state.adminOk = false;
    const res = await del({ email: "agent@acme.com", password: "secret" });
    expect(res.status).toBe(403);
  });

  it("deletes permanently with valid admin credentials", async () => {
    const { verifyAdminPassword } = await import("@/lib/auth/reauth");
    const res = await del({ email: " admin@acme.com ", password: "secret" });
    expect(res.status).toBe(200);
    expect(verifyAdminPassword).toHaveBeenCalledWith(
      "admin@acme.com",
      "secret",
      "acct-1",
    );
  });
});
