import { beforeEach, describe, expect, it, vi } from "vitest"

// GET /api/telnyx/recordings/[callId] — proxy autenticado (signed URL 5 min).

const RANK: Record<string, number> = { viewer: 0, agent: 1, admin: 2, owner: 3 }

vi.mock("@/lib/auth/account", async (importOriginal) => {
  const actual = (await importOriginal()) as { ForbiddenError: new (m: string) => Error }
  return {
    ...actual,
    requireRole: vi.fn(async (min: string) => {
      if (RANK.agent < RANK[min]) throw new actual.ForbiddenError(`requires ${min}`)
      return { accountId: "acct-1", role: "agent", supabase: {}, account: { id: "acct-1", name: "Acme" } }
    }),
  }
})

// El handler vive ahora en `/api/calls/[callId]/recording` y esta ruta lo
// re-exporta; el test se queda aquí a propósito, porque la URL vieja está
// persistida en `calls.recording_url` de filas antiguas y tiene que seguir
// sirviendo. Se mockean los DOS alias del cliente service-role: el handler
// importa el canónico `@/lib/supabase/admin` y `@/lib/telnyx/admin-client`
// es solo un re-export suyo.
const { adminFactory } = vi.hoisted(() => {
  const state = { storagePath: null as string | null, signedUrlOk: true }
  return {
    adminFactory: () => ({
      supabaseAdmin: vi.fn(() => {
        const storage = {
          from: vi.fn(() => ({
            createSignedUrl: vi.fn(async (path: string, expire: number) =>
              state.signedUrlOk
                ? {
                    data: {
                      signedUrl: `https://x.supabase.co/storage/signed?path=${path}&e=${expire}`,
                    },
                    error: null,
                  }
                : { data: null, error: new Error("storage error") },
            ),
          })),
        }
        const db = {
          from: vi.fn((table: string) => {
            const b: Record<string, unknown> = {}
            b.select = vi.fn(() => b)
            b.eq = vi.fn(() => b)
            b.maybeSingle = vi.fn(async () =>
              table === "calls"
                ? {
                    data: state.storagePath
                      ? { recording_storage_path: state.storagePath }
                      : null,
                    error: null,
                  }
                : { data: null, error: null },
            )
            return b
          }),
        }
        return { ...db, storage }
      }),
      __state: state,
    }),
  }
})

vi.mock("@/lib/telnyx/admin-client", adminFactory)
vi.mock("@/lib/supabase/admin", adminFactory)

import { GET } from "./route"
import * as adminModule from "@/lib/supabase/admin"

const mockState = (adminModule as unknown as {
  __state: { storagePath: string | null; signedUrlOk: boolean }
}).__state

function get() {
  return GET(new Request("http://localhost/api/telnyx/recordings/call-1") as never, {
    params: Promise.resolve({ callId: "call-1" }),
  })
}

beforeEach(() => {
  mockState.storagePath = "account-acct-1/1700000000000-recording.mp3"
  mockState.signedUrlOk = true
})

describe("GET /api/telnyx/recordings/[callId]", () => {
  it("redirige (302) a la signed URL de 5 min", async () => {
    const res = await get()
    expect(res.status).toBe(302)
    const loc = res.headers.get("location")
    expect(loc).toContain("account-acct-1/1700000000000-recording.mp3")
    expect(loc).toContain("e=300")
  })

  it("404 cuando la llamada no tiene grabación", async () => {
    mockState.storagePath = null
    const res = await get()
    expect(res.status).toBe(404)
  })

  it("500 cuando falla la firma del storage", async () => {
    mockState.signedUrlOk = false
    const res = await get()
    expect(res.status).toBe(500)
  })
})