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

The SQLite database, uploads and generated images all live in one place:

- Docker: the `fauxr-data` named volume, mounted at `/data`.
- Locally: `./data` at the repository root, regardless of where you started the process
  from. Override with `FAUXR_DATA_DIR`.

Nothing else on disk is state. See **Starting over** below.

### Testing mode

**Settings → behaviour → "Everyone is always online"**, on by default. Characters reply
whenever you write, whatever the hour: their own schedules, the server uptime window and
any "I'm heading off" absence are all ignored. Ghosting and blocking still work, and the
schedules themselves are kept rather than overwritten, so turning it off puts the real
pacing straight back.

Turn it off before you judge how the game feels. Waiting for someone to come online is a
large part of what makes them read as people rather than as a chatbot.

### Uptime window

The app is built for a machine that is up 06:00–02:00. Outside that window nothing runs in
the background — that is intended, not a bug. On every start a catch-up job re-spreads
overdue wakeups, applies elapsed investment decay, drops expired negative flags and lets
anyone whose investment ran out start ghosting. The window is configurable in Settings.

### Starting over

**Settings → reset → Reset everything.** Wipes your profile, every character, chat, stat,
ledger, image and log, then drops you back at onboarding with a freshly generated stack.
No restart, no shell.

Your API keys and model settings are kept by default, since resetting often would
otherwise mean retyping your key every time; a checkbox includes them if you want the lot.
The daily usage counter is never reset — it records money actually spent, not game state.

Resetting is safe at any moment, including mid-conversation: a turn can sit in an API call
or a delivery delay for a minute or more, so turns carry the epoch they started in and
abandon their work rather than writing into the world that replaced them.

The equivalents from a shell, if you prefer:

```bash
# everything, including the database file
docker compose down -v            # -v is the point: it drops the fauxr-data volume
rm -rf data/                      # local

# keep settings and profile, wipe only the dating world
sqlite3 data/fauxr.db "DELETE FROM characters; DELETE FROM messages; DELETE FROM wakeups;"

# re-seed the attribute tables from the shipped JSON after editing or upgrading them.
# Boot never overwrites existing rows, so this is the only way to pick up changes.
# (The reset button does this for you.)
sqlite3 data/fauxr.db "DELETE FROM attribute_db;"

# just clear the logs
sqlite3 data/fauxr.db "DELETE FROM logs;"
```

Restart the server after any of the SQL ones. Deleting characters cascades to their
relationships, messages and wakeups.

Build artefacts are not state and are rebuilt by `npm run build`; delete `node_modules/`,
`server/dist/` and `server/public/` only if you want a genuinely clean rebuild.

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
         segments its own messages; the server does the timing
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

### Her profile: what he has found out

Every character carries a catalogue of facts built from her seed — name, age, job, where
she lives, her humour, her soft spot, her interests, what she looks like, and once that
part of the conversation is open, what she is into. Roughly forty rows. All of them start
as `???`.

A row fills in when she actually tells him. Never when a stat crosses a line. The Director
reports what came out in each exchange, and a deterministic backstop in code catches the
obvious ones — if she names her job, he knows it, whether or not the Director thought to
mention it. Looks are excluded from that backstop: saying "my hair" does not reveal its
colour, that needs a photo or a date.

This is deliberately the progression the game was missing. Stats are invisible by design,
so without something like this there is nothing to work towards and no sense of getting
anywhere. A counter in the chat header (`12/40`) opens the profile sheet.

### Drive

Two mechanisms stop a chat reading identically on message four and message eighty.

**Stage.** Computed in code from stats and flags: opening → curious → warming → flirting →
intimate → wants to meet. The Director is told which phase it is in, what that phase feels
like, and *what would move it on*, so there is something pulling the conversation forward
rather than it circling. The Actor gets the phase name only.

**Her side of it.** The Director is given a list of what she still does not know about him
— his work, why he is really here, whether he is talking to other people — and told that a
character who only ever responds is a failure of the Director, not of the user. She is on a
dating app for her own reasons and is expected to pursue them.

### Arousal

A session stat, separate from spark: spark is whether she fancies him, arousal is whether
she wants him *right now*. It moves fast in both directions and decays on a three-hour
half-life, so nobody stays at a simmer overnight.

