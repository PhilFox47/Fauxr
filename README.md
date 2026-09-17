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

### When a model runs out of room to answer

A log export turned up 58 calls that had burned their entire `max_tokens` budget and come
back with `{}` or an empty string — **63% of all model time, producing nothing**. Every
failure sat exactly on its ceiling; every success sat under it.

The cause is reasoning models: their thinking is billed against `max_tokens`, so a 120-token
budget that is generous for `{ "username": "..." }` was spent before the answer began. The app
made this much worse than it had to be:

- A truncated answer looked identical to malformed JSON, so it was retried **unchanged** —
  same ceiling, same result, three times over.
- `{}` is valid JSON, so the parse layer passed it through as a success.
- `write_username` then discarded the empty handle with `continue` and **no log at all**, so
  the only visible trace was a fallback handle appearing out of nowhere.
- A 429 saying *"try again after 60 seconds"* was caught by the same handler, logged as
  `JSON parse failed`, retried **immediately**, and told that its JSON was invalid.

Now there are three separate failures with three separate recoveries. A **truncation** is
detected from `finish_reason` or the completion count sitting on the cap, logged with the
ceiling it hit, and re-asked once with real room — at least 1200 tokens, because tripling a
tiny budget just fails more slowly. A **rate limit or 5xx** is waited out for as long as the
provider asked for, read from the `retry-after` header or from the prose in its own error
body. Only genuinely **malformed JSON** gets the "that was not valid JSON" nudge, and a
well-formed but empty answer gets a targeted one naming the key it left out.

Every call log now carries `max_tokens`, `finish_reason` and `truncated`, so a ceiling that
is quietly too tight shows up in an export before it becomes a wave of empty answers. The
base budgets were raised to match (handles 600, bios 1200, a character 2400, and the Actor
and Director defaults to 1800 and 2600) — saved settings keep whatever they already have,
since the automatic widening covers them either way.

Measured against a mock reproducing the exact failure: **one character went from 6.7 provider
calls to 3**, and a model whose thinking still overruns the raised ceiling recovers in one
extra call with a clear trail, instead of three silent failures and a fallback.

### Headroom over truncation, everywhere

The fix above still worked by recovering from a truncation after it happened - one extra
round trip, a clear log line, but a truncation all the same. Every base budget was then
**4x'd outright**, a deliberate call to trade worst-case cost and latency for never having a
real answer, or a reasoning model's thinking, cut off by its own ceiling in the first place:

| | before | now |
|---|---|---|
| Actor default | 1800 | **7200** |
| Director default | 2600 | **10400** |
| `write_username` / `reroll_name` | 600 | **2400** |
| `write_bio` | 1200 | **4800** |
| `generate_character` (the dossier pass) | 3600 | **14400** |
| Truncation-retry floor | 1200 | **4800** |
| Truncation-retry ceiling | 6000 | **24000** |

The retry ceiling has to move with the base budgets, not stay fixed - it exists to guarantee
the second attempt has *more* room than the first, and a ceiling below the new largest base
budget would invert that: a call that filled 14400 tokens thinking would get throttled back
to 6000 on the one retry meant to give it more space. Verified directly: a mock that always
truncates, whatever cap it is asked with, still gets a wider retry cap every time, at every
one of the new base sizes.

The per-request timeout moved too, from 120 to 300 seconds, for a reason that is easy to
miss: a ceiling four times larger needs real wall-clock time to actually be written, or
calls that would otherwise have finished start getting cut off by the clock instead of the
token cap - trading one kind of truncation for another rather than removing it.

Settings saved before this shipped keep whatever `max_tokens` they already have - deepMerge
only fills in what is missing - so an existing install picks up the new defaults by editing
Models in Settings (or resetting API keys and settings), not automatically on upgrade.

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

### Both prompts are ordered static-first

Neither prompt is written in the order you would read it in. Everything that is the same on
every turn for a character comes first; everything that changes comes last. That is what lets
a provider with prefix caching reuse the bulk of an eight-thousand-token prompt instead of
reprocessing it cold each turn.

It was not like that. The ledger, her mood and the direction sat up among her traits, and the
largest static blocks — the texting rules for the Actor, the whole scoring rubric for the
Director — sat at the very end, *after* everything volatile. Measured on two consecutive
renders:

| | before | after |
|---|---|---|
| Actor stable prefix | 2% | **86%** |
| Director stable prefix | 15% | **73%** |

Both prompts now also put him, the moment and the direction nearest the conversation they
apply to, and leave the output shape last, which is where it is most likely to be followed.
There is a comment at the seam in each template: adding a per-turn value above that line
quietly undoes the whole thing.

### The ledger is additions, not a restatement

The Director was scoring turns as hits and recording nothing about them — `what_landed: []`
and `facts_about_user: []` alongside `spark_delta: 3`, turn after turn, while `intent` and
`plans` came back word-for-word identical on every call. A plan that is re-emitted unchanged
never fires and never expires, and a character whose ledger stays empty has no accumulating
memory: every turn is scored fresh.

The merge in `state.ts` was always additive; the prompt was the problem. The output schema
showed every ledger array as `[]`, which is exactly what a model copies. Now the schema shows
each array's *shape*, and a `WHAT TO RECORD` section says plainly that entries are appended,
that repeating a stored one does nothing, and that `director_notes` should be left out
entirely unless her intent has actually shifted. Two rules catch the observed failure
directly: if `spark_delta` or `arousal_delta` is above zero, `what_landed` must name what did
it; and anything he said about himself goes in `facts_about_user`.

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

Two rows start filled in: **age** and **languages**. They are printed on her card before
you swipe, so making someone extract them in conversation was never a game — and the
Director being told to "reveal" her age produced chats that opened by stating it. Everything
else starts as `???`.

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

### Double-texting

The wakeup system above covers reconnecting after real distance - hours, days. It does not
cover the much smaller, much quicker thing a real person does mid-conversation: she said
something, he has not replied in a while, and she sends one follow-up. `scheduler.ts`'s
`maybeDoubleText()` runs every tick alongside the existing proactive checks: if the last
message in a chat is hers and it has sat unanswered for at least 30 minutes, and she has not
already followed up once on this particular silence, it queues a wakeup for a low-key
"still there?" kind of turn.

**She is never annoyed about the silence, here or anywhere else.** This runs in a gooner
app, not a guilt-trip generator: going quiet for twenty minutes or three days has to stay a
completely normal, unremarkable thing, never something she reads as owed a reply for.
`director_direction.md` now states this as a standing rule - no passive-aggressive "oh NOW
you text back", no hurt or annoyed undertone about a gap, whatever the mood otherwise is -
and the double-text's own trigger reason repeats it inline, right where the model actually
reads why this turn is happening, since it costs nothing to say it twice.

Verified against a mock: no wakeup before 30 minutes; one queued (with the anti-annoyance
framing baked into the reason text) once the threshold passes; calling it again does not
duplicate the wakeup or fire a second follow-up for the same silence; and replying resets
the flag so a later, fresh silence can earn another one.

### One unanswered follow-up in a row, not one of each

Double-texting was built to only ever fire once per silence, but the mechanism next to it in
the same tick - `maybeBeProactive()`, which reopens a conversation after real distance (hours)
- had no matching limit and, worse, did not actually stay out of double-texting's way the way
its own doc comment claimed. Each one queues a wakeup and then, once it fires, resets
`rel.last_contact_at` to now - and `maybeBeProactive()`'s own eligibility is based entirely on
how long it has been since that timestamp. So a long enough absence let the sequence repeat:
double-text fires at the half-hour mark, then two-plus hours later `maybeBeProactive()` finds
the silence "fresh" again (measured from the double-text, not from the actual last thing he
said) and reaches out a second time on top of it - and, left offline for a whole day, that
could keep recurring every couple of hours, exactly the flood this was supposed to prevent.

Both functions now share one flag, `rel.mood.followed_up_unanswered` (renamed from
`double_texted`, since it no longer describes only one of the two mechanisms setting it):
either one sets it the moment it queues its wakeup, either one skips a character who already
has it set, and it only clears in `handleUserMessage()` once he actually sends something.
Whichever mechanism reaches out first is the only one that gets to, for the rest of that
silence - a real absence still earns at most one unprompted message, never a stack of them
waiting when he finally opens the app back up.

Verified against a mock: forcing `maybeBeProactive()`'s probability roll to succeed confirms
it fires and sets the same shared flag double-texting uses; with that flag set, neither
`maybeDoubleText()` nor a further call to `maybeBeProactive()` queues anything on top of it,
even though the underlying conditions (an old, unanswered last message; hours of silence)
that would otherwise make both eligible are still true.

### Chats sorted by last activity, not match date

The matches list was ordered by `matched_at` - whoever she matched most recently stayed on
top forever, regardless of who had actually said anything since. `GET /api/matches` now
sorts by `last_activity` (her last real message, falling back to when you matched if there
is not one yet) descending, the same way every other chat app on earth orders its list -
whoever most recently has something new floats up, and a match that has gone quiet sinks
without needing to be dismissed.

### Spice

How forward a character is comes from her own appetite — libido, sexting readiness and
sexual confidence. Nothing is gated behind a number: see "Nothing is locked any more" below
for why the threshold system was removed outright.

A **spice** slider in Settings leans the whole cast. It reaches the Director each turn as a
sentence about house pacing rather than scaling any gate, so it applies immediately to
matches you already have, and it never overrides an individual character's seed — a forward
one stays ahead of a reserved one at every setting.

Trust and spark are scored on separate scales. Trust is slow and about safety. Spark is
attraction and moves fast, because that is the point of the platform — the Director is told
in as many words that a character who is still politely neutral after thirty messages is a
failure of direction.

The population reflects the premise: appetite floors are raised across every archetype, so
nobody is a non-starter, while the spread is kept so a reserved character still reads as
reserved beside a forward one. Wanting sex in general is not the same as wanting it with
*him*, and that gap is where the game is — turn-offs, pressure, dealbreakers and hard
limits all still bite.

### Orientation

Everyone generated is a woman, so what varies is who she is into: straight, bi, mostly into
men, pan, queer or lesbian, each carrying who it is attracted to. A dating app does not show
you people who are not into you, so this is matched against the gender on your profile —
generation only rolls compatible orientations, and the swipe stack filters the same way so
characters made before you changed anything cannot leak through. A man sees straight, bi,
mostly-straight, pan and queer women; a woman sees lesbian, bi, mostly-straight, pan and
queer; someone non-binary or who did not say sees the orientations that are not defined by
binary attraction. Characters generated before this existed have no orientation and stay
visible rather than vanishing out of a save.

### Where she stands, before what she is into

Fetishes used to be the whole of a character's sexuality: three tags drawn from 183, plus two
hard limits drawn independently from 22. Two problems. Three tags were carrying a person, and
she had no answer at all to anything outside them. And because the two tables never consulted
each other, a character could genuinely come out loving spanking and refusing all impact.

So the general view comes first now. Fifteen **kink domains** — power play, restraint,
impact, sharper sensation, breath play, degradation, praise, feet, being seen, other people,
anal, toys, roleplay, camera, what she wears — and she has a standing position on every one
of them whether or not it ever comes up: **into it**, **curious**, **not for her**, or **a
hard no**. That is what the Actor reads first, so "what do you think about X" has a real
answer for any X, not just the three she rolled.

