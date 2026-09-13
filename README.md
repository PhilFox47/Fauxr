# Fauxr

A self-hosted, single-user adult hookup-app simulator. Think MeChat or Choices without the
hardcoded stories, without the purchases, and considerably more explicit — you swipe, match,
chat, flirt, get flirted at, and find out what someone is actually into.

It is not a relationship site and the characters do not pretend it is. Everyone on it is an
adult who wants something physical, their bios say so, and the conversation starts from
that rather than working its way towards it over weeks.

Characters are generated, not written. They have their own goals, their own schedules,
their own hidden thresholds and their own fetishes to be discovered. Nothing happens
because a number crossed a line; numbers only decide what the Director *considers*. What
actually happens, happens in the conversation.

Everyone in it is an adult — `age` has a hard minimum of 18, validated at generation — and
refusal is real: characters say no, have limits they do not cross, and pushing costs you.
That is what makes the yes worth anything.

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

Each of the three roles also has an optional `provider` field, matching Nano-GPT's
`provider` field on `/chat/completions` and `/images/generations` — a plain string like
`"chutes"` or `"targon"` that pins an open-source model to one specific backend instead of
letting Nano-GPT route it. Left blank (the default), the field is omitted from the request
entirely and routing behaves exactly as before.

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

### One topic at a time

While something is unfinished, nothing is allowed to open a second subject. The Actor
reports an `unresolved` field each turn — a question he asked, a game in play, a bit that
is still running — and that, plus a code check for an unanswered question from him,
suppresses every nudge that introduces material and strips `bring_up` out of the direction
entirely. What is left is the nudges that only change her manner.

This came out of a real transcript: the user started a name-guessing game and she played
along while also running an unrelated story about her cooking in the same messages, every
turn, so neither went anywhere. The cause was a nudge of mine that read "bring something of
your own into it — *it does not have to connect to what he said*", firing on roughly half of
all turns regardless of what was already happening. Dropping `bring_up` mechanically rather
than conditioning it in the prompt matters, because a direction lasts several turns and
outlives the moment it was written for.

With the floor clear she is still pushed to bring her own material on about two thirds of
turns. The change is about timing, not about making her passive again.

### Open threads have a lifespan

A thread she mentioned and he did not pick up dies on its own: two outings, or three days,
whichever comes first, capped at four at a time. The Actor is only shown threads she has
not raised in the last eight hours.

This was originally recorded with an `expires_when` that nothing ever acted on, so nothing
ever left the list — a passing remark stayed in the ledger, in every Actor prompt and in the
callback pool indefinitely, which is how a character ends up bringing up the same anecdote
every few messages and tallying the user's failure to care about it. Dropping something the
other person did not bite on is what people actually do.

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

### Spice

Sexual and date thresholds are pulled down by each character's own appetite — her libido,
sexting readiness and sexual confidence — so a forward character is reachable early and a
reserved one is a real climb. Measured across 400 rolls: a forward character's
`sexual_topics` gate sits around spark 5, a reserved one's around 33; spicy photos 16
versus 51. Before this they were rolled blind, so the most forward woman in the pool could
be gated exactly as hard as the shyest, which made no sense.

A **spice** slider in Settings scales all of it. It applies at generation time, so it
shapes new characters rather than rewriting matches you already have.

Trust and spark are scored on separate scales. Trust is slow and about safety. Spark is
attraction and moves fast, because that is the point of the platform — the Director is told
in as many words that a character who is still politely neutral after thirty messages is a
failure of direction.

The population reflects the premise: appetite floors are raised across every archetype, so
nobody is a non-starter, while the spread is kept so a reserved character still reads as
reserved beside a forward one. What that leaves is roughly: talking dirty is table stakes
(the `sexual_topics` gate averages 15), while photos (33) and actually meeting (44) still
take real work. Wanting sex in general is not the same as wanting it with *him*, and that
gap is where the game is — turn-offs, pressure, dealbreakers and hard limits all still
bite.

### Fetishes

Every character rolls two to five, plus hard limits. The Director is shown which ones the
player has found and which are still hidden: she circles the hidden ones when she is worked
up — a leading question, a detail she did not have to include, a joke she could take back —
and landing on one is a large spark and arousal jump. Found ones become part of how she
talks to him. Hard limits never move, whatever the mood.

They appear in her profile as they are discovered, like everything else.

### Arousal

A session stat, separate from spark: spark is whether she fancies him, arousal is whether
she wants him *right now*. It moves fast in both directions and decays on a three-hour
half-life, so nobody stays at a simmer overnight.

Its ceiling comes from her seed — libido and sexting readiness — and from spark, so a
high-libido character still cannot run hot for someone she is not into (libido 5 with spark
20 tops out at 42). The Actor never sees the number, only how it feels from the inside.

