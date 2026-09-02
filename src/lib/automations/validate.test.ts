import { describe, expect, it } from "vitest";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./validate";

describe("validateStepsForActivation", () => {
  it("rejects empty or missing step lists", () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
    expect(
      validateStepsForActivation(undefined as unknown as never[]),
    ).toEqual([
      { path: "steps", message: "active automations need at least one step" },
    ]);
  });

  it("passes a fully-populated step set", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "hi" } },
      {
        step_type: "wait",
        step_config: { amount: 5, unit: "minutes" },
      },
      { step_type: "add_tag", step_config: { tag_id: "tag-uuid" } },
      { step_type: "close_conversation", step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags every required field that is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "send_message", step_config: { text: "  " } },
      { step_type: "send_template", step_config: {} },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].text",
      "steps[1].template_name",
      "steps[2].tag_id",
    ]);
  });

  it("checks wait amount and unit boundaries", () => {
    const issues = validateStepsForActivation([
      { step_type: "wait", step_config: { amount: 0, unit: "minutes" } },
      { step_type: "wait", step_config: { amount: 5, unit: "seconds" } },
      { step_type: "wait", step_config: { amount: -1, unit: "hours" } },
      {
        step_type: "wait",
        step_config: { amount: Number.POSITIVE_INFINITY, unit: "days" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].amount",
      "steps[1].unit",
      "steps[2].amount",
      "steps[3].amount",
    ]);
  });

  it("allows negative wait offsets when until is set (pre-appointment reminders)", () => {
    // El runtime (engine.ts waitMs) interpreta amount<=0 como offset antes
    // de la fecha absoluta `until`: -1 hour = 1h antes de la cita. La
    // validación debe espejar eso, no rechazarlo como un wait relativo.
    const issues = validateStepsForActivation([
      {
        step_type: "wait",
        step_config: {
          amount: -1,
          unit: "hours",
          until: "{{vars.appointment_start_at}}",
        },
      },
      {
        step_type: "wait",
        step_config: {
          amount: -15,
          unit: "minutes",
          until: "2026-08-20T09:00:00Z",
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("validates webhook URLs", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "https://hooks.example.com/in" },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: "send_webhook", step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain("webhook URL is required");

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: "send_webhook",
        step_config: { url: "ftp://files.example.com" },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      "webhook URL must use http or https",
    );

    const garbage = validateStepsForActivation([
      { step_type: "send_webhook", step_config: { url: "not a url" } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      "webhook URL is not a valid URL",
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: "assign_conversation",
        step_config: { mode: "round_robin" },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: "assign_conversation", step_config: { mode: "specific" } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      "steps[0].agent_id",
    ]);
  });

  it("flags create_deal when required fields are missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "create_deal", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].pipeline_id",
      "steps[0].stage_id",
      "steps[0].title",
    ]);
  });

  it("validates send_buttons / send_list interactive payloads", () => {
    const good = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [{ id: "yes", title: "Yes" }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: "send_buttons",
        step_config: {
          kind: "buttons",
          body: "Pick one",
          buttons: [
            { id: "a", title: "A" },
            { id: "b", title: "B" },
            { id: "c", title: "C" },
            { id: "d", title: "D" },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(["steps[0].interactive"]);
  });

  it("flags update_contact_field when field or value is missing", () => {
    const issues = validateStepsForActivation([
      { step_type: "update_contact_field", step_config: { field: "name" } },
      {
        step_type: "update_contact_field",
        step_config: { field: "", value: "x" },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].value",
      "steps[1].field",
    ]);
  });

  it("recursively walks condition branches with stable dot-paths", () => {
    const issues = validateStepsForActivation([
      {
        step_type: "condition",
        step_config: { subject: "tag", operand: "vip" },
        branches: {
          yes: [{ step_type: "add_tag", step_config: { tag_id: "" } }],
          no: [
            {
              step_type: "send_message",
              step_config: { text: "" },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      "steps[0].yes.steps[0].tag_id",
      "steps[0].no.steps[0].text",
    ]);
  });

  it("reports an issue for unknown step types", () => {
    const issues = validateStepsForActivation([
      { step_type: "do_a_barrel_roll", step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: "steps[0]", message: "unknown step type: do_a_barrel_roll" },
    ]);
  });

  it("flags condition subject/operand independently", () => {
    const issues = validateStepsForActivation([
      { step_type: "condition", step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      "steps[0].operand",
      "steps[0].subject",
    ]);
  });
});

describe("validateTriggerForActivation", () => {
  it("accepts a valid keyword_match config", () => {
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hello", "hi"],
        match_type: "exact",
      }),
    ).toEqual([]);
  });

  it("rejects keyword_match with empty keyword array", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: [],
      match_type: "exact",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.keywords");
  });

  it("rejects keyword_match with whitespace-only entries", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi", "   "],
      match_type: "contains",
    });
    expect(issues.map((i) => i.message)).toContain(
      "keywords cannot be empty strings",
    );
  });

  it("rejects keyword_match with an unknown match_type", () => {
    const issues = validateTriggerForActivation("keyword_match", {
      keywords: ["hi"],
      match_type: "fuzzy",
    });
    expect(issues.map((i) => i.path)).toContain("trigger.match_type");
  });

  it("accepts keyword_match with a missing match_type (defaults to contains)", () => {
    expect(
      validateTriggerForActivation("keyword_match", { keywords: ["hi"] }),
    ).toEqual([]);
  });

  it("accepts the word match_type (issue #409)", () => {
    // Activation validation has to stay in step with the engine and the
    // builder's dropdown — an automation the UI can save must not be
    // rejected on activation.
    expect(
      validateTriggerForActivation("keyword_match", {
        keywords: ["hi"],
        match_type: "word",
      }),
    ).toEqual([]);
  });

  it("requires schedule on time_based triggers", () => {
    expect(validateTriggerForActivation("time_based", {})).toEqual([
      { path: "trigger.schedule", message: "schedule is required" },
    ]);
    expect(
      validateTriggerForActivation("time_based", { schedule: "0 9 * * *" }),
    ).toEqual([]);
  });

  it("requires tag_id on tag_added triggers", () => {
    expect(validateTriggerForActivation("tag_added", {})).toEqual([
      { path: "trigger.tag_id", message: "tag is required" },
    ]);
    expect(
      validateTriggerForActivation("tag_added", { tag_id: "tag-uuid" }),
    ).toEqual([]);
  });

  it("requires reply_ids on interactive_reply triggers", () => {
    expect(validateTriggerForActivation("interactive_reply", {})).toEqual([
      { path: "trigger.reply_ids", message: "at least one reply id is required" },
    ]);
    expect(
      validateTriggerForActivation("interactive_reply", { reply_ids: ["yes", "no"] }),
    ).toEqual([]);
    const empties = validateTriggerForActivation("interactive_reply", {
      reply_ids: ["yes", "  "],
    });
    expect(empties.map((i) => i.message)).toContain(
      "reply ids cannot be empty strings",
    );
  });

  it("does not flag unknown trigger types (handled elsewhere)", () => {
    expect(validateTriggerForActivation("some_future_trigger", {})).toEqual([]);
  });

  it("accepts no-config triggers: message_delivered / message_failed (Telnyx delivery)", () => {
    // Terminal SMS status arrives via Telnyx `message.finalized`; there
    // is no user-editable payload, so activation must not require one.
    expect(validateTriggerForActivation("message_delivered", {})).toEqual([]);
    expect(validateTriggerForActivation("message_failed", {})).toEqual([]);
  });

  it("accepts no-config triggers: appointment_* lifecycle (internal calendar)", () => {
    // Fired server-side from the appointments API with
    // vars.appointment_start_at injected into context; no config needed.
    expect(validateTriggerForActivation("appointment_created", {})).toEqual([]);
    expect(validateTriggerForActivation("appointment_updated", {})).toEqual([]);
    expect(validateTriggerForActivation("appointment_rescheduled", {})).toEqual([]);
    expect(validateTriggerForActivation("appointment_cancelled", {})).toEqual([]);
    expect(validateTriggerForActivation("appointment_completed", {})).toEqual([]);
    expect(validateTriggerForActivation("appointment_no_show", {})).toEqual([]);
  });

  it("accepts deal_stage_changed with no filters (any stage move)", () => {
    // Los tres filtros son opcionales; sin ninguno la automatización
    // dispara en cualquier movimiento, que es una configuración válida.
    expect(validateTriggerForActivation("deal_stage_changed", {})).toEqual([]);
    expect(
      validateTriggerForActivation("deal_stage_changed", {
        pipeline_id: "pipe-1",
      }),
    ).toEqual([]);
    expect(
      validateTriggerForActivation("deal_stage_changed", {
        pipeline_id: "pipe-1",
        from_stage_id: "stage-a",
        to_stage_id: "stage-b",
      }),
    ).toEqual([]);
  });

  it("rejects deal_stage_changed filters that are present but empty", () => {
    // Un filtro vacío es indistinguible de 'cualquiera' en runtime, así
    // que el usuario activaría creyendo que acotó el disparo.
    const issues = validateTriggerForActivation("deal_stage_changed", {
      pipeline_id: "  ",
      from_stage_id: "",
      to_stage_id: "stage-b",
    });
    expect(issues.map((i) => i.path).sort()).toEqual([
      "trigger.from_stage_id",
      "trigger.pipeline_id",
    ]);
    expect(issues.map((i) => i.message)).toContain(
      "pipeline_id must be a non-empty string",
    );
  });

  it("rejects deal_stage_changed with the same from and to stage", () => {
    const issues = validateTriggerForActivation("deal_stage_changed", {
      from_stage_id: "stage-a",
      to_stage_id: "stage-a",
    });
    expect(issues).toEqual([
      {
        path: "trigger.to_stage_id",
        message: "from and to stages cannot be the same",
      },
    ]);
  });

  it("accepts deal_created / deal_won / deal_lost with or without pipeline", () => {
    // El filtro de pipeline es opcional: sin él la automatización dispara
    // en toda la cuenta, que es una configuración legítima.
    for (const trigger of ["deal_created", "deal_won", "deal_lost"] as const) {
      expect(validateTriggerForActivation(trigger, {})).toEqual([]);
      expect(
        validateTriggerForActivation(trigger, { pipeline_id: "pipe-1" }),
      ).toEqual([]);
    }
  });

  it("rejects a present-but-empty pipeline on deal_created / deal_won / deal_lost", () => {
    // Mismo motivo que en deal_stage_changed: un filtro vacío es
    // indistinguible de 'cualquiera' en runtime.
    for (const trigger of ["deal_created", "deal_won", "deal_lost"] as const) {
      expect(validateTriggerForActivation(trigger, { pipeline_id: "  " })).toEqual([
        {
          path: "trigger.pipeline_id",
          message: "pipeline_id must be a non-empty string",
        },
      ]);
      expect(validateTriggerForActivation(trigger, { pipeline_id: "" })).toEqual([
        {
          path: "trigger.pipeline_id",
          message: "pipeline_id must be a non-empty string",
        },
      ]);
    }
  });

  it("does not apply the stage checks to the deal lifecycle triggers", () => {
    // Estos disparadores no filtran por etapa: unas claves de etapa
    // sobrantes (p.ej. arrastradas de un tipo anterior) no son asunto suyo
    // y no deben bloquear la activación.
    expect(
      validateTriggerForActivation("deal_won", {
        pipeline_id: "pipe-1",
        from_stage_id: "stage-a",
        to_stage_id: "stage-a",
      }),
    ).toEqual([]);
  });
});
