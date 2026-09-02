# adwebcrm

An open, self-hostable **multichannel** CRM. WhatsApp, SMS, voice and email land
in one shared inbox, against one contact, with one automation engine behind them.

Built on Next.js and Supabase. MIT licensed. Runs on your own infrastructure.

---

## Where this came from

adwebcrm started as a fork of **[wacrm](https://github.com/ArnasDon/wacrm)** by
[Arnas Donauskas](https://github.com/ArnasDon) — an excellent self-hostable
WhatsApp CRM template, MIT licensed. The shared inbox, the contact model, the
pipeline primitives and the no-code automation builder are his design, and this
project would not exist without that head start. **Go star the original.**

What we did was take it multichannel. WhatsApp was the only way in; now SMS,
voice and email arrive through the same conversation and the same inbox, with a
provider layer underneath and marketing attribution wired through it end to end.

That turned out to be a large enough change that this lives as its own project
rather than a fork sitting behind upstream. Upstream stays where it is, does
what it does well, and keeps its own roadmap.

---

## What it does

**Conversations**

- One shared inbox across WhatsApp, SMS, voice and email — the channel is a tag
  on the message, not a separate silo
- Contacts with custom fields, tags, notes and a full activity history
- Quick replies, message templates, reactions, media library
- Real-time presence so two people don't answer the same thread

**Channels**

| Channel | Providers |
|---|---|
| WhatsApp | WhatsApp Business Platform (Cloud API) — templates, broadcasts, media |
| SMS | Twilio · Telnyx |
| Voice | Twilio Voice SDK · Telnyx WebRTC — in-browser calling, recordings |
| Email | SendGrid · Resend — transactional, inbound parsing, campaigns |

Provider routing is configurable, so a number can move between providers without
touching a conversation.

**Sales**

- Pipelines and deals with stage transitions and time-in-stage reporting
- Appointments with resource scheduling
- Acquisition reporting

**Automation**

- Visual automation builder — a trigger fires (message in, deal moved, call
  missed) and runs a sequence: send, tag, wait, branch
- Flows: a node graph for longer, stateful journeys, with per-run event logs
- Broadcasts and email campaigns with recipient tracking and frequency caps

**AI**

- Assistant with a retrieval knowledge base — upload documents, they get chunked
  and embedded, answers are grounded in them
- Draft suggestions and optional autoreply, per conversation
- Usage logging per account

**Marketing attribution**

- First-party tracking script, server-side event collection, Meta CAPI delivery
- Click IDs and referrer survive from the landing page through to the deal

**Integrations**

- Public REST API under `/api/v1` — contacts, conversations, messages,
  broadcasts, outbound webhooks, scoped API keys
- An **MCP server**, so you can drive the CRM from Claude, Cursor, or any other
  MCP client
- English, Spanish and Korean, kept in parity by tests

---

## How it's built

| Layer | What |
|---|---|
| App | Next.js 16 (App Router), React 19 |
| Data, auth, realtime | Supabase — Postgres with row-level security |
| Styles | Tailwind 4 over a small set of in-house UI primitives |
| Tests | Vitest — 142 test files |
| Deploy | Node 20+, pnpm. `Dockerfile` and `docker-compose.yml` included |

**One idea explains most of the design: the account.** Every row belongs to an
account, and isolation is enforced twice — in the server on the way in, and in
Postgres itself on every read and write. Roles run from owner to read-only, and
the same policy applies on both sides.

**Channels converge.** WhatsApp, SMS, voice and email arrive through different
doors and end up in the same conversation. The only thing separating them is a
channel marker on each message.

**Automations are the engine.** Something happens, a sequence runs. Triggers and
available steps are enumerated in [`docs/CRM.md`](./docs/CRM.md), which is
generated from the code and the schema and is the document to read before
changing anything.

---

## Honest notes

**This was largely built with AI.** Vibecoded, iterated fast, shipped against a
real clinic's daily operations. We're saying so up front because you should know
what you're reading before you run it against your own customers.

That is not the same as unreviewed. What is actually true, and checkable:

- **Row-level security is enabled on all 54 tables.** Tenant isolation is a
  database constraint, not a convention in application code
- **Every provider webhook verifies its signature** — Twilio, Telnyx, SendGrid,
  Meta and Resend — each with unit tests next to the implementation
- **Provider credentials are encrypted at rest** with a per-deployment key, and
  the code fails closed when it cannot decrypt
- **Public endpoints are rate-limited per IP before touching the database**, and
  resolve the tenant server-side rather than trusting the request payload
- No secrets in the repository, and none in its history

Security reports go to [`.github/SECURITY.md`](./.github/SECURITY.md) — please
don't open a public issue for those.

**What it is not:** not a hosted product, not third-party audited, and not
multi-brand within a single deployment — `NEXT_PUBLIC_*` values are inlined at
build time, so each brand gets its own build and its own Supabase project.

---

## Getting started

Requires Node 20+ and pnpm.

```bash
pnpm install
cp .env.local.example .env.local   # 7 variables, all documented in the file
pnpm dev
```

Before considering any change good:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Database credentials and provider secrets come from environment variables in
development and from the app's settings screen in production. **There are no
credentials in this repository and none should be added** — provider secrets are
stored encrypted in the database.

---

## Contributing

Yes, please. Being vibecoded means there is plenty here that a careful reader
will improve, and we'd rather that happen in the open.

Useful places to start: the [open issues](https://github.com/Dacasan/adwebcrm/issues),
anything in `docs/CRM.md` that no longer matches the code, and test coverage on
the provider adapters. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) and the PR
template.

House rules that will save you a round trip: pnpm only, the full suite green
before review, and any UI string added to all three locale files.

---

## License

[MIT](./LICENSE) — as is upstream.

Copyright (c) 2026 Arnas Donauskas (original wacrm)
Copyright (c) 2026 DannyCasan (adwebcrm)

WhatsApp is a trademark of Meta Platforms, Inc. This project is not affiliated
with or endorsed by Meta. Twilio, Telnyx, SendGrid and Resend are trademarks of
their respective owners.