`arousal_delta` gets the same explicit numeric rubric as trust and spark (+25 for detail
that actually lands, down to -20 for clumsy or presumptuous), rather than a paragraph of
vibes — a cheap Director model regresses to 0 on anything it isn't given anchor points for,
and arousal sitting flat despite real effort from the user was exactly that failure. The
rubric also ties how much gatekeeping is in character to her own libido, sexual confidence
and sexting readiness rather than a genre default: a character who rolled high on all three
running a long testing bit is out of character for her, not tension.

### Tests need a finish line

A specific failure pattern: she sets a bar ("be specific", "impress me"), the user clears
it, and she raises the bar again instead of paying it off — forever. Nothing was wrong with
any single message; the conversation just never got anywhere. Both the Director and the
Actor are told this by name now: a test that has genuinely been passed pays off that turn —
a real answer, a matching escalation, arousal actually moving — and moving the goalposts the
instant he clears them reads as the scene stalling, not as her being hard to get.

Two smaller repetition tells got the same treatment. A model will happily land the same dig
twice in one conversation, reworded the second time, which reads as a stuck record rather
than a callback — caught in the prompt, and backstopped in code with the same token-overlap
heuristic already used to detect the user repeating himself under pressure (0 false
positives across a 20-message stress conversation). And one emoji turning into a tic
stamped on the end of every message for several turns running is now called out explicitly
as something real texting doesn't do.

### Invited is invited

A more severe version of the same stalling problem: a character asks the user a direct
question — what he's looking for, what he's into — he answers honestly, and she turns
hostile at him for it ("you're like a goddamn fact sheet") as though a plain, invited answer
were an offense. Her own seed stats (high libido, high sexting readiness) made this worse,
not better, since nothing was gating her toward caution in the first place — she had no
reason to be defensive except that the scoring rubric gave her one.

The root cause: both Director templates scored "a sexual turn she did not invite" and
"uninvited escalation" as negative, but nothing distinguished a genuinely unprompted move
from a direct answer to a question she just asked. A cheap or careless Director pass could
dock trust and spark for content that was, definitionally, invited — and the Actor, handed a
negative-leaning direction with no explanation, improvised a reason for it, which is where
the "fact sheet" hostility came from. The rubric in both `director_direction.md` and
`director_update.md` now says explicitly: if she asked, the answer is invited, however blunt
or sexual, and it scores on quality, never merely on having been said. The Actor prompt got
the matching rule on its own side — she can find an honest answer boring or underwhelming,
she cannot be offended that he gave it.

### Her default mood is curious, not annoyed

Nothing in the Director prompt ever said what she should feel when nothing in particular has
happened — so a model with no anchor for "neutral" reached for irritation more often than
warmth, especially in the opening exchanges, where "she's deciding if he's worth the effort"
read closer to skeptical than curious. Being cold, curt, or visibly annoyed should be a real
reaction to something, not the resting state.

`director_direction.md` now says so explicitly: her baseline is curious and a little
interested, particularly early on — she swiped on him for a reason, this is a new match, not
a chore. Bad mood is still real and still allowed, it just needs a cause. The Opening stage
description in `stage.ts` and the no-direction-yet default in `blocks.ts` (used before the
Director has ever weighed in) got the same reframe, from "neutral, deciding if he's worth the
effort" to "curious, actively interested."

### Forward characters need to make the first move too

A character built forward on her seed (high libido, high sexual confidence, high sexting
readiness) is supposed to do some of the flirting and escalating herself, not just react
generously once the user brings it up. Two things stood in the way of that:

The Director's `sexual_topics` unlock only fired once "the moment in the conversation calls
for it" — with nothing telling it that a forward character's own want is reason enough, that
qualifier defaulted to waiting for the user to steer the conversation there first. It now
says so explicitly, plus a standing "SHE MAKES MOVES TOO" instruction that `bring_up` can be
a tease or her taking things sexual herself, not only mundane material.

The bigger issue was in code, in `nudge.ts`: the `flirt` and `escalate` nudges — the ones
that actually make her initiate rather than only answer — were gated almost entirely behind
`arousal`, a transient stat that mostly rises *after* something sexual has already happened.
That is a chicken-and-egg problem: a character waiting on her own arousal to justify the
first move could never actually make it, so everything had to come from the user. Both
nudges now also fire off her seed traits directly (`sexual_confidence >= 4` or `libido >= 4`,
plus spark for flirting and `sexting_readiness` for escalating into sexting), with arousal
still lowering the bar further once it exists rather than being the only way in. Verified
with a script driving `pickNudge()` directly over 20k trials per scenario: a forward
character with zero arousal now flirts on ~58% of turns instead of 0%, and once
`sexual_topics` is unlocked, self-initiates escalation on ~63% of turns at arousal 30
(previously required arousal 60 and fired standalone). A non-forward character in the same
scenarios is unaffected — this only changes characters whose seed actually calls for it.

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
conversation from outside it, announcing that she is evaluating him, repeating a dig she
already made earlier in the same conversation — plus a whole turn made of nothing but
polished one-liners, which is its own tell. A rejected turn is re-requested once with a
correction that names the exact mistake, which works far better than asking for something
better; a second failure falls back to a neutral one-liner. Measured at zero false
positives across 350 realistic message/context pairs, so a good reply still costs one call.