Its ceiling comes from her seed — libido and sexting readiness — and from spark, so a
high-libido character still cannot run hot for someone she is not into (libido 5 with spark
20 tops out at 42). The Actor never sees the number, only how it feels from the inside.

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

## The chat must not read like roleplay, or like an assistant

Two different things pull the Actor away from sounding like a person, and they need
different answers.

**Roleplay prose**, because it dominates the training data. The prompt forbids asterisk
actions, narration, scene description and third-person sentences about herself.

**The assistant register**, which is subtler and does more damage. A model trained to be
helpful acknowledges a request before answering it, summarises your message back to you,
comments on the shape of the conversation, and explains its own intentions. All four in
one exchange looks like this:

> you opened with a greeting and a question about my wellbeing
> bold strategy for a sunday
> tell you about myself
> i am testing whether you can do better than that

Nobody texts like that. `server/src/engine/voice.ts` catches each tic by name — narrating
his message back, parroting his words with the pronouns flipped, reviewing the
conversation from outside it, announcing that she is evaluating him — plus a whole turn
made of nothing but polished one-liners, which is its own tell. A rejected turn is
re-requested once with a correction that names the exact mistake, which works far better
than asking for something better; a second failure falls back to a neutral one-liner.
Measured at zero false positives across 350 realistic message/context pairs, so a good
reply still costs one call.

### Giving her something to say

Detectors only remove bad output. The reason a character defaults to commenting on the
user is that she has nothing else — so two things supply material:

- **Her moment** (`moment.ts`): the real time of day, the shape of her week, her job, her
  living situation and her hobbies, assembled in code with no model call. She knows it is
  Sunday morning, that she is a nurse, and that she shares a flat with two people.
- **A per-turn nudge** (`nudge.ts`): most turns get nothing, but some ask her to bring in
  something of her own unprompted, to circle back to an open thread, to be half-present,
  or to not ask a question back. Frequency scales with her social energy and how invested
  she is, so a warm character volunteers about half the time and a cold one rarely.

The Director's `goal` is also explicitly marked private in the prompt. Handed a goal
without that, a model states it out loud — which is exactly where "i am testing whether you
can do better" came from.

Message counts and lengths are clamped by the server, and timing is computed by it rather
than requested from the model — see **Message timing**.

Voice messages are the single exception: they may be rambling spoken prose, because that
is what a voice note is. Narration stays forbidden there too.

### Message timing

The first message of a reply is sent the moment it exists. The wait before it is already
real — the model had to write it — and stacking an invented delay on top of generation
time only makes her look slow. A model asked to pick its own delay will happily say 42
seconds.

Messages after the first arrive together, so those are paced: each waits roughly its own
length at about fourteen characters a second, capped at ten seconds (configurable). A
two-word reaction lands in a second, a long rambling one takes most of the cap. The typing
indicator runs for exactly that gap, and is skipped entirely when there is none.

The model is no longer asked for delays at all. Its `response_speed` trait still shapes how
she writes and how often she answers; it is not a stopwatch.

The typing indicator covers the whole turn, not just the pauses between messages. Composing
a reply means a director pass and an actor call — several seconds of real work — and since
the first message has no delay of its own, without this the chat would sit silent and then
produce a bubble out of nowhere. It comes on the moment she starts working on a reply and
goes off after her last message, including when the turn ends without one because she is
ghosting or the provider was unreachable. The client also expires it on its own, so a
connection dropped mid-turn cannot leave it stuck.

### Voice messages
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

It runs 25 to 60 words over two to four lines, not a single clever sentence. One cryptic
line reads as someone who could not be bothered and gives a reader nothing to decide on;
the bio exists to make her sound interesting, which takes more room than that. Anything
under fourteen words is rejected and re-requested once. What still stays out is anything
identifying — her real name, her employer, her street — and any self-summary
("I'm sarcastic and a bit shy"): the substance belongs, the adjectives do not.

Two things keep the stack from converging on one joke. Each character is assigned a
structural shape at random — three plain facts about her, what her week looks like, what
people assume versus what is true, conditions for swiping right with reasons attached —
drawn from a pool that skips shapes out of character for her archetype and rotates so one
does not repeat within six. And because generation runs strictly one at a time, each bio
is written with the bios already in the stack in front of it, under instructions not to
resemble them.

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
with a per-job retry button · your own profile · a reset that puts the whole app back to
first boot.

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
