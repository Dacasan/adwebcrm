import { describe, expect, it, vi, beforeEach } from "vitest"

// ============================================================
// Tests de notifyNewLead (aviso de lead de formulario a
// EMAIL_FORWARD_TO). Contrato: never-throws (fail-open) y un envío
// por destino reutilizando la primitiva sendEmail.
// ============================================================

const { sendEmail, forwardTargets } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  forwardTargets: vi.fn(),
}))

vi.mock("@/lib/email/send", () => ({ sendEmail }))
vi.mock("@/lib/email/forward", () => ({ forwardTargets }))

import { notifyNewLead } from "./lead-notify"

const LEAD = {
  name: "María <González>",
  email: "maria@ejemplo.com",
  phone: "+525512340000",
  consent: true,
  refCode: "AW9-RZ3",
  landingSlug: "home",
  utm: { source: "google", medium: "cpc", campaign: "implantes" },
}

describe("notifyNewLead", () => {
  beforeEach(() => {
    sendEmail.mockReset()
    forwardTargets.mockReset()
  })

  it("sin destinos → skipped y NO envía nada", async () => {
    forwardTargets.mockReturnValue([])
    const res = await notifyNewLead("acct-1", LEAD)
    expect(res.status).toBe("skipped")
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it("con destinos → sent, un envío por destino con subject y datos", async () => {
    forwardTargets.mockReturnValue(["a@x.com", "b@x.com"])
    sendEmail.mockResolvedValue({ id: "mail-1" })

    const res = await notifyNewLead("acct-1", LEAD)

    expect(res.status).toBe("sent")
    expect(sendEmail).toHaveBeenCalledTimes(2)
    expect(sendEmail).toHaveBeenNthCalledWith(1, "acct-1", {
      to: "a@x.com",
      subject: "Nuevo lead: María <González>",
      html: expect.stringContaining("+525512340000"),
    })

    // El nombre free-form va escapado en el HTML (payload del cliente)
    const html = sendEmail.mock.calls[0][1].html as string
    expect(html).toContain("María &lt;González&gt;")
    expect(html).not.toContain("María <González>")
    expect(html).toContain("AW9-RZ3")
    expect(html).toContain("google")
  })

  it("sendEmail lanza → failed SIN excepción (fail-open)", async () => {
    forwardTargets.mockReturnValue(["a@x.com"])
    sendEmail.mockRejectedValue(new Error("resend caído"))

    await expect(notifyNewLead("acct-1", LEAD)).resolves.toEqual({
      status: "failed",
      detail: "resend caído",
    })
  })

  it("sin nombre → el subject usa el teléfono, en una sola línea", async () => {
    forwardTargets.mockReturnValue(["a@x.com"])
    sendEmail.mockResolvedValue({ id: "m" })

    await notifyNewLead("acct-1", { phone: "+525500000000", name: "  \n" })

    expect(sendEmail.mock.calls[0][1].subject).toBe("Nuevo lead: +525500000000")
  })
})