The specifics then live *inside* that. Her named fetishes are drawn only from domains she is
into or curious about; her hard limits only from domains she is a hard no on. The 88 fetishes
no domain claims — kissing, massage, mornings, staying close afterwards — belong to nobody
and stay available to everyone, because ordinary intimacy is not a kink to be gated.

A **freak** figure, 0–5, is derived from her libido, sexual confidence and sexting readiness
with an archetype nudge, and it decides how generous the stances are. Domains carry an
intensity, so the far end stays out of reach for someone not built for it rather than being
impossible for anyone. Measured over 3000 characters: low-freak characters are open to about
3 of the 15 domains, mid about 6, high about 10, with stances landing 27% into / 24% curious
/ 33% not-for-her / 16% hard no.

The consistency is verified rather than assumed — 3000 generated characters, zero
contradictions. Getting there caught a real one: `marks_limit` belongs to *two* domains
(impact and sharper sensation), so a single hard no was enough to claim it while she was
still into the other. A limit is now dropped if she is into any domain it would contradict.

### Your own side of it

The characters have a kink map; so do you. The same fifteen domains sit on your profile under
Settings, set by you, with the same four stances. Nothing is handed to anyone: a character
starts a conversation knowing **none** of it and learns a stance only when you actually bring
that thing up. What she learns is per-relationship and permanent, so the match you have been
talking to for a fortnight knows things the one you matched this morning does not — which is
the entire reason it is discovered rather than given.

The Director is also told the **gaps**: which domains she has no idea where you stand on, and
that asking about one is a good use of a turn. That is the difference between a character who
interviews you and one who is actually curious about something specific.

It rides in the existing `discovered` map under a `his:` prefix, so it needed no new column
and survives a restart like everything else. Leaving a domain unset simply means it never
comes up.

### Her tell

Every character has one: how it shows when she is turned on. Goes quiet and short. Drops the
hedging and gets blunt. Starts giving orders. Types worse. Talks more. Goes oddly proper.
Jokes harder the worse she has got it. Turns interrogator. Starts talking in hypotheticals.
Reaches for voice notes. One word at a time. Gets mean with it.

It surfaces to the Actor once arousal is past 35. Before this, every character warmed up
identically, which is the sort of sameness you feel without being able to name it.

### Arousal has no ceiling any more

There used to be a hard clamp, and the half of it keyed on spark capped her at **40** early
on — below the 45 the sexting guidance needs, and nowhere near the 70 that reads as openly
wanting him. So a character could be handed exactly the thing she is into and the formula
would throw the reaction away. It was the last artificial lock in the app and it was working
against everything else.

Gone. The Director gets a sentence about how hot she plausibly runs, drawn from her libido
and sexting readiness, and told plainly that there is no cap and two people hitting it off
immediately is normal here. Her seed still matters — a low-libido character running to 90 is
out of character — but that is a judgement made with the numbers in front of it rather than a
lid that discards them.

### What worked, remembered