The two attempts are for content problems — the model wrote something, it was the wrong
shape. A thrown error (a rate limit, a timeout, a non-2xx response) is a different failure
and used to skip the retry budget entirely, falling back on the very first hiccup with
neither attempt spent. It now retries once with the identical request before giving up,
which is free and absorbs exactly the kind of transient provider blip a hookup app running
against a third-party endpoint will hit sometimes. The fallback itself is now a small pool
of lines rather than one fixed sentence, so a longer outage does not repeat the exact same
"sorry got distracted" back to back — which reads as far more obviously broken than any one
of them does alone, especially if the user resends thinking their message did not arrive.

That fallback line is still in-character flavor text, which means it is indistinguishable
from a real message unless it's marked. It now carries a `failed: true` flag from
`fallbackOutput()` through the message's `meta`, and the chat UI renders a small red ⚠ next
to the bubble so it reads as "generation broke" rather than as something she actually typed.

### Sounding like a person, not a writer

A second register problem sits underneath the assistant one. These prompts are written in
careful formal English with full sentences and no contractions — that is how instructions
get written — and a model reading three thousand words of it writes back in the same voice.
The result is characters who text like essayists.

The Actor prompt now says that out loud: the instructions' own register is not hers, and
copying it is the fastest way to sound like a bot. It carries worked pairs
("I am not entirely sure what you mean by that." → "idk what u mean by that") and concrete
defaults — contractions always, abbreviations where they fit, reactions instead of
sentences, dropped subjects, no em-dashes or semicolons because nobody reaches for those on
a phone.

Two code checks back it up, both skipped for a character whose seed genuinely says she
writes properly: writer's punctuation, and a message that reads formal as a whole. That
last one needs all three of a capital opening, a full stop closing and an uncontracted
construction — a single full form is not formal, since "ok that was not the answer i
expected" is perfectly normal texting. Measured at zero false positives across 328 natural
messages while catching every prose sample.

The attribute hints were abstract in the same way. "Current internet slang, abbreviations,
irony markers" produces whatever the model imagines that is; the table now lists the actual
words. Properly-punctuated and formal registers are demoted to uncommon, so writing in full
sentences is a deliberate trait rather than the default.

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

### Regenerating a reply

A small ↻ button sits next to the timestamp on her most recent message, for when a reply
comes back broken, repeated, or just not worth keeping.

Only her *last turn* can be regenerated - not any message in history. Anything older has
already had its trust/spark/investment deltas, ledger facts and discovered profile entries
folded into the relationship, and unwinding those cleanly is not something a redo button
can do safely. The button only ever appears on the true last message in the conversation,
so once you have replied again, that turn is done and there is nothing left to reroll.

Regenerating deletes the old message(s) and asks the Actor to write the moment again from
scratch. The Director is not re-run: the original turn already scored and directed this
exchange, and doing that twice would double-apply its stat changes. This is a reroll of her
words, not a rescore of what happened.

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

**Live updates run over one WebSocket (`/ws`)** — new messages, typing, presence, matches,
all of it. Behind a reverse proxy that does not forward the `Upgrade`/`Connection: Upgrade`
handshake (the default on plain `nginx` and Apache configs, and on some one-click reverse
proxy panels), the socket silently never connects: no error either the browser or the app
can act on, it just retries forever. Without a fallback that meant new messages and the
typing indicator only ever appeared on a manual page reload, while the match list and unread
badges still limped along on their own 60-second poll.

Two fixes, so the app is correct either way rather than depending on the proxy being
configured right:
- Fix the proxy if you can — it is the lower-latency path. For `nginx`, the `/ws` location
  needs:
  ```
  location /ws {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```
  Caddy and Traefik forward WebSocket upgrades automatically and need no special config.
- Fixed either way: the open chat screen now also polls `/api/chats/:id` every 3 seconds
  regardless of the socket, and that endpoint reports whether she is currently mid-turn
  (`typing`, backed by the same in-memory state the WebSocket event reads from) alongside
  the message list. The match list's own poll dropped from 60s to 15s for the same reason.
  Verified end-to-end over plain HTTP with no WebSocket involved at all: a mock LLM backend
  with an artificial delay, driven purely with `curl` against `/api/chats/:id/messages` and
  repeated `GET /api/chats/:id` — `typing` flips true for the duration of the turn and the
  reply lands in the polled message list, exactly like the WebSocket path, just a few
  seconds later.

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

