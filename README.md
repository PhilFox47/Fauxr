# Fauxr

A self-hosted, single-user dating simulator. Not a roleplay frontend — a dating platform
simulation: you swipe, you match, you chat, you build trust, and you can lose it.

Characters have their own goals, their own schedules and their own hidden thresholds.
Nothing happens because a number crossed a line; numbers only decide what the Director
*considers*. What actually happens, happens in the conversation.

The UI and all model prompts are in English.

---

## Run it

```bash
cp .env.example .env      # optional: pre-fill the API key
docker compose up --build
```

Open http://localhost:8080 on your phone or desktop. It installs as a PWA.

Everything in `.env` can also be set later on the Settings page, and values saved there
win over the environment.

### Without Docker

```bash
npm install
npm run build
npm start            # serves the API and the built frontend on :8080
```

For development, `npm run dev` starts the API on :8080 and Vite on :5173 with a proxy.

### Data

The SQLite database, uploads and generated images live in the `fauxr-data` volume
(`/data` in the container, `./data` when running locally). Delete the volume to start over.

### Uptime window

The app is built for a machine that is up 06:00–02:00. Outside that window nothing runs in
the background — that is intended, not a bug. On every start a catch-up job re-spreads
overdue wakeups, applies elapsed investment decay, drops expired negative flags and lets
anyone whose investment ran out start ghosting. The window is configurable in Settings.

---

## Models

All LLM and image calls go through one OpenAI-compatible endpoint (Nano-GPT by default).
Three roles, configured separately in Settings:

| Role | Default | Job |
|---|---|---|
| Actor | `z-ai/glm-5.3-flash-uncensored` | writes every chat and date message, and the bios |
| Director | `google/gemma-4-31b-it` | direction, stats, ledger, generation, vision |
| Image | `seedream-v4` | profile and in-chat images |

Nothing is hardcoded: base URL, key, model name and sampling parameters are all editable,
and `server/src/llm/client.ts` is the only place that knows about the provider.

Without an API key the app still runs. Characters generate from the dice tables with
fallback names and bios, so the swipe stack and the UI can be exercised offline.

---

## How a turn works

```
user message
   │
   ├─ code: reciprocity + pressure recomputed (never the LLM)
   ├─ she is offline?  → message waits, unread. Nothing else happens.
   │
   ├─ Director runs only when needed:
   │     valid_for spent · actor asked for it · an expires_on condition fired
   │     · a wakeup is due · the session went stale · a boundary was touched (immediately)
   │     → scores against her touchstone, updates stats/flags/ledger,
   │       writes the next direction, schedules her one wakeup
   │
   └─ Actor runs every turn
         sees the direction, never the numbers
         segments its own messages and sets its own delays
         reports back through a hidden channel
```

Target ratio is roughly one Director call per three to five Actor calls.

### Stats

`trust`, `spark` and `investment` are 0–100. The Director proposes deltas; the code then
applies two modifiers it computes itself:

- **reciprocity** — questions asked of her versus statements about himself, over the last
  ~20 messages. Both extremes are punished; a balanced conversation earns full value.
- **pressure** — how often he pushed after a dodge or a refusal, with a 12-hour half-life.
  High pressure damps gains and amplifies losses.

That is the anti-simp and anti-push mechanism, and it is deliberately not an LLM judgement.

### Flags

Flags are set by events, not by thresholds. `real_name_known` goes true because she said
her name, not because trust hit 40. The stat only decides whether the Director may offer
the `unlock` at all. State flags can be taken back; milestones cannot; negative flags
expire on their own.

### Failing

Three stages, all reachable: cooling off (reversible with effort), ghosting (one
reactivation attempt), and a block (a dealbreaker, or pushing past a clear no). You can
block her too.

---

## The chat must not read like roleplay

This is the hardest part of the project, because roleplay prose dominates the training
data. Three defences:

1. The Actor's system prompt forbids asterisk actions, narration, scene description and
   any third-person sentence about herself, in explicit terms.
