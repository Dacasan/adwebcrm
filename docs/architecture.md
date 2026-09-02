# Architecture

Stack, folder layout, request lifecycles, and the security primitives.

## Stack

| Layer | Tool | Why |
|---|---|---|
| Rendering | **Next.js 16** (App Router), React 19 | Server components for data pages, client components where interaction demands it. |
| UI | **Tailwind v4** + in-house primitives in `src/components/ui` | Zero-runtime styling. Dark-theme-first. |
| Data + Auth | **Supabase** | Postgres with Row-Level Security, email/password auth, Storage for media, Realtime for the inbox. |
| Messaging | **Meta Cloud API**, **Twilio**, **Telnyx** | WhatsApp through the official Business API; SMS and voice through either carrier, chosen per number. |
| Email | **SendGrid** (outbound, campaigns), **Resend** (inbound parsing) | Separate concerns, separate credentials. |
| Validation | **Zod 4** | Request bodies and provider payloads. |
| Encryption | `node:crypto` AES-256-GCM | Provider credentials at rest, keyed per deployment. |
| Scheduling | External HTTP pinger | Three cron endpoints drained by an outside scheduler. |
| i18n | **next-intl**, three locales | `messages/{en,es,ko}.json`, kept in parity by tests. |

**No ORM and no GraphQL layer.** Server routes read and write Supabase directly
through `@supabase/ssr`. 28 runtime dependencies total.

Requires Node 20+ and pnpm.

## Folder layout

```
adwebcrm/
├─ src/
│  ├─ app/                            Next.js App Router
│  │  ├─ (auth)/                        login, signup, password reset
│  │  ├─ (dashboard)/                   authenticated UI
│  │  │  ├─ inbox/                        shared inbox, all channels
│  │  │  ├─ contacts/                     contacts, tags, custom fields
│  │  │  ├─ pipelines/                    kanban deals
│  │  │  ├─ broadcasts/                   WhatsApp campaigns
│  │  │  ├─ email/                        email campaigns and templates
│  │  │  ├─ calls/                        call log and recordings
│  │  │  ├─ automations/                  trigger-action builder and logs
│  │  │  ├─ flows/                        node-graph journeys and runs
│  │  │  ├─ appointments/                 scheduling with resources
│  │  │  ├─ agents/                       AI assistant and knowledge base
│  │  │  ├─ reports/                      acquisition and time-in-stage
│  │  │  ├─ media/                        media library
│  │  │  └─ settings/                     account, providers, tracking
│  │  ├─ api/                           102 JSON routes, server-only
│  │  ├─ join/                          invitation redemption
│  │  ├─ unsubscribe/                   public opt-out, no auth
│  │  └─ layout.tsx                     root layout and metadata
│  │
│  ├─ components/                     UI by feature, plus ui/ primitives
│  ├─ hooks/                          auth, realtime, presence
│  ├─ i18n/                           locale routing and parity tests
│  ├─ lib/
│  │  ├─ supabase/                      client.ts · server.ts · admin.ts
│  │  ├─ whatsapp/                      Meta client, encryption, signatures
│  │  ├─ providers/                     twilio/ · telnyx/ · sendgrid/
│  │  ├─ automations/                   engine, steps, validation
│  │  ├─ flows/                         node graph runtime
│  │  ├─ analytics/                     god.ts (the tracking script source)
│  │  ├─ conversions/                   Meta CAPI delivery
│  │  ├─ api-keys/                      hashing and verification
│  │  ├─ webhooks/                      outbound webhook signing
│  │  └─ rate-limit.ts                  per-key fixed window
│  ├─ types/                          shared TypeScript types
│  └─ middleware.ts                   session refresh and route guards
│
├─ supabase/migrations/               79 ordered SQL files
├─ mcp-server/                        MCP server over the public v1 API
├─ messages/                          en.json · es.json · ko.json
└─ docs/                              you are here
```

Counts as of this document: 102 API routes, 79 migrations, 142 test files,
54 tables with Row-Level Security enabled.

## The account is the unit of tenancy

Every row belongs to an account. Isolation is enforced twice: in the server on
the way in, and in Postgres on every read and write.

Three Supabase clients, and the difference is the whole security model:

| Module | Identity | Use |
|---|---|---|
| `lib/supabase/client.ts` | The signed-in user | Browser components |
| `lib/supabase/server.ts` | The signed-in user | Server routes acting for a user. RLS applies. |
| `lib/supabase/admin.ts` | Service role | Webhooks and cron, where no user is present. **Bypasses RLS** — server-only, never imported into a client component. |

A route that uses `supabaseAdmin()` must scope its own queries by
`account_id`, because the database will not do it for that identity.

## Request lifecycle: inbound WhatsApp message