### Signatures

Rolling forty plausible attributes produces forgettable soup: everyone comes out as a
reasonable person with a job. So every character also draws a **signature** — the one
heightened thing that makes her her. A declared nemesis. An inherited lighthouse. A small
cryptid podcast she is entirely earnest about. Banned from a named town for reasons she
considers an overreaction.

It is rolled without the archetype filter, deliberately: a shy woman with a nemesis is far
more interesting than one whose every trait agrees with the others. The Actor is told it
shapes her week rather than being a fact to deploy once, the Director is told to lean on it
when deciding what she brings up, and the bio is written around it. It is discoverable like
anything else.

It is deliberately kept as background rather than an agenda. The first version told the
Actor it "shapes your week" and the Director that it "should drive what she brings up",
which produced characters who steered every conversation back to their one thing and then
started keeping score of whether the user had engaged with it. It now surfaces rarely and
sideways, at most once per conversation, and the Director is told a character who mentions
her thing in every message is worse than a bland one — bland is forgettable, obsessive is
annoying.

A **heightening** slider controls how far past an ordinary person the pool leans:

| heightening | grounded | heightened | cartoon |
|---|---|---|---|
| 0.4 | 50% | 41% | 8% |
| 1.4 (default) | 17% | 42% | 41% |
| 2.5 | 5% | 36% | 59% |

The supporting tables carry a heightened tier too — taxidermist, funeral director, night
security guard alongside the nurses and baristas; voicing her pet's inner monologue
alongside double-texting.

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

There used to be a fixed pool of fifteen, later twenty-three, structural shapes handed to
the model at random ("three plain facts about her", "what she's bored of vs what she wants",
and so on) so the stack would not converge on one joke. That turned out to be its own
problem: however fresh the wording, the underlying shape was still drawn from a small fixed
enum, which is exactly a "built from the same pieces" feeling with extra steps - it was just
happening one level up from the words. Removed entirely. The model now works out its own
structure from who she actually is: a chaotic character might ramble and trail off, a blunt
one might just state her terms, a dry one might build to a sting in the last line. The
prompt is explicit that there is no template and the first structure that comes to mind is
usually the wrong one to reach for.

The remaining defence against the stack converging on its own is the same one that always
handled word-for-word repeats: generation runs strictly one at a time, and each bio is
written with the last dozen bios already in the stack in front of it, under instructions not
to resemble any of them "in structure, opening words, or joke" - now doing double duty as
the only thing keeping shapes varied too.

Separately, there is a small fixed pool of twelve fully hardcoded bios (`FALLBACK_BIOS`) —
not AI-written at all — used only when the API call fails outright after its retry. If a
bio looks suspiciously identical to one seen before rather than just structurally similar,
that is the tell: check the logs (scope `generator`) for "bio generation failed, using
fallback" to see whether the model is actually being reached.

### The attribute tables

`server/src/data/attributes/*.json`, around 1050 entries across 47 categories, seeded into
SQLite on boot. The field that matters most is `prompt_hint` — the text that actually
reaches the model. Without it the Actor gets a bare label and reinvents its meaning every
time.

Every entry carries a **rarity**: common, uncommon, rare or very rare, which is the coarse
frequency dial (`weight` remains a manual nudge on top). This is how the niche material
earns its place — the fetish table runs to ~100 entries covering everything from dirty talk
to mummification, and the long tail only turns up when it should. A **rarity** slider in
Settings pulls the whole tail up or down together:

| rarity_bias | common | uncommon | rare | very rare |
|---|---|---|---|---|
| 0.5 | 75% | 23% | 2% | 0% |
| 1 (default) | 51% | 38% | 10% | 1% |
| 2 | 36% | 39% | 19% | 6% |

Hard limits carry conflict rules against the fetishes they contradict, so nobody rolls
"into spanking" alongside "cannot be hit at all". Verified across 800 generated characters:
zero contradictions.

The seeder tracks a content hash. New rows are always inserted; existing rows are only
rewritten when the shipped tables actually change, so an upgrade that adds a field or
rewrites a hint reaches installs that already have a database instead of silently applying
to new ones only. On the same content-changed check it also removes rows that are no longer
shipped, so a renamed or deleted attribute (the fetish table's `dirty_talk` splitting into
`dirty_talk_receiving` / `dirty_talk_giving`, for one) does not leave the old id behind as a
permanent orphan still being rolled into new characters alongside its replacement.

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