2. `detectRoleplay()` in `server/src/engine/actor.ts` checks every message before it is
   stored. On a hit the turn is re-requested once with a sharper instruction, and after a
   second failure a neutral one-liner is sent instead. Prose never reaches the chat.
3. Delays, message counts and lengths are clamped by the server, not left to the model.

Voice messages are the single exception: they may be rambling spoken prose, because that
is what a voice note is. Narration stays forbidden there too.

---

## Character generation

Every seed is rolled once and never changes. Raw random rolls produce unusable people, so
coherence is enforced in three stages:

1. **Archetype first.** It re-weights every other table, sets the count curves for
   tattoos, piercings, accessories and languages, and bounds the sexual stats. Weights are
   lowered, never zeroed — outliers should be rare, not impossible.
2. **Affinities and conflicts.** Drawing "anime" raises the odds of cosplay, gaming and
   Japanese. Implausible physical combinations are blocked outright.
3. **A Director pass** that may swap at most two tags, and writes the free-text parts:
   name, handle, her concrete insecurity, why she is really here, and her online windows.

`search_motive`, `touchstone`, `turn_ons` and `turn_offs` are rolled *without* the
archetype filter, on purpose. A character who ticks differently than she looks is the
interesting case.

### Bios

The bio is the only thing you see before swiping, so it gets its own call, and it goes to
the *Actor* model rather than the Director: it is in-voice writing, not analysis. The
Director still designs the character, it just does not write her lines.

Two things keep the stack from converging on one joke. Each character is assigned a
structural shape at random — an oddly specific statement, a condition for swiping right,
two lines that contradict each other, an unfinished thought — drawn from a pool that skips
shapes which would be out of character for her archetype, and rotates so the same shape
does not come up twice in a row. And because generation runs strictly one at a time, each
bio is written with the bios already in the stack in front of it, under instructions not
to resemble them.

### The attribute tables

`server/src/data/attributes/*.json`, seeded into SQLite on first boot. Rows already in the
database are never overwritten, so future edits survive an upgrade. The field that matters
most is `prompt_hint` — the text that actually reaches the model. Without it the Actor
gets a bare label and reinvents its meaning every time.

`GET /api/attributes/testroll` rolls ten characters with no LLM calls, for checking
weights by eye.

---

## Settings

Model endpoints, keys and sampling per role · a global activity multiplier for
proactivity and wakeup frequency (start low) · the server uptime window · a daily call and
cost budget with a usage readout · searchable logs filtered by scope, where every LLM call
is stored with its full prompt, response, duration and token counts · a separate image log
with a per-job retry button · your own profile.

The log view is the main tuning tool. Use it.

---

## Scope

**V1, implemented:** onboarding and profile · character generation with the full attribute
tables · a swipe stack of ten · matching with instant and delayed behaviour · the
Director/Actor chat loop · stats with the code modifiers · flags · the ledger · online
windows, read receipts, typing indicator, per-message delays and leaving
mid-conversation · the wakeup queue and
catch-up job · proactivity · ghosting and blocking · settings with logs · Docker.

**V2, prepared for but not finished:** image generation (the queue, prompt assembler,
consistency seed and vision evaluation are in place behind a settings toggle) · voice
messages (same, behind a toggle) · the date mode (schema, prompts and Director control
template exist; the engine is not wired up) · the attribute table editor · a prompt editor
in the UI.

The cut is deliberate: the chat loop is the risk. If that does not feel real, no date mode
rescues it.

---

## Layout

```
server/src/
  data/attributes/   the dice tables
  prompts/templates/ every prompt, as editable files - no prompts in code
  engine/            dice, generator, director, actor, chat, scheduler,
                     matching, presence, modifiers, state, images
  llm/client.ts      the only provider-aware file
  db/                schema and the attribute repository
web/src/             React frontend, mobile first, installable
```

All characters are adults; `age` has a hard minimum of 18 and is validated at generation.
Single user, no auth, no moderation, not meant to be exposed to the internet.