```
 Meta Cloud API ──POST──▶ /api/whatsapp/webhook
                           │
                           ├─ read the RAW body first
                           │    request.json() would re-encode and break the HMAC
                           │
                           ├─ verifyMetaWebhookSignature(x-hub-signature-256)
                           │    lib/whatsapp/webhook-signature.ts
                           │    fail-closed: 401 if META_APP_SECRET is unset
                           │
                           ├─ supabaseAdmin() — no user in this request
                           ├─ resolve the account from the receiving number
                           ├─ find or create the contact
                           ├─ find or create the conversation
                           ├─ insert the message row
                           │
                           ├─ runAutomationsForTrigger(...)
                           │    lib/automations/engine.ts
                           │
                           └─ 200 OK — Meta retries on anything else

 Realtime fan-out:
   messages INSERT ──▶ Supabase Realtime ──▶ inbox subscription
                                              appends without a refetch
```

Twilio, Telnyx, SendGrid and Resend webhooks follow the same shape: verify the
signature, resolve the account, write, respond 200.

## Request lifecycle: outbound message

```
 Composer ──fetch──▶ /api/whatsapp/send
                      │
                      ├─ createClient() — user-scoped, RLS applies
                      ├─ auth.getUser() — 401 if unauthenticated
                      ├─ checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
                      │
                      ├─ read the channel config row (RLS-scoped)
                      ├─ decrypt the provider credential
                      │    lib/whatsapp/encryption.ts
                      │
                      ├─ call the provider API
                      ├─ insert the message row
                      └─ 200 + provider message id
```

## Public surface

Three groups of routes are reachable without a session, and each has its own
guard:

| Surface | Routes | Guard |
|---|---|---|
| Provider webhooks | `whatsapp/webhook`, `telnyx/webhook`, `twilio/[token]/*`, `sendgrid/[token]/webhook`, `email/inbound`, `email/webhook` | Signature verification, per provider. Twilio and SendGrid also carry a 256-bit token in the path. |
| Site tracking | `POST /api/events`, `GET/POST /api/track` | Rate limit per IP **before** any database call; the account is resolved server-side and never read from the payload. |
| Cron | `automations/cron`, `conversions/cron`, `flows/cron` | Shared secret header. Called by an external scheduler. |

The authenticated public API lives under `/api/v1` and is keyed, not
session-based — see [Public API](./public-api.md).

## Security primitives

- **Row-Level Security** on all 54 tables. Policies filter by account. The
  service-role client bypasses RLS and is confined to server-only modules.
- **Credential encryption** — `lib/whatsapp/encryption.ts`, AES-256-GCM with
  `ENCRYPTION_KEY` (64 hex characters, per deployment). Decryption failures are
  surfaced to the user as "re-enter the credential", never silently ignored.
- **Webhook signatures** — one verifier per provider, each with unit tests:
  `lib/whatsapp/webhook-signature.ts`, `lib/providers/twilio/signature.ts`,
  `lib/providers/sendgrid/signature.ts`. All fail closed.
- **API keys** — `lib/api-keys/keys.ts`. Generated with `randomBytes(32)`,
  stored hashed, compared with `timingSafeEqual`.
- **Rate limiting** — `lib/rate-limit.ts`, per-key fixed window held in a
  process-local `Map`. Replace with Redis before scaling horizontally.
- **Session handling** — `src/middleware.ts` refreshes the Supabase session and
  redirects unauthenticated requests away from `(dashboard)` routes.

## Multi-brand deployment

One codebase, one deployment per brand. `NEXT_PUBLIC_*` variables are inlined
at build time, so a single image cannot serve two brands. Each brand gets its
own build, its own Supabase project and its own `.env`.

## Where to change things

| Want to change… | Start here |
|---|---|
| Inbox behaviour | `src/app/(dashboard)/inbox/` + `src/components/inbox/` |
| A new channel provider | `src/lib/providers/<name>/` — mirror the Twilio module |
| Automation triggers or actions | `src/lib/automations/engine.ts`, `steps-tree.ts` |
| Flow node types | `src/lib/flows/` + `src/components/flows/` |
| Add a database column | New migration in `supabase/migrations/NNN_*.sql`, then `src/types/` |
| Rate limits | `RATE_LIMITS` in `src/lib/rate-limit.ts` |
| A new API route | `src/app/api/<name>/route.ts`, following an existing one |
| Anything with UI text | The route or component **and all three files** in `messages/` |
| The tracking script | `src/lib/analytics/god.ts`, built by `pnpm build:god` |

## Rules this codebase enforces

- **Three locales or none.** Every UI string exists in `en`, `es` and `ko`. Two
  tests fail otherwise.
- **Reuse the primitive.** Tenancy, sending, ingestion, interpolation, rate
  limiting, queueing and signature verification already exist. Duplicating one
  is the most expensive mistake available here, because copies drift silently.
- **Never rename `__WACRM_API_URL__`.** It is a wire identifier shared with the
  client sites, which deploy independently. Renaming it on one side stops lead
  capture with no error.
- **Do not change the hidden input names in the site's contact form** without a
  matching change in `src/lib/analytics/god.ts`. Mismatched names fail silently.
- **pnpm only.**

## Verify these numbers

```bash
find src/app/api -name route.ts | wc -l            # API routes
ls supabase/migrations/*.sql | wc -l               # migrations
find src -name '*.test.ts*' | wc -l                # test files
grep -rhoiE 'alter table [^;]*enable row level security' \
  supabase/migrations/ | sort -u | wc -l           # tables with RLS
```
