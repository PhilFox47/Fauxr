# AGENTS.md

Guidance for coding agents working on Fauxr. The README is the long-form design history;
this file is the short version of what you need before changing anything.

## What this is

A self-hosted, single-user adult fantasy app shaped like a hookup app: swipe, match, chat,
go on dates, explore fantasies. Every character is a generated adult woman (age is never
below 18, enforced at generation) with her own personality, texting voice, sexual persona,
kinks, hard limits and fantasies.

The design rule that overrides almost everything else: **there is nothing to win.**
Characters are into the user from the start; they differ in *how* (their pace and persona),
not in whether he has earned something. So:

- No stats that gate content, no unlocks, no trust/spark scoring, no tests, no ghosting or
  blocking by her. These existed once and were removed deliberately (see the README section
  "The rebuild"). Do not reintroduce stored-value gates; if something needs judgment, give it
  to the Director as guidance.
- Her hard limits are the only real "no". They are part of the fiction, not a hedge.
- Characters should drive: pitch fantasies, start things, send photos, flirt unprompted.
- The one deliberate cost gate: **nothing image-related is generated for a character until
  the user presses "swap profile pictures"** (`photos_exchanged`). Image generation is
  expensive; keep all image spend behind a user action.

## Layout

```
server/            Fastify + better-sqlite3 API, the whole game engine (TypeScript, ESM)
  src/engine/      director.ts, actor.ts, chat.ts, dates.ts, generator.ts, images.ts, ...
  src/prompts/templates/*.md   every LLM prompt; rendered by prompts/render.ts
  src/data/attributes/*.json   the attribute tables characters are rolled from
  src/db/          schema.sql, migrations (ADDED_COLUMNS), attribute seeding
  src/repo.ts      all SQL; also the per-character seed backfills
  src/llm/client.ts  the only place that talks to the model provider
  scripts/         copy-assets.mjs (build step), validate-attributes.mjs
web/               React 19 + Vite PWA; builds into server/public
data/              runtime state (SQLite, uploads, images) - gitignored, never commit
```

## Commands

Node >= 22. npm workspaces; run from the repo root unless noted.

```bash
npm install
npm run typecheck                    # both workspaces - run before every commit
npm run build                        # web first (into server/public), then server
npm run dev                          # API on :8080, Vite on :5173 with proxy
node server/scripts/validate-attributes.mjs   # after ANY change to src/data/attributes
docker compose up --build            # production-like run
```

There is no test framework. Verify changes with a throwaway script against the built
`server/dist`, pointing `FAUXR_DATA_DIR` at a temporary directory so the real database is never
touched:

```bash
npm run build --workspace=server
FAUXR_DATA_DIR=$(mktemp -d) node my-check.mjs    # import from server/dist/...
```

Call `migrate()` and `seedAttributes()` first in such scripts. For HTTP routes, build a Fastify
instance, `registerApi(app)` and use `app.inject`. No API key is needed unless you actually
want model output; a dead `base_url` makes LLM calls fail fast and fall back.

## How a turn works

Two model roles:

- **Director** (`engine/director.ts`, `director_direction.md`): runs only when needed. It
  updates arousal, discoveries and the ledger (her memory), writes the next direction and
  schedules one wakeup. It returns `{ update, direction, wakeup }`.
- **Actor** (`engine/actor.ts`, `actor_chat.md`): runs every turn and writes her messages as
  JSON, `{ messages, hidden }`. `hidden` reports mood, situation, a photo she is sending, a
  fantasy she pitched, etc. It never sees numbers.

Dates (`engine/dates.ts`, `actor_date.md`) are a separate in-person transcript with their
own turn loop. The text chat is frozen while a date is active.

## Conventions

- **Prompts are ordered static-first.** Everything identical across turns goes above the
  `<!-- Static half above... -->` comment and everything per-turn goes below, so providers can
  prefix-cache. Do not add a per-turn value to the static half.
- **Template syntax** (`prompts/render.ts`): `{{name}}` substitutes (empty if missing),
  `{{#name}}...{{/name}}` keeps the block only when the value is non-empty. Do not nest
  sections with the same name. Unknown variables render empty silently, so re-render a
  changed template in a check script and assert no `{{` survives.
- **Keep prompts short and positive.** They were cut from 11-14k tokens of rules to short
  briefs because stacked rules made characters stilted. Describe the character and the
  moment; add a rule only for a failure you have actually seen in a log.
- **LLM calls go through `completeJson`** with `require: [...]` for the keys the answer is
  useless without. Its error types matter: `TruncatedError` (retry with more room),
  `TransportError` (wait and retry), `TimeoutError` (our clock ran out, never treated as
  bad JSON). Big background calls pass a larger `timeoutMs`.
- **Attribute tables are data, not code.** Behaviour hangs off `extra` fields (`weights`,
  `ranges`, `kink_bias`, `pace`, `initiative`, ...) rather than `if (id === '...')`. Rows are
  seeded by content hash; removed ids and whole removed categories are pruned on upgrade.
- **Schema changes** are additive: add a column to `ADDED_COLUMNS` in `db/index.ts`, never
  drop one. One-off data fixes go at the end of `migrate()` and must be idempotent.
- **New seed fields** need a backfill in `repo.ts` (`hydrateCharacter`) so existing characters
  get them on first load, conditioned on what they already have.
- **Comments explain why**, usually with the concrete failure that motivated the code. Match
  the surrounding density.
- **English everywhere**: UI, prompts, attribute text, docs.
- **Document behaviour changes in the README** in the same commit.

## Things that have bitten before

- `dist/` is not cleaned by `tsc`; `copy-assets.mjs` wipes `dist/data` and
  `dist/prompts/templates` so a deleted table or template cannot keep being loaded.
- `fetch` reports our own abort as a bare `AbortError`; the client converts it to
  `TimeoutError`. Do not catch LLM errors generically and re-ask as if the JSON were bad.
- Node's built-in `fetch` (undici) gives up after 5 minutes without response headers and says
  only "fetch failed". A non-streaming call gets no headers until the model finishes, so
  `llm/client.ts` uses undici's own `fetch` with an `Agent` whose timeouts are off; our
  AbortController is the only clock. Do not switch back to the global `fetch`.
- Anything the whole cast sees identically (his profile and bio, generic curiosity lists,
  stock nudge texts, default typing rules) becomes the same line from every character. Tie
  prompts to her own seed.
- A character's own fields must stay consistent: a fetish is only drawn from a kink domain
  she is into or curious about, and a hard limit only from one she is a hard no on
  (`rollKinkMap` and the lines after it in `generator.ts`).
- Ids are unique per category, not globally, and `ctx.drawn` mixes every category. An id that is
  both a language and an ethnicity (`japanese`) matches the other one's affinities and
  conflicts too. Suffix new ethnicities (`swedish_ethnic`) and keep languages rolled after looks.
- Characters must never talk in system language (trust, levels, unlocks, scores, "testing
  you"); `engine/voice.ts` has detectors that reject and retry such replies.