A short ledger list, capped at twelve, of things he did that visibly got to her — a specific
line, the moment he worked out what she meant. Kept apart from `events` because this is the
list she is allowed to reach back into unprompted, days later, out of nowhere. The Director is
told to write them concretely enough to reuse ("the thing he said about her hands", not "he
was charming") and only when something genuinely moved her.

### Sexting has a shape, not a script

It builds, it gets somewhere, and there is a moment afterwards. What it should not do is
hover at the same temperature forever, which is the sexual version of a test with no finish
line and reads as a machine that cannot finish a thought. The Director is told to notice
which part of the shape it is in and write a direction that belongs there — and told
explicitly that this is not a script, that there are no beats to hit in order, and never to
plan a scene or decide in advance where it ends. The Actor gets one line about the
afterwards being worth having.

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

The biggest single move available is landing on something she is actually into, and that
is now detected in code rather than left for the Director to spot in a forty-message
transcript — which a cheap model misses most of the time. Each domain carries a short list
of unambiguous terms; when the user's own messages hit one, the Director is told plainly
what he walked into and where she stands on it: one of hers (move arousal hard, and she does
not hide that it landed), something she is curious about, something that does nothing for
her, or a hard limit (say so plainly; pushing costs him). The term lists are deliberately
short — a false positive is worse than a miss.

The rubric also says arousal is cumulative within a session: past 50 she does not drift back
to small talk on her own, she stays warm, gets more direct and starts reaching for it
herself. The Actor is told the matching thing from her side — that being worked up shows in
how she types, and that going quiet and polite while plainly turned on is the failure, not
being explicit.

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

### A trade needs a finish line too, and characters need to be curious on their own

Two related reports, both from the same transcript: a trading game ("give me your most
controversial opinion, I'll give you mine") where the user answered first, was told fairly
that it was now her turn, and she answered — then immediately demanded another round
("ur turn again") with nothing settled and no payoff, and separately, that her own answer to
"give me something spicy" was flat and mundane instead of matching the register asked for.
Raw generation logs showed the actual mechanism: the Director had written a goal
("maintain the upper hand while rewarding his curiosity") several turns earlier, and because
`direction.unlock`/`goal`/`stance` persist across every Actor turn until `valid_for` runs out
or a fresh Director call overwrites them, that same stale, open-ended goal was still steering
her two Actor calls later — and a goal phrased as an edge to *maintain* has no condition
under which it is ever satisfied, so the Actor kept extracting one more turn from him even
immediately after paying its own.

This is the "test with no finish line" problem from above, in a different shape: a
back-and-forth trade is a ledger just as much as a vibe-check is a bar, and once a turn is
actually paid on both sides, the round is settled. `director_direction.md` now names this
pattern explicitly and tells the Director to write goals for a reciprocal exchange with an
actual endpoint ("trade one answer each, then let the game breathe") rather than an
open-ended edge. `actor_chat.md` got two matching bullets on the Actor side: a trade is not a
debt (don't answer your own turn and then immediately demand another unless it's genuinely
his turn by the game's own rhythm), and answer in the flavour he actually asked for (if he
asked for spicy, blunt, or filthy and you're answering at all, answer at that level in your
own register — safe-and-mundane is its own kind of not-answering, and staying in-register
doesn't require anything the character's seed hasn't unlocked).

The user's broader point — that characters should push and steer conversations themselves,
be curious about the user, and flirt in a way that matches their own personality, rather than
only reacting to what he brings — pointed at a real gap in `nudge.ts` underneath the prompt
fix. The nudge system had plenty of ways for her to bring material about *herself*
(`volunteer`, `unprompted_detail`) or escalate things physically (`flirt`, `escalate`), but
nothing that pushed her to actually want to know something about *him* — which "being
interested, they matched after all" needs at least as much as flirting does. A new `curious`
nudge fires on ~22% of turns where nothing else is already live, asking him something real
about himself rather than small talk. Separately, `flirt` was gated almost entirely behind
`arousal >= 35` unless a character was already "forward" on her seed — a moderate,
personality-driven-but-statistically-average character (normal libido, normal sexual
confidence, but decent spark) had no route into teasing him at all until arousal had already
climbed, the same chicken-and-egg gap fixed for forward characters above, just one tier down.
`flirt` now also fires once `spark >= 30`, independent of the forward bypass. Verified with a
script driving `pickNudge()` directly over 20k trials per scenario: a moderate character with
nothing live gets the `curious` nudge on ~22% of turns; a non-forward character now flirts
once spark clears 30 (0% below it, as before); the existing `forward`-seed bypass and the
`somethingLive` suppression (still zero `curious`/`volunteer` while something is unresolved)
are both unaffected.

### There is no unlock timer on being sexual

The `sexual_topics` unlock used to have a hidden numeric threshold behind it, just like
`real_name`, `profile_picture` or `allow_date` still do: a spark number rolled at character
creation (pulled down by her own libido/confidence/sexting-readiness, but never to zero) that
had to be crossed before the Director was allowed to let a conversation turn sexual at all.
In practice that meant a forward character built to be sexual from the jump could still be
sitting on a real, if lower, number she had to hit first — and a good, well-aimed flirt from
the user in message one could not turn a receptive character around right then, no matter how
well it landed, because the threshold didn't care about quality, only about a spark total the
conversation hadn't had time to accumulate yet. That is a pacing device, and it does not
belong on every character: some of them are supposed to be exactly that easy, immediately,
because that is who they are.

The threshold is gone. `sexual_topics` is no longer part of `Thresholds` at all, and nothing
in `thresholdsBlock()` mentions it to the Director anymore. Whether a chat turns sexual, and
when, is now made fresh every turn from two things only: who she actually is (her seed's
libido, sexual confidence, sexting readiness, what she's into) and what has actually happened
in the conversation, including the exchange that just happened. `director_direction.md` says
this explicitly now — message count is not a variable in the decision at all. A character
built forward can take the conversation there herself in the very first message, unprompted.
A reserved or guarded character can also be turned around in the very first message if the
user is specifically good enough at it; a sharp, confident, well-aimed flirt is allowed to
land immediately rather than needing to be repeated across several turns before it "counts."
Refusing early is still a real, in-character answer for a character it doesn't fit — she just
isn't required to plan out a slower unlock schedule to justify it; it's reconsidered fresh
next turn like everything else the Director scores.

Nothing downstream needed to change to support this: `sexual_topics_allowed` (the flag that
actually gates the Actor's sexting instructions and self-initiated sexual nudges in
`nudge.ts`) was already event-based rather than threshold-based — the Director sets it when
the conversation has *actually* turned sexual, not when a number crosses a line — so removing
the upstream threshold that used to gate *when* the Director was allowed to reach for that
flag is sufficient on its own; the flag's own semantics didn't need touching. The two other
gates on sexual content in `blocks.ts` (`spiceBlock`'s "flag set OR arousal >= 45" check, and
the matching check for the Actor's own sexual self-knowledge block) are unaffected for the
same reason — they were already reading live conversation state, not a rolled number, so a
character can reach either path as early as the Director's own judgment allows.

Explicit photos, real name, meeting up and personal (non-explicit) photos keep their existing
threshold-gated unlocks — those are different asks (an image being generated and sent, an
identity being shared, an in-person meeting), not "is this chat allowed to be sexual," and the
Settings "Spice" slider now only scales those.

### Nothing is locked any more, and she knows her own name

Two transcripts killed the whole gate system. In the first, a character asked for an obscure
song, got one with 300 Spotify listeners, conceded it cleared the bar, listened to it,
admitted she liked it — and then immediately re-priced the earlier round as a loss and
resumed a running tally ("kraftklub still counts as a loss, ur 1 for 2"). In the second, a
character spent a dozen messages refusing her own first name, inventing a guessing game to
justify it ("guess it or earn it, ill know if ur close"), telling the user he had "a whole
profile's worth of trust to earn" — and then **rejected the correct answer**. Her name was
Emi. He guessed Emi. She said "lol thats the handle phil. not even trying".

That last one was a real bug, not a tuning problem. `identityBlock` only told the Actor her
real name once `real_name_known` was true; before that it was handed the *handle* and the
instruction "he does NOT know your real name and you have not told him... you do not simply
hand it over." The model was being asked to guard a value it had never been given, so it had
nothing to compare a guess against and denied a correct one. It now always knows her name,
is told to confirm a correct guess immediately, and is told never to run a guess-my-name
game at all.

The rest was structural. A hidden `Thresholds` roll per character gated her name, her photos
and meeting up behind trust numbers she had to accumulate. That is what produced all of the
above: the system *required* her to withhold, so the model invented in-fiction justifications
for withholding, and the justifications a model reaches for are exactly these — a toll booth,
a guessing game, a scoreboard. The gamification wasn't sitting alongside the unpleasant
behaviour, it was generating it.

So `Thresholds` is gone entirely — the interface, `rollThresholds()`, `thresholdsBlock()`,
and the "Hidden thresholds" section of the Director prompt. `unlock` survives as a *moment*
marker rather than a permission level, for the things that are real events needing a right
moment (photos, which trigger generation and a consent card; agreeing to meet). Her name is
not among them and never needs unlocking. `currentStage()` no longer demands a trust number
on top of her own stated position either — if she has agreed she wants to meet him, the
phase follows her instead of overruling her.

What replaces it is stated plainly to both models. The Director is told what the app is
actually for, that friction is a tool serving that rather than the product itself, and is
given two named failure modes to avoid: **withholding as a personality** (never write a goal
that turns basic self-disclosure into a transaction) and **scorekeeping** (never write a goal
like "make him work for it" or "maintain the upper hand", which have no resolution condition
and become a scoreboard). The Actor gets a matching section: ordinary facts about her are not
currency, answer the question and then say more than was asked, being closed about one
specific thing for a real reason is character but being closed by default is a wall — plus
explicit bans on marking his homework, on un-winning a round he already won, and on system
vocabulary ever leaving her hands ("trust to earn", levels, unlocking).

Discovery is untouched and is now the only progression: her profile still fills in as she
actually tells you things. That was always threshold-free by design — "a fact becomes known
because she said it" — it just could not work while the Director was simultaneously being
told to make her hoard those facts.

The **spice** slider was left driving nothing once the thresholds went, so rather than leave
a dead control in Settings it now says the same thing in the one place that still decides
pacing: it reaches the Director each turn as a sentence about house pacing (cooler / default
/ hot). It leans the whole cast without overriding any individual character's seed, and
because it is guidance rather than a generation-time roll, it applies immediately to matches
you already have instead of only to new ones.

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

### Terse by default was a real gap, not just seed variance

`message_length` is a seed trait (one-liner / medium / paragraphs) and is meant to produce
real variety - some characters really are one-word texters. But nothing anchored the other
two tiers to anything past their own floor: "obey your setting" only ever spelled out what
a one-liner has to stay under, and the surrounding advice ("boring is allowed", "silence is
a move", "most messages are ordinary") gave a model with no other anchor every excuse to
reach for the shortest reply that technically satisfied every rule - which reads as terse
even from a character whose setting allows far more.

Fixed the way `voice_target` already fixes the equivalent gap for voice notes: a concrete
`text_target` computed from `message_length` and handed to the Actor alongside the existing
rules, plus a direct line that being one-word or going quiet is a real, deliberate choice
for a specific moment, not the resting state of every message. The "boring is allowed"
guidance stays - a one-liner still stays one line, and "yeah" still earns its place when
that is genuinely the whole reply - the fix is only that reaching for it by default, on a
character whose setting allows real content, is no longer treated as the safe option.

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

### Photos need his consent, not just her decision

Image generation existed as complete infrastructure - a prompt assembler, a job queue, a
retry button in Settings - with nothing in the app actually calling it. The Actor could be
told a photo unlock was available, and the seed's real-name/personal/spicy tiers all had the
machinery to describe what to show, but no code path ever turned "she decided to send one"
into a real image, and the one direct-trigger endpoint had no caller anywhere in the UI.

Wiring it up raised an obvious question: if she can decide to send a photo, should the app
just generate and deliver it? The answer here is no. **Deciding to offer and actually
sending are two different things now, and only he can bridge them.** The Actor's hidden
output can set `photo_offer` (`profile` / `chat` / `spicy`) when, in that turn's messages,
she genuinely offered - "want me to send u one?", not "here's a pic" as if it already
arrived, which is explicitly forbidden in the prompt. That raises a **consent card** in the
chat - "Mira wants to send you her profile picture", Accept / Not now - and generation does
not start until he accepts it. Declining just closes the card; accepting is the one and only
thing that calls `enqueueImage()`.

A few things keep this honest rather than just decorative:
- The offer is re-verified server-side, not trusted from the model: the direction's
  `unlock` has to actually match the tier being offered, images have to be turned on in
  Settings, a profile picture can't be offered twice, and - the one that matters most for
  not being annoying - **she cannot raise a second card while one is already pending**. The
  direction block tells her so explicitly once one is out, so a still-permitted unlock does
  not read as license to ask again on top of an unanswered ask.
- The card resolves in place rather than vanishing, so scrolling back through history after
  the fact still makes sense - "You said not now" or "Accepted — sending" replace the
  buttons once he answers, both live (a new `message_updated` WebSocket/poll event) and on
  reload.
- `profile_picture_sent` is no longer something the Director scores from the conversation
  text - it could always tell what *seemed* to happen, never whether a real file actually
  got made and delivered, and now those can genuinely diverge. The system sets that flag
  itself, only once a photo he accepted has actually finished generating.

Verified end-to-end against a running server: offering while one is already pending is
suppressed; declining resolves the card and lets a fresh offer through on a later turn;
responding twice to the same offer is rejected; accepting actually runs the image job,
posts a real photo message, and flips `profile_picture_sent` - all checked over plain HTTP,
then again by driving the built app in a real browser.

### An ineligible offer used to be a broken promise, not a no-op

The eligibility check above (`unlock` has to actually match the tier, images has to be on,
profile picture has to exist first) was only ever enforced in one place: `chat.ts`, after the
Actor had already written her messages. That is fine when she never brings it up. It is not
fine when she does - and per `actor_chat.md`'s own instruction, offering IS the move, so a
turn where `photo_offer` is set almost always has her saying something like "sending you
something now~" in the messages right next to it. A real log turned up exactly this: the
Actor decided to offer a photo tier the direction had not actually unlocked that turn, the
card silently never appeared (`unlock: null` in the debug log), and her own text was left
promising something that just never arrived - a visibly broken conversation, not the graceful
"nothing happens, and that is fine" the design intends for a tier that simply never came up.

The eligibility check itself was always correct; it was only being checked too late.
`photoOfferEligible()` (now shared out of `images.ts`, alongside `PHOTO_UNLOCK_FOR`, so
`chat.ts` and `actor.ts` can't drift apart on the rule) is now also checked inside the
Actor's own retry loop, in the same place voice problems like roleplay prose or self-repeat
already get caught: if she set `photo_offer` for a tier that is not actually eligible right
now, that counts as a rejected generation, and she gets asked to write the turn again without
promising a photo that will not arrive - the same two-attempt budget every other quality
check already uses, worst case falling back to a canned line rather than ever letting the
broken promise reach the player. `chat.ts`'s own check stays in place as the actual
enforcement point (never trust the model alone), but should now essentially never have
anything left to catch.

Verified against a mock: a model that keeps insisting on an ineligible tier gets rejected
twice and never leaks that offer to the caller; a model that self-corrects on the retry
succeeds cleanly with `photo_offer` cleared; and an eligible offer still passes through in
one attempt, unchanged - no new false positive on the common case.

**Later relaxed.** The `unlock`-must-match-this-turn part of that eligibility rule, plus the
profile-picture-first ordering requirement, turned out to be exactly the kind of thing this
whole check was meant to protect against a different way: a character who, in her own
judgment, wanted to send a photo could still get silently rejected and retried by the code
for reasons that had nothing wrong with the offer itself. Which tier to offer is her call now
- `photoOfferEligible()` (in `images.ts`) only checks whether images are turned on at all and
whether a profile picture is already generating (the real duplicate-picture guard from the
fix below, not a tier gate). The actual control over how many photos get generated is the
player's own accept/decline on the consent card, not a pre-emptive block before it is ever
raised.

### She was sometimes writing the app's own system message as her own text

A real log turned up something stranger than the broken promise above: three separate turns
where one of her own chat bubbles read `system: Saskia wants to send you a photo. It might
be explicit.` - not her talking, a verbatim copy of the consent card's own text. That exact
sentence sits in her conversation history every time she has already sent a photo, and the
model was pattern-matching it back out as if it were something she would type, sometimes with
a literal `system:` prefix, once even inventing extra `photo_offer`/`photo_situation` fields
directly on the message object (harmlessly ignored, since only `text` is read from it). It
slipped through undetected: nothing in `findVoiceProblem()` checked for this, and the one
check that happened to catch it once (the one-line-quip filter) only runs on the first
attempt, so the identical mistake sailed through untouched on the retry.

`voice.ts` now has a dedicated pattern for it - a literal `system:` prefix, or the exact
third-person "wants to send you a photo" / "wants to swap profile pictures" phrasing the
consent card itself uses - checked on every attempt, not just the first, with a correction
telling her plainly that offering is done through `photo_offer`, not by describing the offer
card. Verified against a mock: a model that keeps writing the fake system line gets rejected
twice and that text never reaches the player; a model that self-corrects on the retry
succeeds cleanly with the real message.

### The self-repeat guard could burn both attempts on a narrow-themed scene

Early in that same log, an extended, tightly-themed exchange (a running feet bit) had two
genuinely different Actor generations in a row both rejected as "repeating something she
already said" - the retry budget ran out and a canned fallback line reached the player
instead of real dialogue. The check itself (`textOverlap > 0.6` against her recent messages)
is doing its job; the problem is that a sustained, narrow topic makes two independently
written replies sharing enough vocabulary to look repetitive a real possibility, not proof
either one was actually wrong - unlike the harder, close-to-unambiguous checks next to it
(roleplay prose, narrating him, announcing her own agenda), which stay enforced on every
attempt because they are actual formatting violations, not a judgment call.

`findVoiceProblem()` takes a `skipRepeatCheck` flag, set by `actor.ts` only on the final
retry attempt - mirroring the precedent already set by the one-line-quip filter, which has
always only run on the first attempt for the same reason. A reply that still reads as
repetitive on the very last try now gets accepted rather than thrown away for a canned line;
everything else she could still be rejected for stays enforced right up to the end. Verified
against a mock: a second attempt that still overlaps with an earlier message is now accepted
and returned as the real reply, not swapped for the fallback.

**Later loosened further.** A single overlapping message was still enough to trip the check
on its own, and in practice that fired on a lot of ordinary conversation - characters are
allowed to circle back to something they already said, restate a fact, or pick up an earlier
thread, and none of that is a stuck record. `selfRepeat()` now requires the same point to
have already come up `SELF_REPEAT_ALLOWANCE` (3) times in her recent history, not once,
before flagging it again - she can echo herself a few times over before it counts, only the
genuinely worn-out repeat gets caught. The overlap threshold itself also moved from `0.6` to
`0.75`, so only near-identical phrasing counts as the same point at all. Verified against a
mock: a message that overlaps with exactly one prior message is no longer rejected at all
(reaches the caller on the first attempt), while a fourth near-identical repeat still gets
caught and, per the fix above, is accepted on the retry rather than falling back.

### Voice messages
---

## Character generation

Every seed is rolled once and never changes. Generation runs as a **cascade** rather than
one flat roll, because the order is what makes a character hold together:

1. **Age and the languages she speaks**, conditioned on nothing. These are the base.
   Languages are a soft stand-in for where she or her family are from, which is what later
   makes a name plausible; age decides which lives are even available to her.
2. **Who she is** — archetype, personality, how she writes, and her life (work, housing,
   relationship status, history).
3. **What she looks like**, drawn knowing the person underneath.
4. **What she is into**, the non-sexual half.
5. **The intimate half**, last, knowing everything above.

Each stage is drawn knowing the ones before it. The mechanism is `ctx.weights`: any drawn
tag may carry `extra.weights` that re-weight later draws, which used to be a privilege of
the archetype alone and is now available to every row in the tables. Weights are lowered,
never zeroed — outliers should be rare, not impossible. Affinities and conflicts still
apply on top (drawing "anime" raises cosplay, gaming and Japanese; implausible physical
combinations are blocked outright).

Age is the exception, because it is a number rather than a tag and cannot carry weights of
its own; `ageWeights()` is its equivalent. Measured over 4000 rolls it moves what it should:

| | 22 or under | 33 or over |
|---|---|---|
| in student halls or at her parents' | 24.9% | 3.0% |
| is a student | 14.6% | 0.5% |
| divorced, or married briefly | 0.5% | 10.4% |
| never had a serious relationship | 14.6% | 3.7% |
| married / engaged-open / separated | 1.3% | 10.9% |

Looks used to be rolled *before* personality, which meant appearance could never reflect
the person underneath — only the archetype could reach it. The language count used to come
from the archetype too, which coupled how many languages she speaks to how she behaves; that
is an odd pairing once a language is standing in for background rather than personality, so
it now uses one distribution for everyone.

After the rolls, three LLM passes finish her: a **Director coherence pass** that may swap at
most two tags and writes her **dossier** along with the rest of her seed's free text, then
the Actor writes her **handle** from the dossier, then her **bio** from the dossier.

`search_motive`, `touchstone`, `turn_ons` and `turn_offs` are rolled *without* the archetype
filter, on purpose. A character who ticks differently than she looks is the interesting case.

### The dossier: a character, not a tag list

Her handle and her bio used to be written from the raw roll — `describeSeed()`, the full
attribute dump, straight into both prompts: forty-odd lines of `label - hint` pairs. Two
women who happened to roll three of the same tags produced suspiciously similar bios,
because "suspiciously similar" is exactly what a spec sheet read out loud sounds like.

The coherence pass now writes a **dossier** — several paragraphs of prose, the way a casting
document or a character bible entry would, not a restatement of the tags with commas turned
into sentences — and it is what everything downstream actually reads. Nothing else changed
about the pass itself: it still does the coherence swaps, still writes her name, her avatar
emoji, her online windows. Writing her out in full is just the main thing it does now, and
everything else is the smaller output alongside it.

The instruction leans hard on one point: a real woman with this exact profile has specifics
the dice never rolled — what she actually calls her cat, why this job and not some other
one, what she is like at 2am versus a work lunch — and inventing two or three of those,
consistent with everything else, is what a spec sheet cannot do and prose can. That is the
actual point of the exercise, not the prose itself.

One section of the dossier is deliberately load-bearing rather than merely descriptive: how
she actually texts. Typing habits, typo rate, emoji use, message length, reply speed, voice
notes. The bio prompt has always leaned on this ("a lowercase no-punctuation woman writes
the bio that way"), and once the raw attributes are gone from that prompt, this paragraph is
the only place that information still exists — so it is asked for as usable fact, concrete
enough to write a message in her exact voice, not just flavour.

The raw attribute dump did not go anywhere — `describeSeed()` is still what the coherence
pass itself reads to write the dossier in the first place, and it still backs the debug
endpoints and the vision self-check. It just stopped being what the handle and the bio see.
If the coherence pass fails outright, `seed.hints.dossier` falls back to it, so a character
still gets a handle and a bio rather than nothing — verified against a mock that fails the
coherence call specifically: generation still completes, and only in that failure case does
the handle prompt see the raw tags again.

The pass writes more now, so its budget was raised accordingly — see *"Headroom over
truncation, everywhere"* below for the current numbers, which have moved again since.

### There is no "her whole thing" any more

Every character used to draw a **signature** — one heightened defining trait. A declared
nemesis, an inherited lighthouse, a small cryptid podcast. It was rolled without the
archetype filter so it would cut against the rest of her, and the Actor, Director and bio
prompt were all told to build around it.

It has been removed outright. The intent was to stop characters being forgettable soup; the
effect was characters who were one-dimensional in a different way — every conversation bent
back toward the one thing, because three separate prompts were pointing at it. Successive
attempts to tune that down (surface it "rarely and sideways", "at most once per
conversation") were treating the symptom: as long as one tag is designated *the* interesting
one, it gets used like one.

What replaces it is the rest of the profile. The Director is now told her whole profile is
material and no single part of it is her defining trait, and to pull `bring_up` from all of
it in turn — her work, her flat, a hobby, who she lives with, what she did at the weekend.
The character prompt says the same thing from the other side: what stops her being
interchangeable is the particular combination, and there is no headline trait to invent.

The **heightening** slider went with it, since it existed only to weight the signature pool.
`rarity_bias` already covers how much of the rare tail shows up.

### What the swipe card shows, and who is on it

The card is her handle, her avatar emoji, her **age**, any **language she speaks besides
English**, and the bio. No photo, no job, no distance. English is left off because everyone
speaks it, so it says nothing about her; the bio prompt is told the age and languages are
already on the card, so a bio that repeats them is wasting a line.

A **preferred age range** lives on your profile under Settings, defaulting to 18–42, which
is exactly the band generation used to be hardcoded to. It does two things: new characters
are rolled inside it, and anyone already in the pool outside it is hidden. Both halves
matter — `swipeStack` and `countPoolAvailable` filter identically, because a stack that hid
characters the counter still counted would stop topping itself up and sit empty forever.

Ages are drawn on a triangular curve across whatever band is set, so the middle is common
and the edges are not — the same shape the fixed 18–42 roll had, rescaled. 18 is a hard
floor enforced at the profile, at the clamp and again at the roll, and a range saved back to
front is sorted rather than matching nothing.

### Relationship status

Separate from `living_situation`, which is housing (lives alone, flatshare, at her parents'),
and from `relationship_history`, which is the past. This is who she is attached to *now*:
single, newly single, seeing someone casually, has a regular, a boyfriend or girlfriend in an
open relationship, part of a polycule, an open marriage, separated, a partner abroad, or
deliberately vague about something unresolved.

Weighted so the cast reads like a hookup app rather than a scenario: about 61% are single or
newly single, a quarter are attached in some openly non-monogamous way, and the rarer
arrangements sit in the tail (polycule 1.4%, open marriage 1.3%). Anything involving a
partner is written as openly non-monogamous in its prompt hint — "he knows she is on here,
do not play this as cheating" — so it is a fact about her life rather than a betrayal plot.
Age conditions it: an eighteen-year-old is very unlikely to be separated or in an open
marriage, and a thirty-five-year-old is much more likely to be.

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

The defence against the stack converging on its own is deliberately a *check*, not a
constraint — nothing tells her what shape a bio should take, it only refuses one that has
already been written. Two things were wrong with the first version of this. The avoid-list
was drawn from `state IN ('pool','swiped_left')`, which excluded matched characters, so the
bios you had actually read closely were the only ones a new character was free to imitate;
it now covers every bio in the app, thirty deep. And nothing verified the result — the
retry loop only ever checked word count, so a model that ignored "do not repeat these"
(which it has no memory of the other calls to hold it to) shipped a near-duplicate
unchallenged.

A new bio is now compared against the existing ones on word overlap and on its opening few
words, reusing the same token-overlap heuristic already proven against her repeating her own
lines mid-conversation. A collision is sent back with the offending bio quoted and an
instruction to find a different angle on the same woman. If it still resembles an existing
bio after three attempts it is kept rather than swapped for a hardcoded fallback — leaning
on a fixed pool of twelve is how a cast converges for real — but it is logged loudly, since
a model that cannot get clear in three goes is worth knowing about.

**That check fixed word-for-word repeats and the bios still felt the same**, because the
sameness was never lexical. Two causes, both in the prompt:

The three GOOD examples under "write it in her hand" were lifted verbatim out of
`FALLBACK_BIOS` — and all twelve of those were the same three-beat shape (quirky concrete
detail / blunt line about what she wants / closing hook). So the model was shown three
samples of one house style and asked to produce a fourth, which is the strongest attractor a
prompt can contain. The examples are now register-level fragments ("I am not particularly
good at this part" → "im bad at this bit") that demonstrate how words sit on a page without
modelling what a bio is made of, and the fallback pool has been rewritten across genuinely
different shapes — run-ons, fragments, a one-liner, a properly-punctuated one.

More importantly the prompt *specified* that shape while claiming not to. It required a
concrete detail AND what she is like AND what fills her days AND what she wants AND
something physical AND a hook, in 25–60 words across "two to four short lines" — six
mandatory beats and a layout, which between them admit roughly one bio. Saying "there is no
template for this" at the top does not help when the rest of the page enumerates one. Those
beats are now described as what *tends* to make a bio work, followed by an explicit
instruction not to hit them all: most real bios are lopsided, some are three unrelated
fragments with no hook, some never mention anything physical until the last four words. The
line-count rule is gone — how the words are broken up is hers. And the test is stated as a
check rather than a recipe: if the bio could be handed to another woman in the list by
swapping a couple of nouns, it is the wrong bio.

Her typing style now also drives the register outright. It previously said lowercase unless
her style says otherwise, with a properly-punctuated bio framed as "the exception" — which
made nearly every character write in the same voice regardless of her seed.

### Names

Real names were the last field with no protection of any kind: whatever the model returned
was kept, with no avoid-list and no duplicate check. Asked for "a first name that fits her"
with no knowledge of the rest of the cast, a model goes to its priors every single time,
which is why the stack kept filling with four variations on the same handful of names. (The
hardcoded `FALLBACK_NAMES` pool — Mila, Lena, Sofia, Nora, Nina, Maya — is the same priors
written down, which is the tell.)

Names now get what handles get: the cast so far goes into the prompt, with a note that the
name which comes to mind first is almost certainly one already used, and a pointer at the
range real people are actually named across — names passed down, names fashionable the
decade she was born, names from her parents' country rather than the one she lives in,
nicknames she actually goes by. Behind that, a check catches exact repeats *and* near
neighbours, since Mila beside Mia and Sofia beside Sophia are what actually make a cast feel
small. A clash re-asks, in the same call as a clashing handle when both collided.

**A reroll used to fix the field and nothing else.** The dossier — the paragraph everything
else, including the handle and the bio, is actually written from — comes from the same
generation call that picked the name that just got rejected, and it names her throughout its
own prose. Rerolling `real_name` never touched that prose, so `write_username()` and
`writeBio()` went on reading a dossier that confidently described "Layla" for a character who
was, from that point on, actually named something else entirely — caught in a real log twice,
both times producing a handle built for the wrong name (`layla.raw` for a woman actually named
Thalia). `renameInProse()` now swaps every whole-word occurrence of the rejected name for the
real one, in both the dossier and the short `one_line` descriptor, the moment a reroll
succeeds — so everything written after it, including the stored `seed.hints.dossier` itself,
actually agrees with who she ended up being. Verified against a mock: forcing a name clash
and reroll, the username and bio prompts (and the persisted dossier) all use the new name and
never mention the rejected one.

### Handles

Usernames had the same problem in a worse form, because they had none of the defences bios
had: the character-generation prompt passed **no avoid-list at all**. Every handle was
invented with no knowledge of the rest of the cast, so the model kept returning to whichever
two or three constructions it liked, and the only uniqueness check was an exact string match
at insert time that "fixed" a clash by stapling random digits on the end — itself a
giveaway, and useless against `late.bloomer` sitting next to `late.riser`.

The cast so far now goes into the prompt as data, and the instruction around it is about
variety rather than format: there is no house style to match, real handles are all over the
place, work out what *this* woman would have picked. Behind that is a check that compares
handles on their words with the separators and digits thrown away, so `late.bloomer`,
`latebloomer` and `bloomer_late` all read as the same idea. A collision triggers one cheap
re-ask for the handle alone — the character behind it is already settled and fine — and the
fix stays on the model's side instead of mangling a good handle into a numbered one. Exact
duplicates still fall back to the digit suffix, but that is now the rare last resort it was
meant to be rather than the routine outcome.

Over-long handles are cut back to a separator rather than mid-word, since `genuinely.differen`
reads as a glitch, which is the opposite of the point.

**Only a sample of the cast reaches the prompt.** The whole list still decides the clash, but
showing all of it was quietly making the ask impossible: the instruction was "must not share a
word with any of them, rework one, *or follow the same construction*", against every handle
ever made. By the twentieth character that forbids `_jpg`, `hrs`, `.exe`, `_xo`, `__`, `ish`,
`404` and `_txt` at once — which is most of the ways a handle is built — and it tightens with
every character generated. An ask that cannot be satisfied does not produce originality, it
produces a refusal, and the avoid-list in the logs was itself the evidence: it was full of the
repetition it was supposed to prevent. Eight handles now, phrased as "not these", with
`nearestHandle` catching what slips through. Bios get the same treatment for the same reason —
ten shown rather than thirty, which also stops a thousand tokens of the prompt being a lesson
in exactly what to sound like.

Separately, there is a small fixed pool of twelve fully hardcoded bios (`FALLBACK_BIOS`) —
not AI-written at all — used only when the API call fails outright after its retry. If a
bio looks suspiciously identical to one seen before rather than just structurally similar,
that is the tell: check the logs (scope `generator`) for "bio generation failed, using
fallback" to see whether the model is actually being reached.

### Your own character card

You get the same card the characters get, built from the same attribute tables — so whatever
you pick, a character already has the vocabulary to talk about it. Twenty-seven fields across
five collapsible sections in Settings → Your profile, all optional; a blank card is valid and
just means nobody knows much.

What is deliberately *not* there: typing style, message length, response speed, emoji usage,
slang register. Those are machinery for driving the Actor's voice. You have a voice of your
own, so they would be filled in and then never read.

Who sees what follows the rules the app already has, rather than inventing a fourth one:

| Section | Who sees it, and when |
|---|---|
| Your life, what you're into, what you want | On your profile — known, the way she would having read it |
| What you look like | Only after you have swapped profile pictures |
| The intimate half | Discovered in conversation, on the existing kink-discovery path |
| Your hard limits | **Always** visible to her |

Limits are the deliberate exception. Finding one by crossing it is not a game, so she is
told them up front and told they hold whatever the mood is — not to push, not to talk you
round, not to bring one up to test it.

The Director sees the whole card including what puts you off and your dealbreaker, because
it scores your side of the conversation against them; the Actor does not, so she is not
quietly avoiding things she was never told.

Two details worth knowing. The editor is rendered from the same spec the validator uses
(`CARD_SECTIONS` in `engine/usercard.ts`), so adding a field needs no frontend change — and
the server keeps only ids that actually exist in the right table, so nothing invented reaches
a prompt. And because the attribute tables were written for the women the app generates,
their labels say "her" — "still at her parents'", "small flat of her own". Reused verbatim on
your card that reads as a mistake in every prompt you appear in, so pronouns are swapped to
match the gender you gave, on word boundaries only.

### Profile pictures go both ways

You get an emoji too. It sits on your profile the same way hers sits on hers, and it is what
a character sees of you until the two of you have actually swapped.

Seeing a real picture is **one mutual event**. A character cannot see yours until you have
seen hers, and the reverse — so her picture is worth offering, and asking for yours is worth
doing. Either side can start it:

- **She offers.** The existing consent card, now worded as a swap: accepting shows her yours
  at the same moment her image starts generating.
- **You offer.** A camera button in the chat header raises a request — and she answers it on
  her next turn. She is told plainly that it is her call, that no is a real answer, and that
  a refusal comes with a reason in her own voice. It is not a button that reveals things
  regardless; that would make both pictures worth nothing.

The agreement and the delivery are tracked separately. `photos_exchanged` records that the
two of you agreed, `profile_picture_sent` that her image actually finished generating — so
she can see yours even if her own generation later fails, and her picture only renders for
you when both are true. The server refuses a second request while one is pending, and any
request once you have already swapped.

What she is told tracks it exactly: before a swap she has your emoji and knows a real one
exists behind it; after, she has seen it and can refer to it or ask about it. If you have no
photo uploaded at all she is told that too — and that she is allowed to find it funny.

### What a generated photo looks like

Her **appearance** is fixed at generation and must survive into every prompt unchanged —
that part already worked. What was missing is that nothing about *who she is* reached the
image, so twelve different women came back wearing the same blank catalogue expression.

Every archetype now carries a written **photo demeanour** in `personality.json`: expression,
where her eyes go, how she holds herself, and how the shot itself was taken. A shy character
gets a small closed-mouth smile, eyes slightly off-camera, shoulders drawn in, taken at
arm's length; a provocateur gets a challenging stare, a slow smirk, leaning back as if
daring you. Social energy and humour bend it further — the same face is a different photo on
someone who hates being photographed. The assembler is told plainly that appearance decides
what she looks like and this decides everything else, and that two characters with identical
faces should not produce the same picture.

**The style holds two things at once**, because pushing either alone fails in a predictable
way. "Candid amateur phone photo" on its own reads as licence to make her unflattering — bad
angle, sickly cast, a face nobody would swipe on. "Beautiful" on its own returns a retouched
render with plastic skin, which is the single most obvious way a picture stops looking like a
person. So both are stated: a real photo, available light, unretouched skin with visible
texture — of someone who happens to be attractive, at a flattering angle. If only one can
survive into a tag, the prompt says choose real.

**A negative prompt is finally sent.** The assembler had always returned a `negative_prompt`
and it was being dropped on the floor — `generateImage` never had a parameter for it, so
nothing was ever excluded. Its shot-specific negatives now ride along with a standing set
that fights airbrushing, beauty filters and plastic skin on one side and ugly angles, harsh
flash and sickly tones on the other, plus the usual renders, anatomy errors and watermarks —
a **glamour-shot/studio-lighting ban** used to ride along too, universally, until it started
actively fighting the one case it should not: see below.

### Her profile picture is her choice of photo, not a house style

Every image used to get the same forced style suffix - `candid amateur phone photo`,
handheld, sensor grain - and the same standing negative banning `studio lighting,
professional model, ... stock photo`. That is right for a photo from inside a
conversation, which really is a moment caught on her phone. It is wrong for a **profile
picture**, which real people lead with in every register there is: a professional headshot,
a work photo repurposed because it is simply the best one that exists, a friend's candid, a
posed full-body shot, a five-minutes-ago mirror selfie. Forcing the candid look onto all of
them, and banning "professional" outright, meant every profile picture came out the same -
an amateur selfie, regardless of who she was.

Worse, the situation handed to the assembler for a profile shot was `''`. Blank. The
assembler had no framing, no setting, nothing to distinguish a headshot from a full-body
shot - it filled the gap with the same default every time.

**The fix asks her.** A new Actor call - `actor_profile_pic.md`, working from her
**dossier** - answers one question in her own voice: what does her actual lead photo look
like, and why this one and not some other perfectly fine photo of her? It is told explicitly
not to default to candid: a professional or studio shot, a repurposed work photo, a posed
shot a friend took, a mirror selfie, something from a hobby - genuinely vary it, and let the
kind of photo and how much of her is in frame (face only, waist-up, full body) follow from
who she is, not from a house style. An ambitious, put-together archetype plausibly has a
good professional photo and uses it without a second thought; a guarded one might have
exactly one old picture she still likes; a chaotic one might have grabbed the
least-blurry shot from a night out an hour before opening the app. This runs once, lazily,
the first time a character actually needs a profile picture - not for every character
rolled, most of whom are never matched with, let alone reach the picture swap.

That answer becomes the situation the image assembler works from, and the assembler's own
instructions now branch on it: for a profile picture, her account of the photo decides the
register, and the style suffix and the studio-lighting ban are only applied to a chat or
spicy photo - a real moment inside the conversation, which still always has to look candid.
A studio headshot now gets composed lighting and a clean background instead of being fought
into looking like a bad phone photo; a selfie still looks like a selfie. Whichever it is,
she is still a fairly represented, attractive woman - a bad photo is not what "honest"
means, in either format.

If the call fails outright, generation still proceeds with a plain generic default rather
than stalling - verified against a mock that always fails it: the retries exhaust, the
fallback situation reaches the assembler, and the job still completes.

### Her profile picture is always first, on purpose

Nothing used to stop her offering a spicy photo before he had ever seen her face. The
Director's `unlock` field treats every tier as the same fresh, no-schedule judgment call —
deliberately, so nothing reads as a trust meter — but "no schedule" also meant a forward
character could jump straight to `spicy_photos` in her first exchange while
`profile_picture` had never even come up. `director_direction.md` carries one fixed
exception on top of that judgment: it tells the Director not to set `unlock` to
`personal_photos` or `spicy_photos` until the `profile_picture_sent` flag is already on. It
is framed as how a real dating profile works, not as a reintroduced trust gate: you see her
main photo before anything else, in the normal case.

**No longer enforced in code.** This used to also be a hard server-side check — `chat.ts`
would refuse to honour a `chat` or `spicy` offer at all until `profile_picture_sent` was set,
regardless of what the model decided, and `actor.ts` would reject and retry a turn that tried
it anyway. That turned out to be exactly the kind of artificial barrier the player, not the
software, should be the one enforcing: a character who genuinely wanted to send a photo out
of order could get silently blocked for a reason that had nothing to do with whether the
photo itself was welcome. The ordering above now lives purely as guidance to the Director's
own judgment, same as every other unlock; nothing in code stops a character from offering a
different tier first if that is what actually fits the moment. The consent card - and the
player's own accept/decline on it - is the real control.

### She could send her profile picture twice

Accepting a pending profile-picture *exchange* and making a fresh profile *offer* are two
separate code paths that both end up at `enqueueImage`, and nothing stopped the Actor from
triggering both in the same turn — accepting his swap request while also, in the same
breath, setting `photo_offer: "profile"`. The exchange-accept path enqueues its job
synchronously, but `profile_picture_sent` only flips once that job actually finishes
generating, seconds later — so the offer's own eligibility check, which used to read that
flag, still saw "no profile picture yet" and raised a second, redundant offer card. Once
that card was later accepted, a second, independent profile picture got generated and sent.

The fix checks the `images` table itself — `hasProfileImageJob()` — rather than the
completion flag, at all three places a profile job can start (a fresh offer, an accepted
offer, an accepted exchange). Because the table insert happens synchronously, whichever path
gets there first makes every other one ineligible for the rest of that turn, closing the
race rather than narrowing its window. `actor_chat.md` also now says plainly that accepting
an exchange already covers sending her profile picture, so the ambiguous case comes up less
often in the first place — but the server-side check is what actually guarantees it.

### What else she sends, and in what shape

Two things were still narrower than a real person's camera roll:

**Subject matter.** Every non-profile offer implicitly meant a selfie. `actor_chat.md` now
says plainly that once it is not the profile picture, she is free in what the photo actually
shows — an outfit she is proud of, her view right now, food, something she is doing, or
nothing of her at all: a sunset, her dog, the mess on her desk. The assembler template
carries the matching instruction on the other end: read the situation first, and if it does
not put her in frame, do not paint a woman into the image at all — her appearance block and
visible marks are background continuity only in that case, not something to render.

**Aspect ratio.** Every shot used to render at one fixed size regardless of what it showed.
She now picks one herself: `photo_aspect` (`portrait` or `landscape`) joins `photo_offer` and
`photo_situation` in the Actor's hidden output, carried through `PendingPhoto` and the
`images` table's new `aspect` column so a retried job reuses the same call rather than
re-guessing. A profile picture ignores it and is always square (`2048x2048` — the one slot
every dating app treats as square); everything else resolves to `2048x3072` for a tall
phone-style frame or `3072x2048` for a wide one, sent as `generateImage`'s `size` override.
Omitting `photo_aspect` defaults to portrait rather than failing closed.

Verified against a mock provider end to end: a profile job renders square regardless of
aspect; a chat offer with `aspect: 'landscape'` renders `3072x2048`; a spicy offer with no
aspect set defaults to portrait and renders `2048x3072`; and accepting a pending offer
through `respondToPhotoOffer` carries the aspect she offered with into the real job, not just
a freshly-enqueued one.

### The prompt itself, rewritten for how this model actually reads it

The assembler's contract used to be "output one line of comma-separated tags" — standard
practice for most diffusion front-ends, but a bad fit for the model this app actually
targets. Seedream 5.0 Lite reasons over the prompt like a brief before it renders: it wants a
written paragraph that front-loads the subject, names the light and pins how things sit in
space, and it has no dedicated negative-prompt channel — negations are plain sentences kept
to one or two items, not a tag dump. Keyword-stacking and quality-booster words
("masterpiece", "8K", "ultra-detailed") are noise to it, not signal.

`image_prompt_assembler.md` now says this explicitly up front and asks for one flowing
paragraph in photographer's-brief style instead of a tag line, with the negative prompt cut
to the one or two things a given shot actually risks. `images.ts`'s standing suffixes and
negatives moved the same direction: `BASE_SUFFIX`/`CANDID_SUFFIX` are now sentences appended
as prose rather than comma-joined onto the assembler's output, and `BASE_NEGATIVE` — five
long comma-separated tag dumps before this — is two short plain-language sentences. Verified
against a mock: the final prompt sent to the image endpoint reads as continuous prose with no
bare comma-tag tail, and the negative prompt carries the assembler's own text plus the
shortened standing set, space-joined rather than comma-glued.

### Only what the shot actually shows

The fixed appearance block used to be dumped into every prompt whole, and the reference
image (her profile picture, sent to the image model so a chat/spicy shot's face actually
matches her) was attached to every non-profile shot regardless of what that shot was. Both
were wrong for a photo that does not put her face - or all of her - in frame: a hands-only
close-up got her eye colour recited anyway, and a from-behind shot still came back with her
face front-on, because a reference image is a strong pull toward showing the face it depicts.

`ActorHidden` gained `photo_shows_face` alongside `photo_aspect` - false only when she
deliberately picked a shot that does not put her face in frame (turned away, cropped to her
hands, a scene she is not even in), true otherwise. `images.ts` now skips the reference image
entirely whenever this is false (`runImageJob`'s `facesCamera` check), and the assembler gets
a `hides_face` flag that tells it plainly not to describe her face, eyes or expression for
that shot - describe what is actually visible instead. The instruction above it was also
loosened from "keep every attribute in the fixed block" to "only describe what this specific
framing would actually show" - a waist-up shot does not need her shoes, a from-behind shot
does not need her eye colour. `visibleMarks()` picked up the same principle mechanically: a
facial piercing (nose, septum, eyebrow, lip, and the rest of `FACIAL_PIERCING_POSITIONS`)
drops out of the list whenever the shot hides her face, the same way a piercing already
dropped out when its own visibility tier did not clear.

### Two models, two prompts: Seedream 5.0 Lite and Z Image Turbo

Everything under "The prompt itself, rewritten..." above was written for one model. Wanting
to actually compare it against Z Image Turbo (cheaper, quality unverified) meant the prompt
style itself had to switch too, not just the model name - the two want genuinely different
prompts, not a shared one with a different label on it. Z Image Turbo runs with no
classifier-free guidance at inference at all, so it never reads a negative prompt - every
constraint has to be a positive statement inside the main prompt ("natural, unretouched
skin", not "no airbrushing").

`settings.models.image.prompt_style` (`'seedream'` | `'z_image_turbo'`, a new dropdown in
Settings → Images) picks between them. `image_prompt_assembler.md` branches its own
instructions on `mode_seedream`/`mode_z_image`, including telling the model to leave
`negative_prompt` empty in Z Image Turbo mode rather than writing one nobody will read.
`images.ts`'s `BASE_SUFFIX`/`CANDID_SUFFIX` became per-mode records - Z Image Turbo's variant
folds what Seedream would have put in the negative prompt into the positive suffix instead -
and `runImageJob` skips sending `negativePrompt` to the image call entirely when the mode is
Z Image Turbo, whatever the assembler returned. Switching modes is meant to travel with
switching "Model" below it; the two are independent settings because nothing stops testing
one against a Seedream-shaped model name by mistake, but they are meant to move together.

**The first version of this got the length wrong, and it was not a style nitpick - it
produced real request errors.** Z Image Turbo's own published guidance says it prefers long,
fully-specified prompts, and the instructions here originally said so too. What actually
matters is the specific deployment this app talks to, which hard-rejects a "prompt" over
roughly 1200 characters regardless of what the model itself would rather have. Two things
now enforce that instead of one hopeful paragraph:

- `zCharBudget` in `runImageJob` computes the room actually left for the assembler's own
  text - `Z_IMAGE_MAX_CHARS` minus however long `BASE_SUFFIX`/`CANDID_SUFFIX` already are for
  this shot - and hands it to the assembler as a concrete number (`{{z_char_budget}}`), not a
  vague "keep it short". The template's Z Image Turbo section now leads with that as a HARD
  LIMIT and explicitly disclaims the model's own "long prompts are fine" reputation as not
  applying to this deployment.
- The instruction is still just a request the model can ignore, so `runImageJob` also trims
  the assembled prompt in code if it comes back over budget (`truncateAtWord`, cutting at the
  last whole word rather than mid-word) before it ever reaches the image API. The style
  suffix itself is never trimmed - it is short and carries the standing quality instructions
  that matter on every shot, so the assembler's own prose is what gives way if something has
  to.

Verified against a mock that deliberately ignores the budget and returns a several-thousand-
character reply: the request that reaches the image API still stays under the limit, cut at
a word boundary, with the assembler's own instruction text carrying the real number rather
than a hardcoded one.

### Regenerating a photo, two different ways

There was no way to ask for another take on a photo that was not what she meant, or to
retry one that failed with anything but its own raw final prompt fed back in as if it were a
fresh situation (`retryImageJob` used to do exactly that - a real bug once the same jobs
row started carrying a proper `situation` column, fixed alongside this). Two genuinely
different asks needed two different paths:

- **Same idea** reassembles the stored `situation` through the assembler and the image model
  again from scratch - same content, a fresh prompt, different pixels. Useful when the idea
  was right but the render was not.
- **New idea** asks her to think of a different photo first: `profilePicConcept()` again for
  a profile picture, and a new `actor_photo_idea.md` call (mirroring it, but for a chat/spicy
  tier, with its own aspect choice) for anything else.

`regenerateImage(id, mode)` in `images.ts` does both, reusing the same job id and file path
so the chat bubble and gallery thumbnail that already point at it just show the new image
once it lands, rather than needing a duplicate message or a second file on disk. The one real
wrinkle is that regenerating does not change the URL - a browser that already cached the old
bytes under that exact path would just keep showing them. Fixed with a cache-bust rather than
a versioned filename: the message meta gets an `image_v` timestamp bumped onto it
(`findMessageByImageId()` finds the message from the job's stable id), appended to
`image_url` as `?v=...`; the gallery endpoint does the same off the job's own `updated_at`.
Two small icon buttons appear on her most recently sent photo in chat - a refresh icon for
"same idea", a spark icon for "new idea" - deliberately scoped to her *last photo*, not
every photo she has ever sent, mirroring the existing text-reply regenerate button; unlike
that button, this one is not tied to being the literal last message in the conversation,
since a photo is delivered as its own standalone entry and a later reply from her should not
hide the ability to redo it.

Verified against a mock: a face-shown shot still sends the reference image and lists a
visible facial piercing, a face-hidden shot sends neither; Seedream sends a negative prompt
and Z Image Turbo sends none at all; "same idea" reuses the stored situation and keeps the
same job id/path; "new idea" genuinely calls the actor for a new situation and aspect and
gets a different one back; and `retryImageJob` now reuses the stored situation rather than
the old final prompt.

### Spicy stays suggestive, on purpose

Nothing had ever told a spicy photo where the actual line was. `photo_situation` and the
prompt assembler were both free to describe full genital nudity if that is what the moment
implied, which turned out to be a bad idea twice over: providers tend to refuse a request
that so much as names a vagina or a penis, even to explicitly avoid depicting one, and the
result is usually an ugly, anatomically-wrong render on the rare occasions it does go
through. The fix is not a word filter - it is telling both the character and the assembler to
think about the shot the way a photographer actually would.

`actor_chat.md` (the "Sending a photo" section) and `actor_photo_idea.md`'s spicy branch now
say plainly where the line is: as daring and hot as the app gets, breasts included, but never
a shot of her genitals bare and centred - gotten there through angle, crop and pose the way
real intimate photography usually stays suggestive, not through anything drawn over the
image. `image_prompt_assembler.md` picked up a matching `is_spicy` section (a new flag from
`images.ts`, set only for the `spicy` kind) that tells the assembler the same thing, plus the
part that actually matters mechanically: **never write the word for what the shot is avoiding,
in either the prompt or the negative_prompt** - naming it, even to exclude it, is exactly what
tends to trigger a refusal instead of preventing the thing it was trying to prevent.
`DEFAULT_SITUATION.spicy` (the fallback when the Actor left no concrete detail) was reworded
the same way, from "an explicit photo" to "a suggestive, revealing photo".

Verified against a mock: a spicy job's assembler prompt carries the new section, explicitly
says breasts are fine and explicitly forbids naming the thing being avoided; a chat or
profile job - kinds where this was never reachable anyway - renders neither.

**Later found to undersell itself even during heavy sexting.** A real log turned up two
spicy photos, sent mid-sexting, that came back reading as barely more than a low-cut top -
`photo_situation` had settled for "a hint of cleavage" and "her resort wear, cleavage
prominent" rather than anything that matched how far the conversation had actually gone. The
old wording leaned entirely on "the angle, the crop, what a hand or a sheet happens to be
covering" as the way to stay suggestive - good advice for the one line this tier still does
not cross, but nothing was pushing the rest of the shot toward being explicit in the first
place, so both the Actor and the assembler defaulted conservative.

`actor_chat.md`'s "Sending a photo" section, `actor_photo_idea.md`'s spicy branch, and
`image_prompt_assembler.md`'s `is_spicy` section all now say the same thing more concretely:
the shot should genuinely match the heat of the moment it comes from, not undersell what has
already been said - underwear or lingerie with real skin showing, a hand between her thighs
or slipped inside her waistband, a visibly aroused expression are all normal for this tier,
not something to hold back "to keep it classy." The one line that still does not move is full
nudity of her genitals - get past that one specific point through angle, crop or pose, rather
than pulling the whole shot back into something demure to stay safely clear of it.

### A guaranteed trickle of progress: trait credits

Her profile sheet fills in from what she actually tells you, on her own schedule - the whole
point, per its own doc comment, is that nothing is revealed by a threshold. That is also its
one real weakness: some conversations just do not happen to surface a given fact, and a slow
one could sit at "12 of 45 things known" indefinitely with no lever the player can pull.

**Every 50 messages you send a character now earns one credit for her**, spendable on
revealing one random trait from whatever is still locked in her profile - a small,
guaranteed payoff for showing up that does not depend on her choosing to say anything. It
sits entirely alongside the organic system, not instead of it: `discovery.ts`'s
`trackMessageForCredit()` counts every message through `handleUserMessage()`
(`rel.flags.state.messages_sent_count`, a new field) and awards a credit on every 50th, and
`spendTraitCredit()` picks uniformly from `undiscoveredKeys()` and commits it through the
same `recordDiscoveries()` the organic reveals already use - an uncovered trait is
indistinguishable from one she just told you, because as far as the rest of the app is
concerned, it is the same event.

A credit spent when nothing is actually locked (profile fully known) or with none available
fails cleanly and spends nothing - there is no reward for a wasted click, and no credit lost
to bad timing. The profile sheet shows the count and an "Uncover a trait" button right under
the progress bar, disabled once credits or locked traits run out, with the just-revealed
label and value shown inline so it does not require re-reading the whole list to find what
changed. `GET /api/chats/:id/profile` and the new `POST /api/chats/:id/uncover-trait` both
carry `trait_credits` in their response.

Verified against the real counting path (not just the pure function): 50 real
`handleUserMessage()` calls through a mock Actor earns exactly one credit, matching what the
unit-level checks on `trackMessageForCredit`/`spendTraitCredit` already covered - the count is
accurate message-by-message, spending never reveals the same trait twice, and a credit
genuinely survives a failed spend rather than being silently burned.

### Every photo she sent, kept

A photo used to exist only as a bubble in the chat. Scroll far enough and it was gone —
there was no way back to a picture from three hundred messages ago short of scrolling for it.

Each character now has a **gallery**, served by `GET /api/chats/:id/gallery` and shown inside
her profile sheet under a `Photos (n)` heading: every finished image for that character,
newest first, as a single row of thumbnails you scroll sideways through. It reads straight
from the `images` table rather than from the message log, so a picture is in the gallery
because it was generated for her, not because a bubble survived.

**One row, not a wrapping grid.** It started as a three-column grid, which was fine at three
or four photos and actively broken past that: the sheet has a trait list directly underneath
the gallery, and a grid that wraps into more rows as she sends more photos pushed that list
further down every time, eventually off the sheet's visible area entirely. `.gallery-grid`
(`web/src/styles.css`) is now a flex row with `overflow-x: auto` instead of a CSS grid, and
each `.gallery-thumb` gets a fixed width rather than relying on a grid column's `1fr` to size
it. The trait list's position underneath is now independent of how many photos she has sent -
verified in a real browser with eight seeded photos: the row scrolls (`scrollWidth` wider than
`clientWidth`), every thumbnail sits at the same vertical offset (one row, not several), and
the trait list renders directly below it exactly as before.

The one image it withholds is her **profile shot**, until `photos_exchanged` is set. That
flag is the whole point of the picture swap, and a gallery that quietly showed her face
before she agreed to show it would hand back exactly what the swap is there to gate. Chat
photos are unaffected — she already chose to send those.

**Tap any photo to open it full-screen.** The same viewer backs both surfaces, and it is
handed the whole set with an index rather than a single URL, so opening a chat bubble still
lets you page through the rest of her photos. Arrow keys and on-screen chevrons move,
`Escape` or a tap on the backdrop closes, and a tap on the image itself does nothing — a
photo you opened to look at should not vanish because you touched it. The page behind is
scroll-locked while it is up, or a swipe drags the conversation around underneath. The chat
bubbles and the gallery overlap (a photo she sent is in both), so the set is deduplicated
before it is paged, otherwise the same picture showed up twice in the counter.

### Her face before there is a photo

A match list where nobody has unlocked a photo yet is a column of identical grey initials,
and several characters share a first letter. So the generation pass also picks her an
**avatar emoji** — from her work, what she is into or where she lives, with the prompt
explicitly steering away from the default-romantic set, since ❤️🔥😍 on everyone solves
nothing. It shows wherever her avatar does until a real photo is unlocked, at which point
the photo takes over.

The model's choice is validated rather than trusted: asked for an emoji, a model will
sometimes answer `:)`, `U+1F98A` or `a fox`, so anything containing letters or digits, or
containing no pictographic character at all, is rejected. Rejected or missing, it falls back
to a stable pick from a curated pool, keyed off her **id** rather than her handle — handles
are not unique at the point the seed is written (the final one is settled during the insert),
so keying off the handle gave every character the same face whenever a model repeated a
username. Because that fallback resolves at read time, characters generated before any of
this existed get a distinct face too, with no migration.

It shows during swiping too, not only once matched — `/api/stack` was deliberately the one
endpoint that sent nothing but a handle and a bio ("no photos, no age, no filters"), and the
emoji does not break that: it is not a photo, it gives away nothing real about her, it only
makes the stack a run of distinguishable cards instead of identical ones.

### The attribute tables

`server/src/data/attributes/*.json`, 2409 entries across 50 categories, seeded into SQLite
on boot. The field that matters most is `prompt_hint` — the text that actually reaches the
model. Without it the Actor gets a bare label and reinvents its meaning every time.

**The non-fetish, non-domain tables went from 863 entries to 2211 (2.56x)** — the fetish
table was already judged to have enough variance and stayed at 183. Bios and handles have their own
variance guards already, described below — this pass is about the raw material feeding
them: an `archetype` roll used to come from 24 options, `insecurity` from 22, `occupation`
from 59. With five of these compounding into one seed, a cast that repeated felt inevitable
long before any single table looked small on its own.

Two categories were **deliberately left alone**. `fetish` (183 entries), per the brief.
`kink_domain` (15) is the taxonomy that groups those 183 fetishes and hands them to
`rollKinkMap()` — adding domains means either reassigning existing fetishes to them (which
touches the one table meant to stay untouched) or shipping domains with nothing in them,
which contribute nothing. Everything else is expanded, from the ~1.6x on the naturally
small, real-world-bounded tables (`orientation`, `height`, `attachment_style`) up to ~3x+ on
the ones that carry the most day-to-day texture (`occupation`, `interest`, `insecurity`,
`turn_on`/`turn_off`).

### Breast size joined body_type as a proper attribute

It used to be entirely absent from the seed - `body_type`'s `image_prompt` ("curvy hourglass
figure", "athletic toned build") was the only thing carrying any signal about it into an
image prompt, which meant it was never actually decided, just vaguely implied by whichever
body-type phrase happened to get drawn.

`breast_size` is now its own category in `appearance.json` (`flat` through `very_large`,
six entries, common sizes weighted heaviest), rolled right after `body_type` in the same
staged cascade so the two can lean on each other: several sizes carry `affinities` toward
the body types they naturally pair with (`full`/`large`/`very_large` toward `curvy`,
`hourglass`, `plus_size` and the like; `flat`/`small` toward `slim`, `athletic`, `petite`,
`lanky`) the same way any other pair of attributes nudges each other, not a hardcoded rule.
`average` carries no affinities - it is the one that fits everyone equally, same as a
population actually skews. The result folds into `appearance_prompt` right after
`body_type`, so every image prompt and the Actor's own self-knowledge (`appearanceBlock()`
starts from `appearance_prompt` too) carry it exactly the way they already carry hair colour
or height.

**Existing characters, generated before this existed, get one assigned automatically rather
than being left with a permanent gap.** `hydrateCharacter()` - the one function every
character load already goes through - checks for a missing `breast_size` and, if it finds
one, rolls it right there: a fresh `DiceContext` seeded with her actual `body_type`, `height`
and `ethnicity` so the same affinities that make a size "fit" a build during normal
generation apply to the backfill too, not a flat random pick. The result is written back to
the row immediately, so this only ever runs once per character - every load after the first
is a single cheap presence check. Verified against a mock: a freshly generated character
always has one baked into her `appearance_prompt`; a character seed with the field stripped
out (simulating a pre-existing save) gets one assigned and persisted on first load, and a
second load neither re-rolls it nor appends the phrase a second time.

### Some categories quietly gate real behaviour, not just prompt text

Auditing every table before writing new entries turned up several categories where an
attribute's **id** is checked directly in code, rather than its `prompt_hint` just being
handed to a model:

- `social_energy` scaled a character's proactivity (`nudge.ts`), her chance of texting first
  (`scheduler.ts`) and her photo demeanour (`images.ts`) through three separate `{ low, medium,
  high }` lookup tables — literal object keys. A fourth `social_energy` entry would have
  matched none of them and silently fallen back to a flat default, contributing nothing.
- `message_length`, `emoji_usage`, `voice_msg_tendency`, `slang_register`/`typing_style`
  (the "writes formally" check) and `openness_curve` had the same shape: two or three
  hardcoded ids doing real work, everything else inert.
- `humor_type`'s photo-demeanour check in `images.ts` compared against `['dry', 'deadpan',
  'dark']` and `['silly', 'goofy', 'playful']` — and neither `deadpan`, `silly` nor `goofy`
  has ever existed as a `humor_type` id. Both branches had been dead code since they were
  written; a pre-existing bug this pass happened to trip over.

Rather than ship dozens of new entries into categories where only a couple of ids actually
did anything, each of these now reads its behaviour from `extra` on the attribute row itself
(`extra.pace`, `extra.bucket`, `extra.chance`, `extra.demeanour`, and so on), with every
existing id's `extra` set to reproduce its exact old hardcoded value — checked by an
automated comparison against the original lookup tables before anything shipped, so no
existing character's behaviour moved. A new entry in any of these tables is now a real,
functioning option rather than fifteen new labels that all behave like "medium".

### What was verified before this shipped

- **Schema**: every one of the 2409 rows has all twelve required fields, a valid `rarity`,
  and a positive `weight`.
- **No duplicate `(category, id)` pairs**, old or new.
- **No dangling references** — every id named in an `affinities`, `conflicts` or
  `extra.weights` list, across all 2409 rows, resolves to a real attribute somewhere in the
  tables. This also caught and fixed 23 references that were already broken before this
  pass (an old `archetype` affinity pointing at `"gym"`, which has never been an id anywhere
  in the tables; `hard_limit` conflicts naming fetish ids that do not exist) — dead weight
  that quietly did nothing on every roll.
- **12,000 trials of `rollSeed()`**: zero errors, zero characters where a `hard_limit`
  contradicted one of her own `fetishes`, and — checked per category — every single new
  archetype, occupation, ethnicity, hobby, interest, humour type and openness curve was
  actually reachable at least once.

Every entry carries a **rarity**: common, uncommon, rare or very rare, which is the coarse
frequency dial (`weight` remains a manual nudge on top). This is how the niche material
earns its place — the fetish table runs to ~180 entries covering everything from dirty talk
to mummification, and the long tail only turns up when it should. Every one of the roughly
1350 new entries added in this pass was given a rarity by hand rather than left at the
`common` default, in roughly the same proportions the existing tables already used (common
the majority, tapering through uncommon and rare, very rare reserved for the genuinely
unusual). A **rarity** slider in Settings pulls the whole tail up or down together:

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

### A curated wishlist of fetishes, styles, jobs and hobbies

The user supplied a specific list of ~45 fetishes, ~25 aesthetic styles, ~40 occupations, a
handful of hobbies/interests and one quirk they wanted available, with a standing preference
attached: characters should be allowed to look and be more "unusual" and scene-specific
rather than converging on similar-looking, similarly-employed women — a goth character
should read as properly goth, not as a normal girl in slightly dark clothing.

Each item on the list was checked against the existing tables first rather than added blind
- about a third of it (`mutual_masturbation`, `nylon_fishnet` for fishnets, both directions
of `edging_*`, `threesome_fantasy`, `bondage_shibari`/`tying_him` for shibari, and several
more) already existed, sometimes under a less literal id. Only the genuine gaps were added:

- **30 new fetishes** in `sexual.json` — cum play (eating, being forced to eat his own,
  swapping, general fixation), footwear acts (sockjobs, shoejobs, boot licking), JOI both
  directions, a stronger degradation pair distinct from the existing "light teasing" one,
  pegging, petplay both directions, pantyhose/knee-highs, consensual non-consent, dark
  romance, an affair fantasy, strip games, giving breath play (only the receiving side
  existed), Daddy kink, free use, primal play, group sex, an explicit slave-treatment pair,
  and a cuckqueen fantasy distinct from the existing generic "watching him with another".
  Every new fetish was assigned into the `kink_domain` it actually belongs to (see below) -
  a fetish left unclaimed by any domain is available to everyone regardless of freak level,
  which is right for `hentai_together` (mild, unclaimed on purpose) and wrong for something
  like `primal_play`, which should stay gated the same way the rest of `bdsm_power` is.
- **One new `kink_domain`, `cum_play`** (intensity 1, the same tier as `bdsm_power` and
  `bondage`), plus a matching **`cum_limit` hard_limit** conflicting with its four fetishes -
  cum play didn't fit any of the existing 15 domains, and the domain-gating mechanism
  requires a home for anything that should be freak-conditioned rather than always-available.
  `discovery.ts`'s `DOMAIN_TERMS` also picked up a `cum_play` entry and a handful of added
  phrases in existing domains (`petplay`, `pegging`, `daddy`, `free use`, `primal`, `orgy`,
  `pantyhose`, and others) so the new kinks are actually detectable in chat, not just
  decorative.
- **23 new `clothing_style` entries** in `appearance.json` — e-girl, cosplayer, gamer girl,
  anime girl, a properly-committed goth (distinct from the existing softer `alt_goth`), emo,
  fantasy costume, alt, rave wear, lolita, punk, sundresses, and eleven of the "-core"
  aesthetic microtrends (angelcore, devilcore, barbiecore, clowncore, westerncore, craftcore,
  fairycore, fetishcore, goblincore, kidcore, lovecore). Cottagecore and balletcore were
  already in the tables under those exact names. Each got a genuinely committed
  `image_prompt` - "full traditional goth outfit, black lace and velvet, platform boots,
  dramatic silhouette", not a diluted "slightly dark clothing" version - since
  `image_prompt` is what actually reaches `buildAppearancePrompt()` and from there the image
  model; the distinctiveness the user wanted is a property of what these entries actually
  say, not a separate setting.
- **40 new `occupation` entries** in `life.json` — influencer/streamer/creator jobs,
  law enforcement and emergency services, several crime-adjacent ones (dealer, mobster,
  hitman, secret agent) written in the same matter-of-fact, non-glorifying tone as the
  existing `crime_scene_cleaner`/`bookie`/`private_investigator`, adult-industry work
  (sex worker, escort, OnlyFans model, stripper), creative/tech roles, and two openly
  supernatural ones (witch, vampire) - this app already allows a slight supernatural role,
  and the existing tables had none.
- **4 new `hobby` entries** (writing stories, vibe coding, sim racing, casual streaming),
  **1 new `interest`** (social media / extremely online), and **1 new `quirk`** in
  `personality.json`'s texting-tic pool - texting with a trace of her native language's word
  order, a real, non-costume version of an accent showing up in how she types rather than
  how she'd sound out loud.

**`server/scripts/validate-attributes.mjs`** (new, `npm run validate-attributes` from
`server/`) is the permanent version of the one-off script an earlier expansion pass used and
never committed. It checks every `.json` file in `data/attributes/`: no duplicate
`(category, id)` pairs, every required field present with the right type, every `rarity`
valid, and no dangling reference in any `affinities`, `conflicts`, `extra.weights`, or
`kink_domain.extra.fetishes`/`.limits` list — a category this pass's own additions had to
pass cleanly before shipping, and something future expansions can now run instead of
re-deriving the same checks from scratch.

Verified: the validator passes clean across all 2516 entries (51 categories, 5 files) with
zero errors; 400 real `rollSeed()` calls through the actual generation code complete with no
error and produce characters using the new styles, occupations, hobbies/interests, the new
quirk, and the new fetishes; a character rolled with the new `goth_girl` style carries the
new, vivid `image_prompt` text all the way through to her `appearance_prompt`; and the new
`cum_play` domain and its `cum_limit` hard_limit resolve correctly through `find()`.

---

## Settings

Model endpoints, keys and sampling per role · a global activity multiplier for
proactivity and wakeup frequency (start low) · the server uptime window · a daily call and
cost budget with a usage readout · searchable logs filtered by scope, where every LLM call
is stored with its full prompt, response, duration and token counts, and can be exported as
Markdown · a separate image log with a per-job retry button · your own profile · a reset.

The log view is the main tuning tool. Use it.

### Getting the logs out

Reading a bad turn in the pane is one thing; asking someone about it is another, and the
pane cannot be pasted. **Copy for pasting** and **Download** render the same logs as
Markdown, ready to drop into a chat window.

The export follows whatever the filters are already showing — pick the `actor` scope, search
for her handle, and that is what you get — with two controls of its own: how many entries
(20, 60, 200, or everything still kept), and how much of each prompt. **Full prompts** is the
default because a prompt problem is rarely visible from the reply alone; **trimmed** caps each
message at 800 characters when the system block is drowning everything else; **replies only**
keeps the responses, timings and token counts and drops the prompts entirely.

Two differences from the pane, both deliberate. The export runs **oldest first** — a pane is a
feed you scan downwards, an export is a narrative you read forwards, and a conversation makes
no sense backwards. And a prompt is rendered as **one section per message**, headed by its
role, with the content printed as written. Dumped as raw JSON it arrives as escape soup, `\n`
between every line and the whole system block one unbroken string, which is precisely the part
that needs reading.

Each entry carries its call's vitals — model, duration, tokens in and out — and the header
carries both models with their sampling, the image model, and the tuning sliders, because a
prompt problem is usually a settings problem and the answer is otherwise a round of
questions. **No API key is in the file**: the header is built from named fields and the
credentials are not among them. What *is* in there is every prompt, which means everything
you have told these characters about yourself. The pane says so next to the buttons.

Expanding a single entry also gives it a **Copy this entry** button. One bad turn is usually
the whole question, and pasting the fifty-nine around it only buries it.

The clipboard needs a secure context, which `http://<the box on your LAN>:8080` is not — so
that path falls back to the older copy mechanism, and if that is refused too the export
downloads instead of failing silently.

### Resetting

The reset is four independent switches rather than one button, because "start the cast
over" and "forget who I am" are different wishes:

| Part | What goes |
|---|---|
| Everyone and every chat | Characters, conversations, stats, ledgers, wakeups, dates, generated images, then a fresh stack |
| Your own profile | Your name, age, bio and the photos you uploaded |
| API keys and settings | Keys, base URLs, model choices, every tuning slider |
| The debug log | Everything under Logs |

Anything left off survives untouched, and nothing is wiped that was not named — an omitted
part is a part that stays. The default is the common case: new cast, same you, same keys.
Your daily usage and spend counter is never reset by any of it, since it records money
actually spent rather than game state.

The subtle part is the media: `data/images/` is generated *for* characters and goes with
the world, while `data/uploads/` is the photos on *your* profile and goes with the profile.
Wiping both together, as the old single-button reset did, would leave a kept profile
pointing at dead thumbnails.

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
  components/Icon    the icon set, as inline SVG
  styles.css         design tokens first, component rules second
```

All characters are adults; `age` has a hard minimum of 18 and is validated at generation.
Single user, no auth, no moderation, not meant to be exposed to the internet.

### The design system

`styles.css` opens with the tokens — surfaces, text, one accent hue in five jobs, a 4px
spacing scale, four radii, three elevations, two easing curves — and every component rule
below picks from them. The rule is that a component never invents a one-off value, because
a stylesheet of ad-hoc 13px paddings and 21px radii is exactly what makes an interface read
as assembled rather than designed.

A few things carry most of the difference from the first pass:

- **No emoji.** Tab bars, buttons and affordances used 🔥 💬 ⚙️ ⋯ ＋ ↻ ◔. Emoji render as a
  different typeface on every platform, sit on their own baseline and cannot take the accent
  colour. They are inline SVG now (`components/Icon.tsx`), on one 24px grid at one stroke
  weight, inheriting `currentColor`.
- **Materials.** The header, tab bar and composer are translucent with `backdrop-filter`
  blur, so content passes under them instead of hitting a flat bar. Raised surfaces get a
  shadow *and* a hairline top edge, which is what actually reads as depth on a dark UI.
- **Bottom-anchored chat.** A short conversation sits on the bottom edge like every
  messenger, via an inner wrapper with `min-height: 100%` and `justify-content: flex-end`.
- **`alert()` and `confirm()` are gone.** A failed send now raises a toast above the
  composer and puts the draft back in the box; blocking someone asks inside the card. Both
  were browser dialogs before, which stop the app dead and look like an error page.
- **Autoscroll that lets go.** The log only follows the conversation down when you are
  already at the bottom. Scrolling back through history used to be impossible — the
  three-second poll yanked you to the newest message every time — and a jump-to-latest
  button appears instead.
- **Keyboard and pointer both work.** `:focus-visible` rings everywhere, arrow keys decide a
  swipe on desktop where there is nothing to drag, 44px minimum tap targets, and
  `prefers-reduced-motion` turns the animation off rather than down.
- **Loading looks like arriving.** Skeletons on the swipe card instead of the word "Loading".

Verified by driving the built app in Chromium at 412×900 with Playwright: every screen
screenshotted, the swipe drag exercised with real `TouchEvent`s (the verdict stamp fades in
proportionally and sits on the side the card is leaving, so it stays on screen), the
composer re-checked at a 420px-tall viewport to confirm the keyboard fix below still holds,
and desktop width checked at 1100px. No console errors on any screen.

On Chrome for Android, the on-screen keyboard does not shrink the layout viewport by
default - only the visual one - so anything sized with a plain `height: 100%`/`100vh`
(the whole app shell, the chat column) keeps its keyboard-closed height, and the keyboard
just overlays the bottom of it, covering the composer. Fixed with `100dvh` (with `100%` as
the fallback for browsers that don't support it) on `html, body, #root` in `styles.css`,
plus `interactive-widget=resizes-content` in the viewport meta tag in `index.html`, which
also gets `.app`'s and `.chat`'s existing `height: 100%` chain to shrink correctly since it
percentages down from a now-correctly-sized root.
