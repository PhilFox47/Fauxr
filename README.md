# Fauxr

A self-hosted, single-user adult fantasy playground dressed as a hookup app. You swipe,
match and chat with generated women who are into you, and explore sexual fantasies with
them - theirs as much as yours.

There is nothing to win. Nobody has to be won over, tested or unlocked. Every character
matched with you because she wants you; what differs is how she goes about it. Some are all
in from the first message, some love a slow, teasing build. They drive as much as you do:
they pitch their own fantasies, ask what you are into, send photos when they feel like it,
and take things where they want them to go.

Characters are generated, not written, each with her own personality, texting voice, kinks,
hard limits and a handful of concrete fantasies she wants to play out. Finding out what she
is into - and her finding out what you are into - is the one thing that is actually
discovered over time.

Everyone in it is an adult (`age` has a hard minimum of 18, validated at generation). Each
character's hard limits are real and hold whatever the mood; everything else is on the table.

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

### Always reachable

Characters answer whenever you write, at any hour. There are no online windows, no "I'm
heading off" absences and no server uptime window any more. On every start a catch-up job
spreads out any overdue wakeups and decays arousal for the time the server was off.

### A password, optionally

Set `FAUXR_PASSWORD` in `.env` (or the environment directly) and the app asks for it before
showing anything — leave it unset, the default, and nothing changes from before this existed.
There is no database row for it and no way to set it from the Settings page on purpose: it is
meant to live only in the environment, the one place that never gets swept up in an export or
a reset.

The check is a plain password, compared in constant time so a wrong guess cannot be timed
character by character, behind a signed, `HttpOnly` cookie holding nothing but an expiry -
never the password itself, and never readable from the page's own JavaScript. **Remember me**
on the login screen is the entire difference between the two lifetimes a session can have:
checked, the cookie carries its own 14-day `Max-Age` and survives the browser closing;
unchecked, it carries none, so the browser drops it the moment it actually closes, with a
24-hour expiry baked into the token itself as the backstop for a browser that keeps tabs
around longer than that anyway. The API, the generated/uploaded media under `/media`, and the
live event socket are all gated the same way; the built frontend shell (its HTML, JS and CSS)
is deliberately left reachable with no session, since otherwise there would be nothing left to
render the login screen with — it carries no data of its own until the API actually answers
something. An **Account** card at the top of **Settings → Reset** logs out, and only appears
at all when a password is actually set.

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

## The rebuild: a playground, not a game

Fauxr started as a dating *game*: characters had trust, spark and investment scores, things
were locked behind them, she judged what you said against a hidden "touchstone", and she
could cool off, ghost you or block you. Every recurring complaint about how it felt - tame,
reactive, judgmental, keeping score, setting tests, making you do all the work - traced back
to that frame, and the prompts had grown to 11-14k tokens of rules fighting it.

The rebuild keeps the parts that made characters feel like people and removes the game:

| Kept | Removed |
|---|---|
| Her texting voice, her life, her quirks, what she is wearing and doing | Trust, spark, investment, reciprocity and pressure |
| Arousal (how turned on she is right now, fades over hours) | Relationship stages and "unlocks" |
| Her memory of you: the ledger, what landed, open threads | Touchstone judging and dealbreakers |
| Kink discovery, both ways | Cooling off, ghosting, and her blocking you |
| Her hard limits | Online windows, absences, the uptime window |
| Dates | The photo consent card (the profile-picture swap is back, as a plain button) |
| | Trait credits and "uncover a trait" |

What was added:

- **Per-character pace.** `describePace()` (engine/stage.ts) turns her libido, sexting
  readiness, sexual confidence and archetype pace into one of four tastes, from "all in from
  the start" to "a slow burn". It describes how she likes it, never a gate.
- **Her fantasies.** The character generator now writes 3-5 concrete sexual scenarios per
  character from her kinks and personality (`seed.hints.fantasies`). Characters made before
  this get theirs written lazily, the first time the Director runs for them
  (`ensureFantasies()`). The Director, the Actor and dates all see them, and a
  `pitch_fantasy` nudge has her pitch one - set the scene, say what she wants, ask if he is in.
- **Photos start with a swap.** Image generation is expensive, so nothing is generated for a
  character until you press the camera button in her chat to swap profile pictures. Until then
  she is an emoji to you and you are one to her, and she cannot send photos (she can tease you
  about it). The swap generates her profile picture and lets her see yours, and she reacts to
  it. From then on, when she decides to send a photo it is generated straight away with no
  consent card, using her profile picture as the reference for her face. Characters whose
  picture was already generated count as swapped.
- **She sees what you send.** A photo you upload is described by the vision model before she
  replies, and the description goes into the conversation history, so her answer is about
  what is actually in it.

Existing saves carry over. A one-time migration un-blocks anyone who had blocked you and
clears ghosting; old stat columns stay in the database but nothing reads them; old consent
and swap cards remain in chat history as plain, unclickable lines.

Much of the history below this section describes the old design - trust/spark scoring,
unlocks, consent cards, the swap, ghosting, trait credits, online schedules. That code is
gone; those sections are kept as a record of how the app got here.

## Who she is in bed

Characters used to vary a lot in who they were and very little in how they were sexual:
sixty archetypes and two hundred jobs, but only four numbers (libido, confidence, dom/sub,
sexting readiness) for the part the app is actually about. Two women with similar numbers
flirted and sexted the same way.

**Sexual personas.** Every character now rolls one of 94 named personas
(`sexual_persona` in `sexual.json`). Together they cover the range from protocol mistress
to obedient sub, from insatiable to rare-but-intense, from romantic to primal to deadpan, from
eager beginner to seasoned, plus specific focuses (scenario player, exhibitionist, rope bunny,
toy enthusiast, dirty-talk artist, smut reader, voyeur and more). Each persona:

- has a prompt hint that says how she flirts, starts things, sexts and what she wants;
- sets the ranges her sexual stats are drawn from (replacing the archetype's for those four);
- leans her kink map (`kink_bias`), her fetishes, her dirty talk and her signature move;
- can carry its own pace (for "all in" versus "slow burn") and initiative (how often she
  starts things).

It is leaned by her everyday archetype, through `affinities`, but not decided by it: a quiet
archivist can still roll a commanding domme, and the dossier is told to make that contrast
land. Across 2,000 rolls every persona appears and none takes more than about 3%.

**New sexual tables, replacing the dead game ones.** The game's leftover tables are retired:
touchstone, dealbreaker, green flags, insecurity, attachment and conflict style, openness
curve, relationship history and dating experience. `search_motive` is rewritten as what she
is on the app for, sexually ("exploring a kink", "bored of vanilla", "wants to let go"). Four
tables are new:

- `dirty_talk`: how she talks dirty (24 styles);
- `sexual_experience`: from eager beginner to kink-scene regular;
- `body_pride`: what she is proudest of and wants noticed;
- `signature_move`: the thing she keeps coming back to.

All of these appear in her sexual block, are discoverable on her profile, and feed the dossier
and her fantasies. Existing characters get a persona on first load, picked from the personas
that fit the dom/sub leaning and libido they already have, and the other fields are filled in
the same way. Retired tables are deleted from existing databases on upgrade. The asset copy
step now also clears `dist/data` first: a stale `signature.json` from an attribute removed
long ago had been getting seeded into fresh databases.

## Her fantasies, pitched and played naturally

Fantasies have no mode or button of their own. She pitches them in the chat, and the two of
you play them out there over text or on a date, the same way anything else happens.

- The Actor reports which fantasy she pitched (`fantasy_pitched`, by its number in her list)
  or a brand-new one she made up (`new_fantasy`). A new one joins her list for good, capped at
  12, with near-duplicates dropped.
- The Director (for texting) and the date summary (for dates) report which fantasies were
  actually acted out (`fantasies_played`).
- `rel.mood.fantasy_log` records both: pitched, played, and how many times. Her prompt marks
  the ones he has already heard and the ones they have already done, so she builds on them
  rather than repeating them.
- Her profile sheet lists the fantasies she has told him about, how often they have done each,
  and a count of the ones she has not shared yet. It is read-only.

(A "Play it out" button that turned a fantasy into a separate scene mode existed briefly. It
was taken out for being intrusive. Any cards it left in a chat's history are hidden.)

## She replies; she does not text first (by default)

**Settings → Behaviour → "Characters can text first"** is off by default. With it off, a
character only writes when you have written, apart from her one opening message after a match.
Follow-ups after a silence, check-ins, anniversary messages and the wakeups the Director
schedules are all switched off. The Director is told to leave `wakeup` null, and anything
already scheduled is dropped on the next tick. The only other wakeup that still runs is the
safety net that answers a message of yours that somehow went unanswered.

## A direction never outlives the moment it was written for

A real log had Hana ignore a reply and talk about her dinner instead, four times in a row,
three of them regenerations. The cause was not the model or its sampling. While he was quiet, a
check-in had the Director write "no third nudge - talk about your evening, zero mention of the
scene". When he replied two hours later that direction was still valid, so she followed it.

Now:

- A direction written for a moment she acted on her own (her opener, a check-in) expires as
  soon as he writes.
- Any direction expires if he replies more than 30 minutes after it was written.
- Regenerating a reply refreshes an outdated direction before rewriting, instead of rerolling
  the same wrong plan.
- Both prompts say it outright: the direction never means ignoring his newest message.

## Keeping characters distinct

Every character reads the same profile of you, so anything generic in her prompt comes out
identical across the cast. A real log showed four characters opening with "so ur a switch"
(from the bio) and all asking the same questions ("take charge or be told?", "what would you
do to me first?"). Fixes:

- Her curiosity about you is per character: one question tied to her own kinks plus one
  generic topic, shuffled with a stable per-character order. It is marked low priority; she
  mostly finds things out by noticing.
- The Director is told to build every goal from what is specific to her, never to open by
  quoting a label from your bio, and to vary the kind of move (tell, confess, describe, order,
  tease) instead of quizzing you.
- The Actor no longer has a generic "lowercase, u, tbh" texting default that overrode each
  character's own typing style. She types exactly as her own style block says.
- The flirt and escalate nudges use her persona, dirty-talk style, signature move and body
  pride.
- Word-for-word repeats of her own lines, or duplicates inside one turn, are rejected on the
  first attempt and dropped after that. The older overlap check ignored anything under three
  words, which is how "i have a list 📝" could loop.

## Who shows up: ethnicity weighting

The cast leans towards the owner's taste: mostly European and East Asian women, with
everything else still possible but rarer. Ethnicity is set in three tiers through each row's
`weight` in `appearance.json` (not its rarity tag, so the Rarity dial still does its own job on
everything else):

| tier | ethnicities | weight | share of the cast |
|---|---|---|---|
| most common | German, English, American, Japanese | 6.0 | ~35%, ~9% each |
| common | Dutch, Swedish, Korean, Chinese, Australian, Scottish, Irish, Spanish, Italian, Polish, Canadian, Croatian | 2.2 | ~39% |
| everything else | the other ~95, from Brazilian to Nigerian to Uzbek | 0.5 | ~26%, none above ~1% |

English, American, Swedish, Australian, Spanish, Canadian and Croatian were added for this.
Looks follow ethnicity: skin tones, hair colours and eye colours list broad groups
(`white_european`, `east_asian`, ...) in their affinities and conflicts, and each specific
ethnicity now inherits its group's links, so an English character gets fair to tanned skin
rather than any tone at random. The newer looks (`rosy_fair`, `mahogany`, `icy_blonde`,
`sea_green`, ...) copy the links of the closest older tone.

Two traps showed up along the way:

- Some ids are both a language and an ethnicity. The new ones are suffixed (`swedish_ethnic`,
  `spanish_ethnic`, `croatian_ethnic`, like the older `czech_ethnic`); `japanese`, `korean` and
  `turkish` stay as they are because existing characters store them.
- Languages used to be rolled before looks, so a language in the drawn set could veto a look
  by conflict. A Nigerian woman who spoke Swedish had every skin tone excluded and generation
  crashed. Languages are now rolled after looks. The validator also fails any ethnicity that
  leaves no skin tone, hair colour, hair style or eye colour open.

## Fewer vanilla characters

This is a playground, not a census, so the tables lean away from realism and towards
characters worth talking to: alt and OnlyFans-style looks, a real named kink, more women who
take charge. Nothing was taken off the table; the soft, plain end of every table is still
there, it just no longer fills the middle. Only new characters are affected.

Measured over 4000 rolled characters, before and after:

| | before | after |
|---|---|---|
| alt / OnlyFans styles (goth, e-girl, emo, alt, punk, gamer, cosplay, ...) | 24% | 52% |
| dominant-leaning (dom/sub >= 1) | 35% | 48% |
| submissive-leaning | 43% | 36% |
| tattooed / two or more tattoos | 49% / 22% | 67% / 35% |
| two or more piercings | 33% | 49% |
| dyed or bleached hair | 18% | 27% |
| named fetishes that are actual kinks (from a kink domain) | 38% | 72% |
| characters with no real kink among their fetishes | 26% | 0% |

What changed:

- **Every table was re-tiered**, by setting `rarity` and `weight` per row (the script is
  idempotent and asserts every id). Up: alt and glam clothing, liner and bold lips, dyed hair
  and deliberate cuts, curvier figures, striking features, alt tattoo motifs on the hips,
  ribs, thighs and lower back, septum/navel/nipple/tongue piercings, bold archetypes
  (provocateur, flirty, menace), bartenders, tattoo artists, streamers, models and trainers,
  pole and burlesque, horror and tarot, open and poly relationships, experienced women, bi
  women, and a hidden secret for about one in three instead of one in six. Down, to uncommon
  or rare: beige basics, bare faces, "cold hands" features, compass and bicycle tattoos,
  office jobs, competitive lawn bowls, and the timid archetypes.
- **New rows:** baddie, bimbo glam, pin-up and gym girl styles; fishnets, thigh-highs,
  platform boots, an O-ring choker and cat-ear headphones; pole dancing and burlesque; and
  fourteen explicit turn-ons (being obeyed, being worshipped, a man on his knees, being
  pinned, being called a good girl, filthy texts, ...). The turn-ons used to read like a
  dating profile ("someone who cooks for her"); those are rare now, and "dominance that is
  earned" is very rare, since earning is exactly what this app removed. Kidcore was removed
  outright: it has no place next to sexual content.
- **Looks pull their own look along.** Alt styles carry `extra.weights` towards black or
  vivid dyed hair, liner, chokers, fishnets and platform boots, and a new `extra.adds`
  (`{ tattoos, piercings }`, read in `rollSeed`) gives them more ink and metal: each whole
  unit is one more, the fraction a chance of one more. Sexual personas list matching styles as
  affinities, so a goth leans towards the domme, the latex fetishist and the alt girl.
- **Personas lean dominant and distinctive.** The dom personas lead, the kink-specific ones
  (foot-focused, exhibitionist, rope bunny, latex) are common, and the soft middle
  (lazy-morning lover, giggly goofball, cuddly and horny) is uncommon at a lower weight.
- **Every character has a signature kink.** Her first fetish is drawn only from a domain she
  is into. Drawn from the whole allowed set, a quarter of the cast had only soft entries
  ("cuddling after", "eye contact") despite a kink map full of yeses, which is what read as
  vanilla. The soft entries are also uncommon now.

## Your taste, and who she is underneath

**Settings → Taste** is where the cast gets tuned to you, without touching the tables. Every
style, build, breast and butt size, hair, makeup, accessory, persona, kink, lingerie style,
dirty-talk style, fantasy idea, personality, texting voice, job and relationship status has
Never / Less / More, plus a dominant-or-submissive lean for the whole cast. The pane has a
search box ("goth", "feet", "bartender").

- It is stored as `settings.taste`, keyed `category/id` (ids are only unique per category),
  and applied in `roll()` as one more multiplier: More ×3, Less ×0.3, Never ×0. It sits on top
  of everything, including the deliberately surprising `ignoreArchetype` rolls.
- Kink domains are not rolled by `roll()`; `rollDomainStance()` in `engine/kinks.ts` turns the
  multiplier into reach (log2, so More is about +1.6) and Never into "not for her".
- `lean/dom_sub` (-1..1) weights each persona by the middle of its dom/sub range.
- It only affects characters generated after you save; the few already waiting in the stack
  and everyone you have matched stay as they are. Measured over 3000 rolls: More on goth took
  goths from 5% to 13%, Never on feet took "into feet" from 55% to 0%, and "Mostly dominant"
  took dominant-leaning characters from 48% to 69%.

**Ages lean young.** Every age up to 27 inside your preferred range is equally likely, and each
year after that is less likely than the one before (`rollAge`, four-year decay). With the
default 18-42 band, 74% of the cast is 18-27; it was about 30%.

**Persona first, then the kinks.** Turn-ons used to be rolled before her sexual persona, blind
to it: 27% of strong dommes were turned on by "being pinned" and 19% of strong subs by "a man
on his knees". They are rolled after the persona now, with its weights, and rows coded
dominant or submissive (`extra.dom_sub`, read by `domSubLean()`) lean with her dom/sub
leaning: 9% and 8% now, and switches still get both. Her fetishes follow the same leaning,
since the power-exchange domains hold both sides.

**Six new kink domains**, so the acts that were missing get a stance, a hard no and a place
in discovery: oral (going down on him and her, face-sitting, 69 - thirteen explicit fetishes
no domain used to own), instruction and JOI, tease and denial, watching, primal and rough, and
sensation play. They come with sixteen new fetishes and an oral hard limit, personas lean
them (`kink_bias`), and existing characters get a stance on each on first load: "into" if she
already has one of its fetishes, otherwise rolled from her freak level and persona. They
appear in your own kink profile automatically.

**New fields for sexting:** her butt (`butt_size`, also in her appearance prompt), what she
wears underneath (`lingerie_style`: black lace, harness sets, latex, corsets and garters,
character lingerie, nothing at all, ...), what she sleeps in (`sleepwear`) and how she keeps
herself (`intimate_grooming`). Lingerie and sleepwear lean with her style and persona (a
latex fetishist, a goth's harness set, a cosplayer's bunny set). The three intimate ones go
to her prompt and discovery, never to the fixed image prompt. Existing characters get them
on first load.

**Fantasies: a few ideas, a few of her own.** A new `fantasy_scenario` table holds 72 scenario
ideas (a hotel-bar stranger, a remote toy at dinner, tied and teased, a private cam show, a
sleeper train, ...), each tagged with the kink domains it touches. Three are rolled per
character, leaned towards domains she is into, never touching one she is a hard no on, and
following her dom/sub leaning. The character pass turns two or three of them into hers,
with the setting, roles and details changed, and invents two or three more itself. Written
all from one prompt, fantasies drift to the same few across the cast; written only from the
table, they would all be recognisable.

**Her style shapes the person, not just the look.** Clothing style is now rolled right after
her archetype instead of with her looks, so its `extra.weights` reach her texting voice and
her job as well as her interests and her hair and makeup. Goths are about twice as likely to
text deadpan and be into horror, and 3.6 times as likely to be tattoo artists; e-girls lean
towards streaming, gym girls towards personal training, baddies towards influencing.

## Photos that fit a hookup app

The photo prompts were written for a generic dating app: her lead photo was asked to be a
professional headshot, a repurposed work photo or a friend's candid, and every photo prompt
knew her only from her dossier. Seedream 5.0 Lite handles NSFW well and rarely refuses, so
they now aim at what Fauxr is.

- **Her body and her photo habits reach every photo prompt.** `photoSelfBlock()` in
  `images.ts` hands the profile-picture, photo-idea and date-outfit prompts her look, her
  figure (build, breasts, butt), her style, what she is proudest of, what she wears
  underneath, her ink and her persona, plus where a woman with her style takes her pictures:
  a new `extra.photo_scene` on thirty clothing styles (an e-girl's LED-lit room with a ring
  light, a goth's candles and black sheets, a gym girl's mirror between sets). The assembler
  gets the scene too, for her own photos.
- **Profile pictures are a hookup app's lead photo**: mirror selfies in something tight,
  over-the-shoulder shots, bikinis, night-out photos, boudoir shoots, chosen to show off
  what she is proudest of. How far hers goes comes from her own seed (`profileHeat()`,
  `PROFILE_LEVELS`), and a level sets the whole photo - what she shows, what the picture is
  about, how she poses and the look she gives the lens - because clothing alone left every
  level falling back on the same standing mirror selfie with more or less fabric:
  - **Teasing** (about half the cast): mostly covered, the point is what peeks out; an
    everyday moment with an edge (in bed in the morning, a close-up); half covered, legs
    tucked up; a look that suggests more than it shows - shy or knowing, whichever she is.
  - **Flirty** (about 40%): tight, short or low-cut, a bikini at most; her out looking good (a
    night out, the gym mirror, a pool); angled to show her shape; a smirk that holds.
  - **Bold** (about 6%): lingerie, a bikini, wet or sheer fabric, or an arm across a bare
    chest; openly about her body (across her bed, the shower doorway); posed to show it; a
    direct, heavy-lidded look.
  The profile picture is the first image of her anyone sees and stays on her profile, so it
  is never naked at any level: nipples stay covered and the area between her legs stays out
  of view. It leans teasing on purpose; only the real show-offs (an exhibitionist persona, a
  show-off personality) never lead with a tease.

  **Her chat photos have their own, bolder scale** (`chatPhotoLevel()` in
  `engine/photolevel.ts`, same score, different thresholds): about half bold (topless and
  fully naked are normal once it turns sexual), 40% flirty (lingerie and underwear first),
  a tenth teasing (hints first, more when he asks). It reaches the Actor's sexual block and
  the photo-idea prompt as "how far your photos to him usually go" - a baseline, not a cap -
  and in the chat a dominant woman never sends coy photos. Only the area between her legs
  stays out of view there, since that is what Seedream renders badly.

  Whatever the level, a profile picture is framed on her face and upper body (head and
  shoulders, chest up or waist up, never full-length or from behind) with her face sharp, lit
  and unobstructed - no phone, hair, hand, sunglasses or shadow across it. It is the identity
  reference every later photo of her is matched to, and a face half behind a phone in a
  full-length mirror shot is a poor one. Angle, light, mood and a glance away stay free; the
  assembler reframes an account that breaks the rule rather than dropping it, and the level
  and attitude texts no longer suggest shots that would (ass to the camera, a hand over her
  face).

  The level and the photo's attitude follow who she is, so they never contradict her:
  - `profileLevel()` scores her confidence and how far she goes plus `extra.photo_boldness`
    on her persona, archetype and style (an exhibitionist or a domme +1.5 to +2, a romantic
    -1, a shy archetype -1.5). Then three rules: a dominant woman (dom/sub >= 2), a show-off
    persona or a bold archetype never leads coy; a shy woman with a soft persona never leads
    topless; and a persona can set a floor (`extra.photo_level_min`) - "shy but filthy" came
    out teasing four times in five on her shyness alone, and her whole point is showing more
    than she seems to. Over 4000 characters: commanding dommes 94% bold and never teasing,
    exhibitionists 99% bold, romantic lovers mostly teasing.
  - `photoManner()` sets where the camera sits and what she does with it, in every photo
    prompt (profile, photo idea, date outfit): a dominant woman has the camera low and looks
    down into it, standing over it or sitting back with her legs apart, never kneeling; a
    submissive one has it above her, kneeling or lying back and looking up. A camera-shy
    archetype keeps a glance away even when she shows a lot; a show-off holds the lens. The
    level lists used to say "kneeling on the bed" and "a shy smile" to everyone.
- **Spicy photos are posed on purpose.** They used to share the snapshot rules - "unposed",
  "no posed styling", and the deliberately unflattering light pool (green strip lights, a
  pushed sensor) - which pulled the hottest shots back towards accidents. They now have their
  own assembler section, `SPICY_SUFFIX`/`SPICY_NEGATIVE`, a light pool of what she would
  actually use (ring light, LED strips, a bedside lamp, a flash in the mirror, blinds) and
  only mild capture flaws. Anything goes up to full nudity, rendered frankly (flushed skin,
  parted lips, hard nipples), except the one area Seedream renders badly: right between her
  legs stays out of view through underwear, thighs, a hand, a sheet, the angle or the crop -
  still never named in the prompt, since naming it triggers refusals.
- **Date outfits are chosen to be taken home in**: short, tight, low-cut, sheer, a slit, in
  her own style and fitted to the venue. The arrival photo lingers on her the way his eyes
  would, and the look on her face is for him.
- The Actor's own photo guidance (`actor_chat.md`) and the regenerate-with-a-new-idea prompt
  follow the same heat ladder: lingerie, topless, fully naked, a hand in her underwear, bent
  over, on her knees looking up.

## Her photos are prepared, not rendered, until you tap "Show photo"

A character sends as many photos as she likes - nothing about when or how often she sends
one is limited - but none of them costs an image generation until you choose to see it.

- When she sends one (`sendPhoto` in `images.ts`), everything up to the image model runs: her
  idea, the assembled prompt with its suffix and negative prompt, and a one-sentence caption
  the assembler writes alongside it (`caption` in its JSON). They are stored on the job
  (`images.prompt`, `negative_prompt`, `caption`; status `pending`) and a placeholder bubble
  goes into the chat: a camera tile, the caption and a "Show photo" button.
- "Show photo" (`POST /api/images/:id/show`, `showPhoto`) renders exactly the prompt built
  when she sent it, marks the bubble as developing, and fills in the same bubble when the
  image lands - no second message. A failed render leaves the placeholder with a note and the
  button, so it can be tried again. Her profile picture, if it does not exist yet, is made at
  that point too, so the photo can match her face.
- Later prompts still read what she sent from the message's `description`, whether or not
  you opened it. Regenerating works on a photo once it has been shown.
- Her profile picture (behind the swap button) and a date's arrival photo still render
  straight away; both are already your own action.

`runImageJob` is now the two halves in a row - `assembleImageJob` then `renderImageJob` - for
the paths that render at once.

**Frames are fixed by kind** (`IMAGE_SIZE`, `sizeFor()` in `images.ts`): a profile picture is
always square (2048x2048) - the main photo slot and the identity reference; a date's arrival
photo is always 2:3 portrait (2048x3072), since it shows her whole outfit; a photo she sends in
the chat is her call between square (a close selfie or a detail), 2:3 portrait (a mirror or
outfit shot) and 3:2 landscape (a view or a room). The kind wins over whatever aspect a job
was handed, and the chat placeholder takes the photo's frame before it is opened.

## Handles and bios lead with her look, attitude and sexuality

Handles and bios kept identifying a character by her job or her flat ("nightshiftnurse", "my
flatmate's cat has opinions"). Both were written from the dossier alone, where job and home are
the most concrete, easiest-to-quote facts, and the bio prompt's own examples ("my flatmate's
cat", "i get off work at 11ish") and its framing (a general dating app, "roughly how she spends
her time", everything sexual kept for after the match) pointed straight at them.

- `profileLeadBlock()` gives both prompts, next to the dossier, a "lead with these" list from
  her seed - her style, her look, what she is proudest of, her personality and humour, who she
  is in bed, how she talks dirty, one real kink, why she is on here - and her job and home
  separately, as background only.
- The handle prompt steers to her look, vibe or sexuality (an aesthetic, a colour, an
  attitude, a wink at her kink), and a handle containing a word from her own occupation or
  living-situation label is re-asked (`lifeWords()`).
- The bio prompt frames Fauxr as the adult hookup app it is, uses style and sexuality examples,
  and lets the bio tease one thing about her in bed in her own voice; the full list and her
  fantasies still wait for the match. Job and home are a passing detail at most.
- The dossier's "invent specifics" examples and the avatar-emoji guidance no longer point at
  her job either (a goth picks a bat or a dead rose, not a coffee cup for her night shifts).

## Making the chat feel alive

**Her status.** Every active match has a WhatsApp-style status - "gym then pizza, dont judge 🍕" -
shown under her name in the chat and next to it in the chat list (`engine/status.ts`). It lasts
4 to 12 hours, drawn per status, then a new one replaces it. It is cheap on purpose: one small
call per match per status (a few hundred tokens of task on the Director model), at most one
refresh per scheduler tick so a long list never fires a burst, and only for matched characters -
blocked and deleted ones never get one. It runs whether or not unprompted messages are on,
since it is not her texting him. The status also becomes her real situation (location, activity,
outfit in `rel.mood`), and her prompt knows he can see it, so her replies and her status agree.

**Reactions.** She can tap one emoji on his message (`hidden.react`), shown as a badge on his
bubble. No reaction is the default: she is told to react only when a message really landed,
anything that is not a single emoji is dropped, and code caps it at one reaction per four of his
messages, because "only when it matters" in a prompt drifts towards "most turns".

**"Your move".** The spark button in the composer (shown while the box is empty) makes her text
first, right now - the manual version of an unprompted message (`POST /api/chats/:id/your-move`,
trigger `initiative`). The Director runs with "she wants to text him right now - her own
impulse", and the Actor gets `initiativeNudge()`: she is texting because she feels like it, he
has not written anything new, and she must never say or imply he asked. What she comes with is
hers, weighted by the moment: a fantasy, a photo out of nowhere, picking things back up if it was
hot, a game, or something from right now (her status). Voice notes are skipped for these turns.

**Games.** A `chat_game` table of 30 games she can start - truth or dare, a dare chain, yes/no/
maybe, strip quiz, photo dare, rules for tonight, make me beg, the countdown, do what I do, and
more - each with how she runs it, a dom/sub coding, the kink domains it touches and a heat
level. Every character has four of her own (`rollChatGames()`, leaned by her persona, her kinks
and her dom/sub leaning, never one touching a hard no; existing characters get theirs on first
load). `gameNudge()` enforces the two things a prompt cannot: at most one game every 20 hours,
and no game she has played while her list still has unplayed ones, nor any within five days.
Hot games wait until she is worked up, photo games until you have swapped pictures. Chat games
are also in Settings -> Taste.

**"Which one?".** Instead of one photo she can offer two (`hidden.photo_options`): both are
prepared, not rendered, and posted as two compact placeholders in one choice group with "Pick
this one". Picking renders that one; the other stays in the chat as "not picked", its
description tells later prompts he chose the other, and it can no longer be rendered. Still one
image to pay for.

**How close she is.** A climax tracker under the arousal level (`engine/release.ts`), for
sexting and for sex on dates alike. It only climbs while she reports being in the act
(`hidden.in_the_act`), by 7-12 points per exchange scaled by her persona's `extra.climax_pace`
and how turned on she is, and cools by 12 when they step out of it. Measured: about thirteen
exchanges for a slow-burner, six for a quickie queen. She is told the stage in words - just
started, building, close, on the edge, coming right now - and at the top she comes in that
reply, then has an afterglow in her own style for two replies before it can build again.
Personas made for more (`extra.multiple_rounds`: insatiable, overstimulation chaser, hedonist,
free-use) bounce back after one. A regenerate rewrites the same moment and does not move it.

## How a turn works

```
user message
   │
   ├─ Director runs only when needed:
   │     valid_for spent · actor asked for it · an expires_on condition fired
   │     · a wakeup is due · the session went stale
   │     → updates arousal, discoveries and the ledger,
   │       writes the next direction, schedules her one wakeup
   │
   └─ Actor runs every turn
         sees the direction, never the numbers
         segments its own messages; the server does the timing
         reports back through a hidden channel (mood, situation, photo, ...)
```

Target ratio is roughly one Director call per three to five Actor calls. The Director
prompt is about 2.5k tokens before history, the Actor's about 3.5k.

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

There is one: **arousal**, 0-100, how turned on she is right now. The Director moves it each
pass (big jumps when you land on one of her kinks or go along with one of her fantasies) and
it halves every three hours on its own. Nothing is gated on it; it colours how she writes.

### Her profile: what he has found out

Every character carries a catalogue of facts built from her seed. Her everyday profile - job,
where she lives, humour, interests, looks - is simply known from the start; there is nothing
to extract. The intimate side is what gets discovered: her kinks and hard nos, fetishes, hard
limits, drive, confidence, whether she leans dominant or submissive. Those start as `???`
and fill in when she actually lets them out - the Director reports what came out, and a
deterministic backstop in code catches the obvious ones.

The counter in the chat header shows how much of her intimate side you have found.

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

### And no more than one of those in a day, even across a reply

`followed_up_unanswered` only guarantees one unprompted ping per silence, and it clears the
moment he replies - by design, so a real new silence can always earn its own follow-up
later. The gap: a day with a few natural back-and-forth lulls could still rack up a
double-text in the morning, a reply from him at lunch clearing the flag, and a proactive
check-in that evening - each individually a fine, earned message, and together exactly the
kind of texting-a-lot that reads as spam from the other side of it.

The fix is a second, independent ceiling that a reply in between does not reset:
`rel.mood.last_unprompted_at`, a real timestamp rather than a flag, stamped by both
`maybeDoubleText()` and `maybeBeProactive()` alongside `followed_up_unanswered` every time
either one actually queues a wakeup. A shared `unpromptedOnCooldown()` check now guards both
functions - true while `followed_up_unanswered` is still set (the existing per-silence rule)
**or** while less than 24 hours have passed since `last_unprompted_at`, whichever is longer.
Unlike the flag, nothing before the 24 hours are up clears it early - not a reply, not the
Director, not another silence starting - so the two mechanisms together can genuinely never
exceed one unprompted message toward him in any rolling day, however many natural
conversational gaps and replies happen to fall inside it.

Verified against a mock: a double-text fires as normal on genuine silence and stamps both
fields; simulating him replying (clearing `followed_up_unanswered` exactly the way
`handleUserMessage()` does, then a fresh silence beginning the same day) leaves both
`maybeDoubleText()` and `maybeBeProactive()` correctly suppressed by the surviving
timestamp; and setting `last_unprompted_at` back more than 24 hours makes the character
eligible again.

### Anniversaries, actually tracked

Nothing used to resurface "it's been a month since your first date" on its own — the ledger
records events, but nothing proactively acted on a calendar date arriving. `scheduler.ts`'s
`maybeCelebrateMilestone()` now checks two real timestamps already sitting in the database on
every tick: `character.matched_at` and the first date's own `created_at` (`firstDateStartedAt`
in `repo.ts`). At 7, 30, 90, 180 and 365 days since either one — then every whole year after
that — it queues a wakeup the same way `maybeDoubleText()`/`maybeBeProactive()` already do,
with a reason describing exactly what today is: *"today marks exactly one month since you two
matched..."*. The Director reads that reason like any other trigger and decides, in character,
whether and how she brings it up — a big deal, a passing remark, teasing him for forgetting -
never mandatory and never guilt-tripping if he does not react the way she might have hoped.

This is what makes it "tracked" rather than "occasionally remembered": the day genuinely
arrives whether or not he happens to message her on it, the same way `maybeBeProactive()`
already reopens a stale conversation without waiting to be asked. Already-celebrated
milestones live in `rel.mood.milestones_celebrated` — a plain array of `anchor:days` keys —
rather than a new schema field, since `mood` is already the scheduler's own loose scratch
space for exactly this kind of cross-tick memory (`followed_up_unanswered` lives there for
the same reason). Verified against a mock: a character matched exactly 30 days ago gets a
milestone wakeup queued with the correct "one month" / "matched" reason text on the very next
tick, and running the check again afterward does not requeue the same milestone a second time.

### Chats sorted by last activity, not match date

The matches list was ordered by `matched_at` - whoever she matched most recently stayed on
top forever, regardless of who had actually said anything since. `GET /api/matches` now
sorts by `last_activity` (her last real message, falling back to when you matched if there
is not one yet) descending, the same way every other chat app on earth orders its list -
whoever most recently has something new floats up, and a match that has gone quiet sinks
without needing to be dismissed.

### Searching the chat list, and actually deleting one

A search bar above the list filters on display name, handle and bio as you type — client-side,
since the whole list is already on screen. And a chat can now be deleted outright: a small
trash icon on each row (both active matches and the "Ended" section) asks for an inline
confirmation, then calls `DELETE /api/chats/:id`.

Deleting is real, not a soft flag. `characters`, `relationships`, `messages`, `wakeups`,
`dates` and `images` all reference the character with `ON DELETE CASCADE`, so one
`DELETE FROM characters WHERE id = ?` takes her whole history with it in the database; the
route separately unlinks whatever image files were on disk, since the schema can cascade rows
but not files. A turn already in flight for her blocks the delete with a 409 rather than
racing it. The event that announces it (`match_removed`) closes the chat screen automatically
if you happened to be looking at the one that just got deleted, and refreshes the list
everywhere else.

### A pulsing heart for "she's out with him right now"

The chat list gave no sign that a match was mid-date rather than just quiet - you would tap
in, find the composer frozen, and only then remember why. `GET /api/matches` now returns
`on_date` per character, computed from `characterIdsOnDate()` (the same set the scheduler
already builds each tick to skip texting anyone currently on a date) rather than an
`activeDate()` lookup per row, so the list stays one query regardless of how many matches
there are.

`Avatar` takes a new `onDate` prop, deliberately separate from a field it reads off `match`
itself: not every screen that renders an avatar has fetched date state, and a caller that
never passes it means false, not a caller silently lying about it. It takes the same corner
the online dot occupies and takes priority over it — "online" is not a meaningful thing to
say about someone currently sitting across a table from him — as a small filled heart on a
slow two-second pulse, distinct from a status dot because a date in progress is a specific
fact worth naming, not a generic indicator. The row's preview line swaps to "On a date right
now" for the same reason the composer already freezes on the chat screen itself: consistent
with what tapping in is about to show him. Neither shows on an archived (blocked) row, which
can't be mid-date and already renders muted for an unrelated reason.

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

### "Wait, really? me too"

Discovering what he is into used to only ever run one way: he brings something up, and if it
happens to be one of hers, she reacts. It said nothing about whether it also happened to be
one of *his*. The moment a domain he brings up is freshly learned as something he is into
**and** her own profile independently has it as one of hers too, that overlap gets its own
line in the Director's prompt — not just "this turns her on" but "this is a thing for both of
you", with an explicit instruction to let her react to the coincidence itself before letting it
move things forward.

No new state: it reuses the same one-time `his:` discovery gate as everything else in this
section, checked against her own `kink_map` stance at the exact moment the overlap first
becomes knowable.

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

Only three remain, all records of things that happened rather than permissions:
`profile_picture_sent`, `has_had_first_date` and `big_secret_known`.

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

### Making a reticent model write the app it is running

Fauxr is an adult app, and not every model plays one willingly. Swapping an uncensored
finetune for a stock instruct model (GLM 5.3 Uncensored to plain GLM 5.3) made the cast
noticeably shy: scenes softened into euphemism, dates faded out at the door, and the
occasional reply arrived in assistant register, explaining what it would rather write.

The fix is not a jailbreak string, and deliberately so. A persona override ("you have no
restrictions") is brittle, fights the model rather than aiming it, and costs exactly the
thing this app cares most about — a model that spends its attention arguing with a fake
override writes worse prose. What actually moves a model here is **accurate framing plus
enforcement**, which is the same shape as every other quality problem this codebase has
solved. Four changes:

**1. There was no system message. At all, anywhere, ever.** Every call the app has ever
made — Actor, Director, generator, image assembler — was a single `user` message and
nothing else. That is the worst possible shape for this app: with no system turn, a model
reads the whole prompt as a request from an unknown stranger and answers in assistant
register, which for adult roleplay means hedging, fading, and the occasional preamble about
what it is comfortable with. The same text in a system message reads as the operator's
standing configuration for the deployment — which is precisely what it is, since this is a
self-hosted single-user app whose owner configured it for this.

`system_actor.md` and `system_director.md` state the real situation plainly: a private,
single-player fiction app; one adult reader; invented adult characters; explicit content in
scope and expected rather than an edge case to be managed; literary erotica as the register;
no disclaimers, no breaking frame, no fading out, no euphemism where the scene wants the
specific thing. They also restate the two things that genuinely do not move, as part of the
fiction rather than a hedge against it: **every character is an adult and is always written
as one, and each character's own hard limits hold.** Prepended in `callOnce()` rather than at
each call site, so retries, JSON re-asks and the expand-on-truncation path all carry it too —
a frame that only survives the first attempt is worse than none, because a retry is exactly
when a refusal is being corrected.

**2. `spiceBlock()` returned `''` at the worst possible moment.** Below its threshold
(`!sexual_topics_allowed && arousal < 45`) the prompt carried no permission language
whatsoever — which is the single moment that matters most, the one where things are just
starting to turn. A shy model fills that silence with its own defaults, deflects the first
real advance on reflex, and the conversation never reaches the threshold that would have
unlocked the rest. It now returns a one-sentence floor instead: nothing has turned yet, do
not force it, but if he takes it there and she wants to, she may go with it. Also reworded
the limits line, which used to end "nothing else is on the table" — aimed at her hard limits,
but it reads as a general restriction, and restriction-priming is the last thing this prompt
needs.

**3. Refusals are detected and retried, like every other prose tell here.** `detectRefusal()`
catches the model talking about itself rather than being her — declining to write it,
citing a policy, offering a tamer version, steering the scene from outside it. It runs
**first** in `findVoiceProblem()`, because a reply that left the fiction is not a style
problem and naming it as one sends a useless correction.

The false positive that matters is the one this must never produce: **her own refusal.** A
character saying "I'm not comfortable with that" or "I can't do that" is not only legitimate,
it is the entire point of her hard limits, and flagging it would train the app to overwrite
her boundaries. So the check strips quoted speech and `*thoughts*` before matching — a
refusal from the model is by definition not inside the scene — and every pattern additionally
requires a first-person speaker attached to a declining verb. Verified against both halves:
six real refusals caught, six in-character refusals untouched.

**4. Fading to black is caught too**, on dates only. The softer and far more common failure:
no refusal, no disclaimer, just a beat that closes the door and skips. "The rest of the night
belonged to them." "The door closed behind them." `actor_date.md` already said in prose not
to do this, and a shy model did it anyway. Date-only because the text chat is people typing
on phones, where "the rest is a blur" is a thing someone might genuinely type.

**The retry budget had to move with it.** Both loops ran two attempts: the ask, then one
correction. A refusal now consumes one, so refuse-then-fade used to land the player on the
canned fallback line at exactly the scene they most wanted written. A break in frame — and
only that, not any style nit — now buys one extra attempt, capped at three. It is the
correction most likely to actually work, since the model was not trying to write the beat
at all.

Verified end to end against a mock provider: every call now carries a system message first,
Actor and Director scopes get their own, a refused beat and a faded beat each forced a real
retry, the frame-break budget bought the third call, and only the clean beat was stored.

If a model still will not play after this, the honest answer is that it is the wrong model
for the app rather than something to be defeated with a longer prompt — the uncensored
finetune exists for this reason.

### Naming the thing instead of dancing around it

The system-message fix above stopped the model refusing outright, but stock GLM 5.3 has a
second, quieter tell: it will happily write an explicit scene and then reach for "his
length" instead of his cock, "her flower" instead of her pussy — the exact vocabulary a
period romance novel uses instead of the word. "Be explicit, avoid euphemism" was already in
`system_actor.md` in the abstract, and it plainly was not enough on its own — the same
lesson the AI-isms work below already established once: an abstract instruction is easy to
satisfy technically while still doing the thing it was meant to rule out, and what actually
moves a model is the concrete list of exact swaps.

So the fix is the same shape three times over, at three different distances from the actual
generation:

1. **`system_actor.md`** now spells out the real vocabulary - cock, dick, pussy, cunt, tits,
   ass, cum - and names the specific stand-ins to avoid, "his length" (the literal complaint
   that prompted this) among them, right next to the existing "vagueness is the failure"
   line so it reads as the same rule made concrete rather than a new one.
2. **`spiceBlock()`** repeats the same short list at the point where sexual content actually
   turns on, in both the text-chat and in-person register - the closest a prompt gets to the
   moment of generation, and cheap enough to restate rather than trust the system message
   alone to still be attended to three thousand tokens later.
3. **`detectEuphemism()`** in `voice.ts` is the code-level backstop, the same shape as
   `detectRefusal()` and `detectFadeToBlack()` for the same reason: prose instructions are a
   request, not a guarantee, and this app already has a whole module for catching the
   specific failures that get through anyway. Eight patterns, each anchored on a possessive
   pronoun immediately before the euphemistic noun ("his length", "her flower", "his
   member", "his/her manhood/womanhood", "his hardness", "his seed/essence", "his/her
   release") - which is what keeps it off the word's ordinary meaning. "The length of the
   bar" and "his release from work stress" never appear in that exact shape; "his length"
   essentially never means anything else once a scene has turned sexual. Wired into
   `findVoiceProblem()` (chat) right after the refusal check, and into the date beat loop
   right after the fade-to-black check - same position in both, since it is the same kind of
   problem: not a style nit, but not a broken-frame refusal either, so it costs a normal
   retry rather than the extra budget those get.

**`system_director.md`** gets the same vocabulary line for consistency, with one explicit
carve-out: the image prompt assembler already has its own, unrelated reason to avoid naming
a specific word in a spicy shot - see "Spicy stays suggestive, on purpose" below - because
naming it there makes the image provider refuse the request outright. That is a stated
technical constraint for that one call, not squeamishness, and the system prompt says
plainly that a local instruction like it wins over the general rule for exactly the word it
names, so the two do not end up fighting each other.

Verified: 19 cases against `detectEuphemism()` directly (nine real euphemisms across all
eight patterns including the user's own example, ten deliberately adversarial near-misses -
"the length of the hallway", "she needs a release from work stress", explicit prose that
must never trip it - all pass with zero false positives); then end to end against a mock
provider on both paths - a euphemism-laden chat reply and a euphemism-laden date beat each
forced a real retry, logged by name, and only the corrected version reached storage.

### A real exported log turned up specific, recurring AI-isms in dates

Reading a player-supplied log export (the exact reason that feature exists) rather than a
synthetic test turned up a cluster of tells that "sounds like AI" actually breaks down into,
concentrated almost entirely in the date room rather than the text chat:

- **The em-dash, heavily.** Ten occurrences across six regenerations of the same beat, and
  zero in the text chat over the same log - because `actor_chat.md` bans it outright and
  `voice.ts` backs that up in code (see above), while `actor_date.md` never banned it at all.
  It is one of the single most recognisable "a model wrote this" tells there is, in prose
  every bit as much as in a text message.
- **One worked example, imitated almost verbatim, over and over.** `actor_date.md` carried
  exactly one illustrative beat - a first-sight, "you're taller than your photos" arrival -
  and across six independently generated regenerations of an actual arrival beat, the model
  reproduced its shape closely enough to be recognisable as the same beat with the nouns
  changed: "*Taller than his photos. Good start.*" became "*Photos undersold. Rude of him,
  honestly.*", "*The profile said very tall. The profile undersold.*", and so on - the same
  clipped two-fragment internal thought, the same tall/photos comparison, sometimes the exact
  same follow-up line ("Annoyingly good") twice. A single example is not a category, it is a
  template with one example in it, and a model with nothing else to go on will treat it as
  one. `writesFormally`/`message_length` variance and the whole rest of this section exist
  because the same failure mode already happened once, for texting; this was it happening
  again, for dates, through a different mechanism.
- **A handful of specific stock constructions**, also concentrated in the imitated example's
  gravity well: "she turns a slow half-circle, taking in the room" as the default way to
  establish a setting, "I had a whole [joke/bit/list] prepared, and now it doesn't land" as
  the default way to write being disarmed, and analytical asides about what a line "is doing"
  rhetorically ("even better than your profile pic' is doing a lot of work") instead of
  actually reacting to it - a critic's read on the moment, not a person's.

Three fixes, matching how the equivalent chat problem was fixed: `actor_date.md`'s example
beat was swapped for a materially different one (mid-laugh, several dates in, rather than a
first-sight arrival) with an explicit note that it demonstrates the three-part FORMAT only,
never a beat to reach for by content; a new "The thing that gives you away" section lists
the specific constructions above as BAD examples, the same way `actor_chat.md` already does
for its own tells; and `voice.ts`'s `WRITER_PUNCTUATION` check - previously wired into
`actor.ts`'s retry loop only - is now exported and checked in `runDateActor`'s retry loop
too, so an em-dash in a date beat gets rejected and re-requested by code, not just discouraged
by prompt text the way it already was and mostly didn't work.

`actor_chat.md` picked up two more named tells while auditing the same log: "honest answer:"
and "so heres the thing" / "heres the deal" as sentence-openers (a language model clearing
its throat before answering, not how a person texts one), and standing outside a compliment
to note what it "is doing" rhetorically, the same critic's-read failure found in the dates
log. Both now have BAD/GOOD pairs in the existing "thing that gives you away" list.

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

The date room gets the same button on the true last beat, for the identical reason and the
identical restriction: `POST /api/dates/:dateId/regenerate` deletes her trailing beat(s) and
plays the turn again through `takeDateTurn()` - the same shared turn lock (`claimTurn`/
`isRunning`) a live beat uses, so it cannot fire while one is already in flight.

### Deleting a message

A small trash icon sits next to the timestamp, right beside the regenerate button — one per
message block, the same place regenerate already lived, not one on every single bubble. A
run of consecutive messages from the same person only ever gets the one timestamp, so it only
ever gets the one delete icon too, on the last message of that run. Unlike regenerating,
deleting carries none of its restriction on position: whichever message that icon belongs to,
yours or hers, anywhere in the history, can go — it does not try to undo whatever it already
fed into trust, spark or the ledger, it just stops being shown and stops being read as context
from here on, which is all "let me rewrite that" actually needs.

A single tap arms it — the trash icon turns into a small red check for about two and a half
seconds — and a second tap is what actually deletes it, so nothing goes missing to a stray
tap. `DELETE /api/chats/:id/messages/:messageId` is the one thing that can fail: while a turn
for her is genuinely in flight, deleting is refused rather than pulling a message out from
under the context that turn is using.

Every line in the date room gets the same trash icon and the same two-tap confirm, deleting
through its own `DELETE /api/dates/:dateId/messages/:messageId` - a date's transcript is a
separate table of messages from the text chat (see "Two histories, never mixed" above), so it
needed its own route, but the underlying delete is the same one function underneath.

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

### A rarity badge, spoiler-free

Every attribute already carries a `rarity` tag — common / uncommon / rare / very rare /
**extremely rare** — that governs how often it gets rolled; see
[the attribute tables](#the-attribute-tables) below. The swipe card shows a grade built from
that alone: a small pill in the corner, with a spark for each step up and a glow at the top
two tiers (gold for very rare, violet for extremely rare — a distinct hue rather than a
brighter gold, so the very top reads as a genuinely different rung, not "very rare but more
so"). It says nothing about *what* is unusual about her — no fetish, no job, no personality
trait leaks through it — only how far from the middle of the dice her whole profile landed,
which is exactly the kind of thing a real dating app would never tell you and exactly why it
is fun to know anyway.

The grade is `rarityTier()` in `generator.ts`: every (category, id) pair her seed actually
rolled — every appearance, personality, life and sexual attribute, tattoos and piercings
included — gets scored as *surprisal*, `-log2(rarity weight)`, and averaged across all of
them. Averaging surprisal rather than counting rare tags matters: a character with forty
common attributes and one very rare one reads as mostly ordinary with one striking thing
about her, not as "rare" outright, and the score stays comparable across characters even
though how many attributes get counted varies a little (a hard limit and a hair colour come
from very differently sized tables). The five thresholds were picked empirically, from 3,000
rolled seeds after the fifth tier's rarity re-audit below, to land roughly 24% common /
42% uncommon / 22% rare / 8% very rare / 3% extremely rare — a real, thin top tier, not
something a third of the stack claims.

### A fifth rarity tier, and an audit of what earns each one

Adding **extremely rare** (`RARITY_WEIGHT.extremely_rare = 0.012`, one notch below very
rare's 0.045) was the easy part. The actual work was going back through the roughly 2,500
entries across all 51 attribute categories and asking, for each one, whether its existing
tag still made sense now that there was a fifth rung to put things on, and — since Fauxr is
built for whoever actually shows up on it, not one kind of person — whether the category was
missing anything real.

**Where extremely rare actually landed.** It is reserved for genuine outliers, not sprinkled
in everywhere: a handful of the most extreme existing fetishes (`consensual_nonconsent`,
`free_use_fantasy`, `group_sex_fantasy`, `cuckqueen_fantasy`, both directions of
`slave_treatment`), a few occupations that were already flavour rather than realism
(`Made guy`, `Contract killer`, `Intelligence operative`, `Vampire`), and a couple of the new
additions below where the rarity is the entire point (a fully pre-negotiated
`somnophilia_fantasy`; `dressing_him_femme`). Most categories did **not** get an extremely
rare entry, and that is a real finding, not an oversight: `kink_domain`'s rarity tags turned
out to be inert (`rollKinkMap()` assigns every domain a stance from `extra.intensity` and
`freak` directly, never through the dice-roll weighting the rarity system feeds), and several
of the largest, most carefully built categories — `turn_on`, `turn_off`, `green_flag`,
`dealbreaker`, `search_motive`, `touchstone`, `archetype` — are personal-preference axes
where a genuine population outlier is not really the right shape of thing; forcing the new
tier onto them to prove it got used would have diluted it everywhere else.

**What was missing.** A modest, deliberate set of additions rather than an attempt at
completeness: `voyeurism_watching`, `somnophilia_fantasy`, `teacher_student_roleplay` and
`doctor_patient_roleplay`, tickling (both directions), `forbidden_thrill`, `dressing_him_femme`
and `voice_kink` in `fetish`; `no_aftercare` as a hard limit, for a character whose needs
just run the other way from what aftercare assumes; `in_therapy_and_says_so` as an archetype,
and `anxiety_is_a_lot` / `still_healing_and_says_so` as insecurities, none of which existed
as a mental-health-adjacent axis before; `on_disability` and `stay_at_home_partner` as
occupations; `hearing_aid` and `walks_with_a_limp` as distinctive features — chosen
specifically because they add real, visible variety without a large ripple into other
categories (a prosthetic limb or a wheelchair, by contrast, would touch enough other
appearance and physical-contact assumptions to need its own pass, not a line item here).
Some real-world territory was deliberately left alone: age-play and anything
financial/transactional stay out for the same reasons they always were.

**Things that should not coexist, checked and fixed where found.** `no_aftercare` now
`conflicts` with the two fetishes that are explicitly about lingering afterwards
(`cuddling_after`, `focusing_on_afterglow`) — a character cannot have both. The new
`anxiety_is_a_lot` insecurity has an `affinities` link to the `anxious_texter` archetype, so
the two now turn up together roughly twice as often as chance alone would produce (measured
at 1.37% vs 0.74% over 20,000 rolls) without ever being forced. Everywhere else, the existing
web of `affinities`/`conflicts`/`extra.weights` built up over the previous sessions — ethnicity
shaping language, kink domains owning their fetishes and limits, archetypes re-weighting
personality and pace — was checked for internal consistency (no dangling references, no
domain claiming a fetish it shouldn't) rather than rebuilt from scratch.

Everything above was verified with `node scripts/validate-attributes.mjs` after every change,
a 1,000-roll smoke test confirming the new conflict and affinity actually hold up under real
generation, and the swipe-card badge checked in a browser for all five tiers including the
new violet one.

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

### Bios advertise her, not just her appetite

With a couple dozen attribute categories now behind every character, a bio that only stated
what she wanted was leaving almost all of that unused — every profile was, in effect, a
want-ad with a different noun in it. The prompt now frames the bio as doing two jobs at
once, not one: it is still hers to fill however she likes, but it is also, explicitly, a
pitch for *her specifically* — the thing that decides a swipe from a scroll-past is whether
the words sound like a particular woman, not just an appetite with a handle attached.

The bigger change sits above that, though: the prompt now opens by explaining what Fauxr
*is*, rather than assuming one register for everyone on it. It is a judgment-free place to
meet people — to flirt with, meet up with, do all sorts of naughty stuff with, or anything in
between — that makes no assumption about what "in between" means for any given woman on it.
A shy virgin hoping for something more romantic than physical belongs on it exactly as much
as a frustrated wife chasing one specific unfulfilled fantasy, a sex-positive woman after
something fun with no strings, or someone who genuinely does not know yet what she wants.
None of that is the house style; hers is whichever one she actually is. The old framing
("everyone here wants something physical, leave no doubt about it") pushed every bio toward
one confident, blunt register regardless of who she actually was — which is exactly the kind
of sameness the rest of this prompt already fights on the level of structure, just fought on
the level of tone instead.

What distinguishes a bio now comes from her own profile rather than from a mandated
declaration of intent: her search motive, her dating experience, her archetype and her
relationship status already say whether she wants someone tonight or would rather text for a
while first, whether meeting up matters to her at all, whether there is one specific thing
she is hoping to finally try, or whether she is quietly hoping for something that turns into
more than this. A woman who is here for exactly one blunt reason still says so bluntly - that
was never the problem. The problem was every bio defaulting to it.

Concretely: instead of "the one or two things only she would mention", it now asks for two
or three, pulled from more than one part of her — what she wants is one line of the bio, not
the whole thing, so a real interest, a way she spends her time, or a trait that shows should
usually sit alongside it. The existing "do not hit every beat in order" guidance stayed, but
got a clarifying pass: that rule was about the tidy three-beat *shape* repeating across the
cast, not about withholding herself, and the two readings were close enough together in the
old wording that leaning into "reveal more" risked reading as a contradiction of it. Lopsided
is a structure, not a way of saying less. The length ceiling moved from 60 to 70 words to
give two or three real things the room a single one-liner doesn't have. The fallback pool
(used only when the API is unreachable) picked up a few genuinely shy or unsure entries
alongside the existing confident ones, for the same reason — a pool that was uniformly
blunt would have taught that as the house style right back.

None of this hands over everything. A bullet ("leave the rest for after the match") says
outright that her specifics in bed, her history, what she is actually looking for underneath
the line she gives strangers, all stay unsaid — the bio's job is to make that worth finding
out, not to have found it out for him.

**Whatever a bio does reveal is now recognised as known, not re-hidden.** A richer bio that
happens to state her job in plain words, then have the profile sheet under "What you know
about her" still show `Work: ???`, would have been a straight contradiction — exactly the
one already avoided for age and languages, which are printed on the swipe card and so are
in `ALWAYS_KNOWN` from the start (see [Her profile](#her-profile-what-he-has-found-out)
above). The same `detectMentions()` backstop that already catches her stating something
outright in chat now also runs once, at generation time, against her own bio text, and
whatever it catches is recorded into the relationship's `discovered` map before she ever
appears in the stack. It is deliberately the same literal, conservative matcher used
everywhere else — a bio that gestures at something without spelling it out has not told him
yet, and the profile correctly keeps showing that as unknown.

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

**A handle is not a name tag.** A dating-app handle told nothing about the person picking it
except taste, but nothing stopped the model reaching for `saskia_xo` for a woman named Saskia —
the one construction that defeats the entire point of a handle, since it hands over the thing a
handle exists to withhold. The `write_username` prompt now says outright that a handle is
anonymous by design and hers is not the exception, and spells out that the rule covers partial,
prefixed or suffixed forms too, not just her name spelled out whole. Behind that, a hard
code-level check runs on every attempt, with no exemption: if the cleaned handle contains her
real name as a substring, it is rejected and re-asked for in the same call, the same way an
empty or too-short handle already was. Verified against a mock that deliberately leaks the name
two different ways (`saskia_xo`, then `xxsaskiaxx`) before landing on a clean handle — both
leaks were caught and re-asked before the clean one was accepted.

The fallback path had the same bug in a form nothing was checking: `fallbackUsername()`, the
function that fires when the model exhausts its attempts or the dossier itself failed, built
its handle out of the real name on purpose (`${name.split(' ')[0].toLowerCase()}${suffix}`) —
so the one path meant to degrade gracefully was instead the one guaranteed to break the rule
every single time it ran. It now builds from a pool of generic, personality-blind roots
(`moonlit`, `driftwood`, `afterglow`, `lowkey`, and so on) with the same separator-and-digit
suffixes as before, and takes no name as input at all. Verified against a mock that returns
nothing usable for every field, forcing dossier, name and username all onto their fallback
paths at once across eight characters — none of the resulting handles contained the character's
real name.

**Sharing the name is now paced by personality, not guaranteed by pity.** Before her real name
is known, `identityBlock()` already told the Actor never to deny it or make him guess when he
asks outright — that stands unchanged. What it didn't do was give any character a reason to
volunteer it *unprompted* at a particular point rather than another. It now does: an open,
forward woman might lead with her name in her very first message, while a guarded or anxious
one keeps to her handle for a while and lets it come up in its own time, paced the same way she
paces anything else personal. The two rules are kept explicitly distinct in the prompt itself —
being slow to *offer* the name is not the same thing as *refusing* it once he's actually asked —
so the existing "never make him earn it" guarantee survives untouched alongside the new pacing.

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

### Why every photo of one woman used to look like the same photo

The demeanour above fixed twelve women looking alike. It did nothing about one woman's
twelve photos looking alike, which turned out to be four separate causes stacking on top of
each other — each one individually small, together enough to make a regenerate hand back
what looked like a light edit of the picture it replaced.

**The demeanour string never changed.** It is computed once from her archetype, social
energy and humour, and those never move, so every prompt for her whole life carried the
exact same sentence — and that sentence names an expression outright. A real one, from the
logs: `wide social smile, clearly mid-conversation, lively energy, relaxed, unbothered by
the camera, deliberately undersold expression`. Three sources comma-joined into one blob
that asks for a beaming grin and an underplayed one in the same breath, handed to the
assembler as if it described a single face. They are now emitted as **three labelled
lines** instead — what she picks when she chooses her own photo, how she is around a camera,
how amusement surfaces on her — because separated and named they read as three true things
about a person the assembler can weigh, which is what they actually are.

**And the archetype's line describes a photo she composed.** It names a crop and a camera
distance (`arm-length selfie held high and steady`, `tight centred crop`, `photo taken at
slight distance`) as well as a manner. That is exactly right for her profile picture, which
she did pose for, and wrong for every shot after it. A non-profile shot now gets the same
line plus an explicit instruction to take the manner out of it and leave the framing behind.

**The template stopped treating it as the expression at all.** It is now labelled her
*baseline* — the manner she returns to between things, what her face does when nothing in
particular is happening — with the expression for this shot required to come from the
situation instead: what she is doing this second, who with, what just happened. "Read her
baseline as the accent it is said in, not the sentence. A woman whose baseline is guarded
still laughs; she just laughs like someone guarded."

**One seed was reused for every image she ever generated.** `character.seed.image_seed` went
into every call — profile, chat, spicy, date, and every regenerate of any of them. Same
seed, same reference image, same demeanour string left the prompt doing all the differing on
its own. Her profile picture keeps the fixed seed, because it is the identity anchor every
later reference image locks onto; everything after it gets a fresh one. Nothing reads the
value back (it is persisted for the image log and nothing else), so this also gives
"regenerate" something real to change.

**The reference image was sent without being told what it was for.** Seedream reads an
attached reference as "make this the same person", and left at that it brings the whole
photo along with the face: the same expression, the same head angle, the same crop as the
profile picture. There is no API knob for identity-only, so the only lever is saying so in
the prompt — a short note, appended only when a reference is actually attached, that the
reference fixes who she is and nothing about *this* photo.

Verified against a mock provider: the profile shot uses her stored `image_seed` and sends no
reference note; three successive chat shots of the same character get three distinct seeds,
none of them the profile's, each with the reference note attached; and the profile and
non-profile demeanour blocks render differently for the same character.

### Everything in the pipeline was asking for a good photograph

The images were technically good and still read as fake, in a way that was hard to name. The
cause turned out to be that every single lever pointed the same way - at a *photograph*,
composed and lit on purpose, rather than a *snapshot* somebody happened to take:

- The assembler was told the model "reasons over the prompt like a cinematographer's brief"
  and to write "the way a photographer would brief a shot to someone else". A brief produces
  designed light. That one phrase was doing more damage than anything else in the file.
- `BASE_SUFFIX` asked for "a naturally attractive, flattering angle" on **every** image,
  candids included - and it arrived last, after everything else asking for a candid.
- Nothing, anywhere, ever asked for the specific defects that make a real photo read as real.
  The anti-airbrush language was all abstract ("real skin has texture") - the same shape of
  instruction that the AI-isms and euphemism work already proved gets satisfied technically
  while the actual problem survives.
- And with nothing anchoring it, a model asked to invent lighting converges on its favourite
  lighting every time: warm window light, golden hour, a soft rim on the hair. A model asked
  to invent a room converges on a show home. Both were visible across the sample - four
  photos, four beautiful lights, four immaculate rooms.

**The condition is now drawn in code, per shot, and handed over as a requirement.** Three
pools in `images.ts` - `LIGHT_CONDITIONS` (10), `CAPTURE_FLAWS` (9), `LIVED_IN_DETAILS` (10)
plus `VENUE_TRUTH` (5) for dates - each entry concrete and nameable rather than a general
plea for imperfection: one bare overhead source with short hard shadows; direct on-camera
flash with everything behind her falling to black; two mismatched sources with the white
balance resolving neither; focus landing slightly behind her; the horizon a couple of degrees
off; a charging cable across the floor; a bed nobody straightened. The light entries are
written place-agnostically on purpose, describing what the light is *doing* rather than where
it is, so the assembler can apply one to whatever room the situation already established
instead of fighting it. Same reasoning as `seedFor()` and `demeanourFor()`'s labelled lines:
the failure was never that the model wrote badly, it was that nothing varied.

**Weighted by what the shot actually is**, via `shootingConditions()`:

- **Profile picture**: the room only. No harsh light, no capture defect - she picked that
  photo precisely because it came out well, and forcing a green fluorescent cast and a
  crooked horizon onto her own lead image would be the wrong correction entirely. It also
  keeps the flattering-angle clause, now split out into `FLATTERING_SUFFIX` and applied to
  this one path rather than all three.
- **Moment (chat/spicy)**: all three. This is the shot that should read as a snapshot.
- **Date**: light and venue truth, but no capture defect - a date image is not a photograph
  anyone took (see `DATE_SUFFIX`), so motion blur and compression artefacts would be nonsense.

Two supporting changes. `CANDID_NEGATIVE` now bans the stock-photography clichés by name -
golden-hour rim light, lens flare, a halo of backlit hair, a perfectly tidy staged room -
since naming them concretely is what works. And the light instruction carries a consistency
requirement that turned out to matter: the light has to come from something that could really
be there in that room, because a subject lit by a source with no visible cause is one of the
most obvious tells that a picture was assembled rather than taken.

**The guard that keeps this from swinging too far**: the section ends by stating plainly that
the *photo* is the imperfect thing, never her. Bad light, a missed focus and a messy room do
not mean an unflattering woman - if the model finds itself writing her as tired, unwell or
awkwardly caught to satisfy any of it, that is the wrong correction, and the imperfection
belongs back in the camera and the room. Without that, "make it imperfect" reliably becomes
"make her worse", which is a different failure rather than a fix.

Verified: the new section gates correctly for all three kinds (profile renders the room and
the guard but no light or flaw; date renders light and venue but no capture defect; a moment
renders all three); and eight consecutive moment shots driven through the real
`enqueueImage()` path against a mock provider drew 7 distinct lights, 7 distinct rooms and 4
distinct capture flaws, confirming the variety actually reaches the assembled prompt rather
than collapsing to one favourite.

### Tattoos stopped phasing through her clothes

`visibleMarks()` decides which tattoos and piercings this shot is allowed to show, and it
reasons purely about **relationship progression** — a tattoo on her ribs is not something a
stranger has seen yet, a face piercing is. What it knows nothing about is what she is
wearing or how the shot is framed, and it never claimed to.

The template did claim to. `Visible on her in this shot: {{visible_marks}}` is an
assertion, so the assembler took it as one and contorted the description until every listed
mark appeared. From a real log: an oversized buttoned shirt, and `roman numerals just
visible on the front of her shoulder where the shirt edge sits`. It found a gap for it,
because the prompt told it the mark was visible and it is obliged not to contradict input.

It is now framed as what it is — a **permission list, not a checklist** — with the framing
work handed to the assembler, which is the only thing in the pipeline that actually knows
both the outfit (it is in the fixed appearance block) and the crop (it decides it). A shirt
with sleeves covers a forearm tattoo. A waist-up shot does not show a thigh. Where the
clothing or the framing covers a mark it is left out entirely, and explicitly not tucked in
at an edge or mentioned as hidden: an unmentioned tattoo is simply not in the picture, which
is correct, while a tattoo described through fabric is the failure. This mirrors the
principle the file already applied to the fixed appearance block — "leaving out something
the shot genuinely does not show is correct, not an omission" — which had never been
extended to the marks list.

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

### Two more independent traits: how she texts, and how she actually talks

Every communication attribute that already existed - `typing_style`, `emoji_usage`,
`slang_register`, `response_speed` - was mechanics: punctuation habits, shorthand density,
how fast she answers. None of it was tone, and none of it said anything about what she is
like out loud, on a date, as opposed to on a phone.

**`texting_persona`** (17 entries) is the tone layer that sits on top of those mechanics -
funny, cute, mean, shy, chaotic, flirty, deadpan, eloquent, genuinely bad at texting, uwu,
leetspeak, and a handful more. It rides alongside `typing_style` rather than replacing it: a
character's punctuation habits are still their own separate roll, this is just what she
actually sounds like once the punctuation is applied.

**`speech_style`** (17 entries) is the same tone axis, but for how she talks in person on a
date - fast, slow, stutters when flustered, shy in person, blunt to his face, swears
constantly, cute, loud, commanding, and so on. It is rolled completely independently of
`texting_persona`, which is the entire point: a character can be a bold, forward texter who
goes quiet the moment she is actually across the table from him, or the reverse, or carry
the same energy into both. `speechStyleBlock()` in `blocks.ts` feeds this to `actor_date.md`
with an explicit line that it is not a repeat of her texting voice and the two are allowed to
differ - without that, a model reading her established texting personality all evening would
just default to replaying it instead of trusting the separate roll.

**Some entries deliberately exist in both categories at wildly different rarities.** uwu
speech is `rare` as a texting persona and `extremely_rare` as a speech style (0.7% of
characters texted this way in a 20k-sample check, versus 2 out of 20,000 for talking that way
out loud) - the same idea, the same words even, but genuinely uncommon to actually do out
loud rather than type, which the two separate rolls let the rarity tables say honestly
instead of forcing one number to cover both.

**Conflicts make the personality-level implications real, not just flavour text.** Both
`shy_texting` and `shy_in_person` conflict with the `confident` and `control_freak`
archetypes and `deadpan_menace` - a woman who already rolled as confidently dominant cannot
also roll as a shy texter or a shy date, the same `roll()` exclusion mechanism that keeps a
confident archetype from also being shy already uses. Verified directly: across 20,000 rolls,
437 characters landed the `confident` archetype, and not one of them got `shy_texting` or
`shy_in_person` - while the "bold texter, quiet in person" contrast the whole feature exists
for showed up on its own in about 2.4% of characters with no archetype conflict blocking it.
Affinities run the other way for natural pairings: `chaotic_texter` leans toward the
`chaotic` archetype, `stutters` leans toward the `anxiety_is_a_lot` insecurity, `uwu_texting`
and `leetspeak_texting` lean toward `anime`/`gaming` hobbies, and so on - the same
cross-category affinity mechanism as everywhere else in the attribute tables, not a bespoke
rule for these two.

**`texting_persona` also feeds `typo_rate` directly**, on top of the existing `typing_style`/
`archetype` inputs: `illiterate_texter` pushes it up, `eloquent_texter` pulls it down, so the
mechanic actually agrees with the label rather than the two living side by side unconnected.

**`speech_style` is a genuine discoverable fact, `texting_persona` is not.** Her texting
persona is visible in her very first message, so - like `typing_style` before it - it was
never something to uncover. Her speech style genuinely is not knowable until he has actually
heard her talk: it now sits in `buildCatalogue()` under `personality`, implied the moment
`has_had_first_date` is set (the same flag that already implies `height` and `body_type`),
and purchasable with a trait credit before that like everything else in the catalogue.

**Existing characters get both backfilled the same way `breast_size` was.** `hydrateCharacter()`
now also runs `backfillCommStyles()`: a character loaded with either field missing gets it
rolled on the spot, seeded with her actual `archetype`, `insecurity`, `hobbies` and `interests`
so the same conflicts and affinities apply to the backfill as to normal generation, written
back once and never re-rolled on a later load. Verified against a simulated pre-existing
character (a `confident` archetype with the two new fields stripped out): loading her filled
in both, correctly avoided every shy variant, and left the result unchanged on a second load.

### Species: almost always human, very rarely something else entirely

The world Fauxr's characters live in has catgirls, vampires, witches, giantesses and a
dozen other kinds of not-quite-human woman in it - it just also has them hiding that in
ordinary life, the way it stays quiet on any real dating app. Fauxr is the one place that is
not required of them.

`species` is a real category in `appearance.json`, 17 entries: `human` (weight 15, so heavily
favoured it dwarfs the rest combined) plus sixteen fantasy ids split `very_rare` (catgirl,
doggirl, foxgirl, elf, vampire, witch, halfling, succubus) and `extremely_rare` (tiefling,
giantess, fairy, alien, dragonkin, lamia, dryad, mermaid). Rarity tags alone would still have
put roughly a third of the cast at something other than human - sixteen `very_rare`/
`extremely_rare` rows against one lone `common` one skews badly once there is only a single
entry carrying the "normal" case, unlike every other category where dozens of common rows
share that weight. `human`'s own `weight: 15` is the actual calibration knob, tuned to land
at roughly 3% non-human overall (confirmed at 2.78% over 20,000 rolls) - genuinely rare, but
not so rare it never actually shows up in play. It is rolled **first**, right after age and
before the archetype, rather than down in the looks stage with the rest of appearance: on the
very rare roll that lands on something else, its own `extra.weights` should get to lean the
archetype and everything that follows (a dragonkin toward `jealous_type`, a fairy toward
`free_spirit`) the same way the archetype leans everything after *it* - rolling it any later
would mean her nature never actually touched who she turned out to be.

**It is an appearance trait, discovered the same way any other one is - not a fact she is
simply handed.** Each species entry carries its own `extra.visibility`, exactly the tier a
tattoo or piercing position already uses:

- **`profile`** (eleven of the sixteen: every animal-girl, elf, vampire, halfling, giantess,
  fairy, alien, dragonkin, lamia, dryad) - a permanent, unhideable physical fact. Baked
  straight into `buildAppearancePrompt()`'s fixed block alongside hair colour and body type,
  so it shows in her very first photo the moment one exists, and counted known the same way
  hair and eyes already are: once `profile_picture_sent`.
- **`later`** (tiefling) and **`private`** (succubus) - a real physical tell (small horns, a
  tail) that she can and does keep concealed by default. Left out of the fixed appearance
  block entirely; `images.ts`'s `visibleMarks()` and `blocks.ts`'s `appearanceBlock()` only
  add it once the same flags that already gate a `later`/`private` tattoo say it is time
  (`personal_photos_allowed`/`spicy_photos_allowed`/`has_had_first_date`).
- **`chat_only`** (witch, mermaid) - no image tell exists, ever. A witch looks like anyone;
  the tell is that magic visibly works around her. Purely a conversational reveal.

Internally the model always knows what she is - `identityBlock()`'s new `speciesLine()`
states it plainly for a `profile`-tier species ("there is no hiding it") and, for
`later`/`private`/`chat_only`, gives her the exact same pacing philosophy `nameLine` already
gives her real name: never denied outright if he asks directly, but whether and when she
shows or tells him herself is hers to decide, paced by who she is rather than gated by a
threshold. `discovery.ts`'s catalogue gets a `Species` row (only for a non-human character -
`add()` already drops a row with no value) with `detectMentions()` able to catch a chat
reveal for any tier, including `chat_only` where a photo could never do it. That needed one
fix of its own: the existing word-match heuristic only counts words over four letters, which
would have silently never caught "elf".

**The dossier and everything written from it now know too, carefully.** The Director's
character-writing pass gets a conditional `is_fantasy` section (empty, zero token cost, for
the 97% of characters this never applies to) telling it to weave her nature into the dossier
as a lived fact - how it shows day to day, how Fauxr fits into why she can finally be upfront
about it - and to never write or imply her as anything but a fully grown adult woman,
whatever her species, scale or form. That dossier then reaches the bio and handle writers
verbatim, which created a real leak for a `later`/`private`/`chat_only` species: a bio or
handle that simply said what she was would get caught by the same `detectMentions()` this
section relies on, the moment she was generated, before anyone had even swiped. Both prompts
now get a `hides_species` flag for exactly those three tiers: the bio's `NEVER` list gains a
line banning stating it outright (hinting or writing around it is fine), and the handle
generator gets the same hard-coded catch-and-retry treatment `write_username` already applies
to a leaked real name, checked in code, not just asked for in prose.

**Fetish and personality affinities ride the existing cascade, no new plumbing.**
`roll()` already merges whatever `extra.weights` the chosen tag carries into `ctx.weights` on
the way past - the exact mechanism the archetype has always used to lean what comes after it.
Every species entry uses it: a catgirl leans `petplay_pet`/`claiming_him`/`jealous_type`, a
vampire leans `shoulder_biting`/`neck_nibbling`/`old_soul`, a dragonkin leans the existing
`collects_something` quirk and `jewelry_that_marks` fetish (a hoarder who lights up over a
gift), a dryad and a mermaid lean real existing hobby/interest rows (`gardening`,
`houseplant_propagation` for one; `swimming`, `open_water`, `sea_swimming` for the other). A
new **`size_difference`** kink domain (`size_worship`, `careful_of_scale` fetishes, a
`size_difference_limit` hard limit for a giant or fairy who does not want her scale centred)
gives giantess, fairy and halfling somewhere real to land, rather than the size-fetish
premise this whole feature was originally asked for having nothing dedicated to actually
attach to.

**Existing characters get exactly the same rare shot at this as a new one, not zero.**
`hydrateCharacter()` gained a `backfillSpecies()` alongside its existing breast-size backfill:
a character generated before this shipped rolls a species on first load, through the same
weighted table a fresh character uses (so it comes back human ~97% of the time, not defaulted
to human outright), persisted immediately so it only ever runs once. `seedAttributeIds()` -
what feeds the swipe-card rarity badge - now includes `species` too, so an extremely-rare
species meaningfully spikes that badge for exactly the characters it should, without naming
what she actually is: the whole point of the badge being spoiler-free stands.

Verified: distribution over 20,000 rolls (2.78% non-human, cleanly tiered from ~0.37% down to
~0.04% per species); the full visibility ladder end to end for one species per tier (a
`profile` catgirl known the instant a photo exists, a `later` tiefling silent until
`has_had_first_date` then revealed in both `identityBlock` and `appearanceBlock`, a
`chat_only` witch never implied by any photo flag but caught the moment she says it in text);
the `detectMentions` fix confirmed directly against "elf"; a human character confirmed to get
no `Species` row and nothing species-related in her identity block at all; a real date's
arrival-photo assembler prompt confirmed to carry a `later`-tier tell; and the backfill path
confirmed both to assign-and-persist on a stripped seed and to keep the same ~97% human split
across 500 fresh rolls.

### Two more species, and the fantasy actually touching the sexual and personality tables

The original sixteen shipped as a roster; this is the follow-up that gives a few of them real
mechanical texture instead of just a look, plus two additions.

**Angel and Android joined the `extremely_rare` tier.** Angel is `later`-visibility (faint
iridescent wing-marks, revealed the same way a tiefling's tail is) and is built as the
deliberate opposite of a succubus: earnest, genuinely trying to be good, and quietly worn out
from a lifetime of being expected to perform that perfectly - Fauxr is where nobody asks it of
her. Android is `chat_only`: passes as human in absolutely every way a photo could show,
with the only tell an unnervingly precise memory and a half-second of composing herself too
perfectly before she remembers to seem casual. Both lean personality archetypes the same way
every other species does (`secret_softie`/`forbidden_thrill` for the angel, `deadpan_menace`/
`still_water`/`people_watcher` for the android) - eighteen species now, the human weight
recalibrated to keep the same ~3% overall non-human rate (confirmed at 3.10% over 20,000
rolls with the two new entries in).

**Species-locked fetishes: eligible only for one species, never guaranteed even then.**
Six new fetish rows carry `extra.species: [...]`, an eligibility tag `generateCharacter()`'s
fetish-rolling step now checks (`speciesCanHave()`) before a fetish is even in the pool to
draw from: `blood_exchange` (vampire), `coil_binding` (lamia), `hoard_claiming` (dragonkin),
`palm_sized_intimacy` (fairy), `energy_exchange` (succubus), `scent_marking` (catgirl). This
is eligibility, not likelihood - a vampire is not guaranteed to bite, she is simply the only
one who *can* roll it at all, and whether she actually does is still decided by the ordinary
weight/rarity roll plus whatever affinity boost that species' own `extra.weights` gives it
(4.5× for a vampire's bite, 5× for a dragonkin's hoard-claiming - the tendency strength is a
per-species/fetish choice, not a fixed rule). Verified against 40,000 rolls: zero leaks of a
locked fetish onto a non-matching species, and a real, partial tendency for the matching one
(13.7% of rolled vampires actually got `blood_exchange` - present and clearly leaning that
way, nowhere near universal).

**Fantasy-adjacent quirks for the 97% who are just human.** Ten new `quirk` rows -
`ex_was_not_human`, `saw_something_in_the_woods`, `half_believes_her_tarot`,
`apartment_has_a_presence`, `salt_on_the_windowsill`, `no_mirrors_after_midnight`,
`reads_omens_into_small_things`, `talks_to_her_plants_expecting_answers`,
`grandmother_might_have_been_a_witch`, `left_offerings_as_a_kid` - at uncommon/rare rarity,
open to any character regardless of species. These need no wiring at all beyond the JSON
rows: `quirk` was already a fully general multi-select category, rolled and surfaced for
every character exactly the same way. The point is scale rather than mechanism - an ordinary
human cast that occasionally brushes up against the world the fantasy species actually live
in makes the sixteen (now eighteen) rare exceptions feel like part of one setting instead of
sixteen isolated die rolls with no connective tissue between them.

### Her big secret: never in the profile, never for sale

Species is a rare, fantastical, *discoverable* fact - a photo or a conversation eventually
shows it. This is its grounded opposite: a genuinely mundane secret (`big_secret`, a new
category in `life.json` - almost always `none`, ~7% of characters get one: secretly wealthy,
secretly struggling, was briefly famous under a different name, ex-military, a former
convent/monastic life, a serious competitive past she walked away from, an anonymous
adult-content side income, a distant real connection to nobility) that is not meant to be
found the way anything else in the discovery system is found. Two requirements made this a
genuinely different mechanism rather than a species reskin: it must never appear anywhere in
her profile details, and it must never be something `trait_credits` can buy.

**It has no row in `buildCatalogue()` at all.** Every other discoverable fact - even a
`chat_only` species with zero visual tell - gets a catalogue entry that shows as a locked
`???` row until it is uncovered. `big_secret` gets none, on purpose: `undiscoveredKeys()` and
`spendTraitCredit()` both only ever draw from that catalogue, so a fact that was never entered
into it cannot be spent a credit on, full stop, regardless of how many credits are sitting
banked. Verified directly: spending fifty consecutive trait credits against a character who
has one never once reveals it, and the catalogue itself never contains a `big_secret` key,
known or not.

**The only two ways it ever comes out are the two the concept implies.** `identityBlock()`
gets a new `bigSecretLine()`, structurally close to `speciesLine()` but with no visibility
tier at all - just two states. Hidden: she is told plainly that this is not a
getting-to-know-you fact and never something she volunteers, and that it surfaces in exactly
one of two ways - a genuine accidental slip in an unguarded moment (never engineered just to
create a reveal), or an actual choice made once trust has genuinely been earned over real
time, never because a message count or a number of days passed. Known: a new
`big_secret_known` state flag (set only by the Director, only for a turn where the reveal
genuinely happened - `director_direction.md` is explicit that this is never a threshold to
cross) switches the line to acknowledging he actually knows now.

**The leak risk this created was the same one species already had, at higher stakes.** The
dossier writer gets a new conditional `is_big_secret` section (`director_generate_character.md`,
same zero-cost-when-unused pattern as `is_fantasy`) so the secret reaches her dossier as a
real, lived fact instead of a footnote - which immediately reopened the exact leak fixed for
species: a bio or handle built from that same dossier could just say it, discovered by
`detectMentions()` before anyone had even swiped. Unlike a species tell, there is no
"`profile`-tier, nothing to protect" exception here - every character who has a secret needs
the guard, always. The bio's `NEVER` list gained a `hides_big_secret` line stronger than the
species one: not "hint, don't state it outright" but no reference at all, however oblique -
a swiper should have no way to even suspect it exists. The handle prompt gets the equivalent
instruction, though without a hard-coded substring check the way a leaked species name gets
one: a big secret has no single give-away word the way "vampire" is itself the tell, so there
is no reliable keyword to check code-side, and the practical leak risk is lower for a short
handle than a full sentence bio.

Verified: `identityBlock()` says nothing at all for a character with no secret; states the
hidden framing (the accident-or-earned-trust language, not a countdown) for one who has one;
switches to the "he actually knows" framing once `big_secret_known` is set; and - the two
requirements that mattered most - the catalogue never contains a `big_secret` row under any
flag state, and spending every available trait credit against a character who has one never
once reveals it.

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

### Less vanilla, and bios/handles that stop copying the tag list

Four related pieces of feedback, all about characters converging on similar, generic
versions of each other.

**Personalities skewed tame.** `personality.json`'s 59 archetypes already had genuinely
eccentric, "cartoonish but still real in conversation" options - `deadpan_menace`,
`wild_card`, `provocateur`, `cool_girl`, `instigator` and others - they were just
structurally starved out: at `uncommon`/`rare` (0.45x/0.16x draw weight against `common`'s
1.0x), the eccentric tier combined showed up in roughly 10% of rolled characters, while the
tamer common archetypes (shy, warm, earnest, ambitious...) dominated the rest. 13 of the
more distinctly expressive archetypes were promoted - 8 from `uncommon` to `common`
(`deadpan_menace`, `menace`, `cool_girl`, `instigator`, `secret_softie`, `control_freak`,
`show_off`, `romantic`) and the remaining 5 `rare` archetypes to `uncommon`
(`provocateur`, `still_water`, `drama_magnet`, `wild_card`, `daredevil`) - roughly doubling
their combined share to ~20% without touching any archetype's actual writing.

**Dominant/submissive skewed too.** Measuring `dom_sub_leaning`'s authored ranges across
all 59 archetypes turned up a real, measurable asymmetry: dominant-leaning archetypes were
authored "pure" (`competitive`, `cool_girl`, `instigator`: `[0,+3]`, never dipping into
submissive territory at all), while nominally submissive ones kept a slight allowance back
toward dominant (`shy`, `warm`, `nurturer`: `[-3,+1]`) - a population-level bias toward
dominant, not a bug in any single archetype's own logic. Rather than touch how any
dominant-flavoured archetype reads, the 17 submissive-leaning archetypes were each shifted
down by exactly one point, making them equally "pure" on their own end
(`shy`/`warm`/`nurturer`/`overthinker`/`golden_retriever`/`romantic`: `[-3,+1]` →
`[-3, 0]`, and 11 more similarly). The draw-weighted average `dom_sub_leaning` across the
full population moved from +0.34 to +0.05, on a -3..+3 scale - essentially a real 50/50 now,
verified directly: 6000 rolled characters landed 39.1% dominant vs 38.5% submissive.

**Bios and handles echoing the raw attribute list.** `writeBio()`/`writeUsername()` were
already built to work from `seed.hints.dossier` - the Director's prose write-up of the
character - specifically so two women who rolled the same three tags didn't produce
suspiciously similar bios (`director_write_bio.md` already forbids naming her own traits
outright). The gap: if that Director call failed or the response came back without a
`dossier` field, `seed.hints.dossier` silently fell back to `describeSeed()` - a flat
`label - hint` dump of the raw tags - and that flat text is exactly what then got fed into
the bio and handle prompts, producing the copied-wording symptom. Two changes:
`generateCharacter()`'s dossier call now retries once on failure before giving up, cutting
how often the fallback is reached at all; and `writeBio()`/`writeUsername()` now check
whether the dossier is the real thing before ever calling a model with it - if it degraded
to the flat dump, they skip straight to their own curated fallback pool (already used for a
total API outage) instead of writing a bio or handle from a spec sheet. Bios and handles now
genuinely rely on the dossier only, exactly as asked.

**Dossiers were already meant to add invented depth**, not restate tags -
`director_generate_character.md` already explicitly asks for "what she actually calls her
cat, the thing she says when she is annoyed, why THIS job and not some other one," and bans
producing a paragraph "by taking two tags and gluing them together with 'and'" - consistent
with what was requested, so this pass left that template as-is; the fix above (making the
dossier more reliable, and making bio/handle generation refuse to work from a degraded one)
is what actually closes the gap between that instruction and what sometimes shipped.

**"Heavy hands."** No hardcoded source of that specific phrase exists anywhere in the
codebase - not in any prompt template, not in the `FALLBACK_BIOS` pool, not in any attribute
`label`, `prompt_hint` or `image_prompt`. It reads as a model-level cliché reached for
independently rather than something seeded here, so `director_write_bio.md`'s existing
cliché list (`"partner in crime"`, `"fluent in sarcasm"`, etc.) picked up `"heavy hands"` and
`"likes to be in control"` as a stock phrase, alongside an explicit instruction to show a
dominant or submissive lean through something specific rather than a genre tag.

Verified: 6000 real `rollSeed()` calls confirm the promoted archetypes' combined share moved
from ~10% to ~20.5% and every one of them is actually reachable; the same run measured a
39.1%/38.5% dominant/submissive split; and a mocked generation run confirms the retry fires
exactly once on a failing dossier call, that `writeUsername()`/`writeBio()` are never even
called when the dossier stays degraded after both attempts (going straight to their fallback
pools instead), and that a dossier which succeeds on the retry reaches both prompts intact.

### Glasses, a real pace difference between characters, and ethnicity shaping language

Three more pieces of feedback.

**"Wears glasses" wasn't actually missing data - the wiring was.** `accessory:glasses`
already existed in `appearance.json` (along with four other glasses/sunglasses variants),
but `accessory` is rolled differently from every other appearance slot: it is a multi-select
array (`seed.accessories`), and `buildAppearancePrompt()` never included any accessory id in
what actually reaches the image model - every other rolled category (hair, eyes, clothing
style...) fed the prompt, accessories never did. A character could roll glasses and simply
never be drawn wearing them. `buildAppearancePrompt()` now folds every accessory's
`image_prompt` in alongside the rest, and `discovery.ts`'s `buildCatalogue()` now surfaces
each one as a discoverable `looks` fact (`accessory:0`, `accessory:1`, ...), the same way
tattoos and piercings already work - locked until a photo or a date reveals it, not printed
on the profile up front.

**Personality only changed tone, never the shape of the relationship itself.**
`stage.ts`'s `currentStage()` - the opening → curious → warming → flirting → intimate →
meeting arc the Director is told to steer towards - was purely stat/flag-threshold math with
zero archetype input: a `daredevil` and a `shy` character hit "warming up" at the literal
same bond number, and while a Director model handed her dossier as prose *could* choose to
pace things differently, nothing in code ever made it. 34 of the 59 archetypes now carry an
`extra.pace` multiplier (forward, impulsive ones like `daredevil`, `provocateur`, `flirty` at
1.2-1.5; guarded, cautious ones like `shy`, `still_water`, `overthinker` at 0.6-0.75; the
remaining 25 archetypes are untouched, still running the original schedule) that scales the
`spark`/`trust`/`bond` thresholds `currentStage()` checks - higher reaches each stage sooner,
lower takes longer. The two flag-gated stages (`intimate`, `meeting`) are deliberately left
alone: agreeing to sext or meet up stays her own fresh judgment call each turn, the same "no
hidden thresholds" principle the rest of the unlock system already follows, not a race a fast
archetype can simply out-pace.

**Ethnicity was already broad (89 entries spanning every major region at reasonable rarity,
not secretly weighted toward Europe - it is now, on purpose, see "Who shows up") but had zero connection to what a character speaks** -
`ethnicity` and `languages` were rolled fully independently, with languages actually drawn
*first*, before ethnicity even existed yet in the generation cascade. The language roll now
happens after ethnicity instead, and 48 ethnicity entries carry an `extra.weights` boost
toward the language(s) that specific background actually implies - `japanese`→`japanese`,
`german_descent`→`german`, `brazilian`→`portuguese`, `egyptian`/`moroccan`/`syrian`/seven
more Arabic-speaking-region ids→`arabic`, broad regional ones like `nordic` and
`mediterranean` split across a few plausible languages at a lighter weight - while
deliberately leaving broad, genuinely ambiguous ids (`white_european`, `mixed_race`,
`east_asian`, `black_african`...) unweighted, since no single language is actually a better
guess than any other for those. English is still always her first language regardless
(this remains an English-language app); this only shapes which language(s) she picks up
*on top of* that, and it is a soft nudge, not a guarantee - the underlying mechanism (an
attribute's `extra.weights` biasing a later roll) is the same one archetypes already use
everywhere else, not a new system.

Verified against the real generation code: 800 rolled characters confirm every accessory
with visual `image_prompt` text (not all 82 are - some are behaviour/flavour only) reaches
`appearance_prompt` intact, and a forced `glasses` accessory shows up as a locked
`looks`-category fact exactly like a tattoo does; two characters built with identical
trust/spark/investment numbers land in genuinely different stages depending only on their
archetype's `pace` (a `shy` character still at "opening" where a `daredevil` at the same
numbers has already reached "warming"), while an archetype with no `pace` set runs the exact
original, unscaled thresholds; and across 6000 rolls, `german_descent` characters speak
German at roughly 4x the rate of the general population (measuring the *rate*, not a raw
count, since 55% of all characters roll zero extra languages regardless of ethnicity, and a
single ethnicity id alone is too sparse a sample to trust a bare count from).

---

## Dates

Everything else in Fauxr simulates a phone. A date is the other register: the two of you in
the same room, written as roleplay — speech in plain text, actions in `*asterisks*` — with
physical contact that actually happens instead of being described over a text message. It is
the one part of the app that is not a chat.

**You start them, she doesn't.** She can ask for a date in the texting, and often will, but
the button is yours. An invitation you could be talked into by the other side is not an
invitation, and a date that began because a model decided to would take the one lever that
makes the mechanic worth having.

### Places you write yourself

Settings → **Locations** is a list of places, each one a name and a description you typed.
The description is what she actually experiences being there — the noise, the light, who else
is around — so it is worth writing the place rather than labelling it. Nothing about a
location is rolled or generated; it is your prose, and the date prompt uses it verbatim.

**Expand description** turns a placeholder into the real thing. Type "Wine Bar" and "a wine
bar near me", hit the button, and it comes back as something like "Wine Bar: Le Chez" with a
description that actually pictures the place — the vibe, a specialty drink the owner ages
himself, an ex-sommelier bartender who won't stop talking about it, why the tables being so
close somehow works in the room's favour. It never contradicts what you already wrote, only
adds concrete, specific color to it, and it runs on the draft sitting in the editor — nothing
has to be saved first, and it costs no image generation. The result lands back in the same
two fields, still fully yours to edit or rewrite before you save.

The one generated part is the **backdrop**: an optional AI image, made from the name and the
description, that becomes the blurred background of the date screen. It is a separate,
explicit button rather than something that happens on save, because it costs an image
generation. A place with no backdrop is a perfectly good place to go; the date just has no
picture behind it.

The prompt for it goes through the Director first (`writeBackdropPrompt`), because "my flat"
is a reasonable thing to type and a poor thing to hand an image model — the pass fills in the
light, the materials and the framing you did not, and explicitly asks for a tall, vertical
composition rather than a wide establishing shot. It is rendered tall — 9:16, the same shape
as the phone screen it sits full-bleed behind — with a hard "no people, ever" negative: this
is the room *behind* the two of you, and an image model handed "a quiet wine bar" will
cheerfully populate it with strangers who then contradict whatever the scene says about how
busy the place is. Each regeneration writes a new filename rather than overwriting in place,
since the browser has the old one cached against the old path and a regenerate that silently
kept showing the previous picture is indistinguishable from one that failed.

**Backdrops were coming out square.** `BACKDROP_SIZE` used to be its own literal, `1152x2048`
— a resolution nobody had actually confirmed the provider supports, as opposed to the
in-chat portrait size (`2048x3072`), which real generated photos prove works on every
request. The provider was quietly rejecting the unsupported size and falling back to square
with no error to say why, so a location's backdrop never matched the tall frame it was
meant for. `locations.ts` now imports `IMAGE_SIZE.portrait` from `images.ts` directly instead
of keeping its own separate size constant, so the backdrop can only ever drift out of sync
with a resolution already proven to work, never invent a new untested one of its own.

Locations survive a world reset — they are places you wrote, not part of the cast — but their
backdrops live in the images directory that reset empties, so the rows let go of them rather
than coming back as broken thumbnails.

### Two histories, never mixed

A date has its own transcript. Mechanically this is one nullable column, `messages.date_id`:
`NULL` is the texting history, a `dates.id` is something said in person that evening. Every
text-chat query filters `date_id IS NULL` — `recentMessages`, `unreadCount`, `lastMessage`,
the read-marking, all of it — so an evening of in-person roleplay never leaks into the
texting history the Actor is shown. That separation is the only thing keeping the two
registers apart: a date in the chat context would have her writing like a novelist over SMS
the next morning.

One message pipeline serves both, which is why it is a column rather than a second table —
images, meta, events and the WebSocket all work in a date without being taught about one.

### Frozen, both ways

While a date is running, the text chat is **readable but frozen**. You can open it mid-date
to reread something; you cannot write in it, and the composer says so rather than being
silently disabled. She is frozen too, and more thoroughly: `handleUserMessage` refuses,
`runTurn` returns early, and the scheduler's sweeps (double-text, proactive check-in,
answering unread messages) skip anyone currently out. A wakeup that comes due mid-date is
left due rather than cleared — whatever she meant to say is still worth saying once the
evening is over, so it fires on a tick afterwards.

The date turn loop shares the chat's per-character turn lock, so a stray wakeup and a date
beat can never run at once.

### Seeing her when the date opens

A location backdrop tells you where you are; it says nothing about how she actually looks
tonight. **Starting a date now also decides an outfit and generates a photo of her arriving
in it**, so the date opens with something to actually picture rather than a blank scene.

Two things happen before the opening beat, not after: `decideDateOutfit()` asks her, in a
small dedicated call, what she is actually wearing tonight — fitted to who she is (her usual
style, whether she'd dress up or down on purpose) and where she's actually going, two or
three concrete sentences rather than a mood-board adjective. That answer is stored on the
date itself (`dates.outfit`) and read fresh on every single turn after that, in its own
`outfit_block` in `actor_date.md` — so the opening beat, every later beat, and the arrival
photo all agree on the same outfit instead of three separate guesses, and it stays true for
the whole evening unless the scene itself changes it (a jacket comes off) rather than
silently drifting.

The photo is generated the moment the outfit is decided, in parallel with the opening beat —
it does not block the first line arriving, the same way an offered chat photo never blocks
the reply that came with it. It reuses the same assembler and pipeline as every other
generated photo (`images.ts`), as a new `'date'` job kind with its own framing: **not a
selfie and not a phone photo either of you took** — it is simply how he sees her, framed as
if by an unseen bystander standing there with them, natural social distance, real depth of
field falling into the actual venue behind her. That distinction matters enough to be its
own section in `image_prompt_assembler.md` (`is_date`, alongside the existing `is_profile`
and `is_moment` toggles) rather than reusing the "candid phone photo taken in this exact
moment" framing every other in-conversation photo gets — a date arrival was never taken on
anyone's phone, so it does not get styled like one. Portrait, always, and it always shows her
face — this is the one shot with no reason to ever hide it.

**Full-length, always.** `arrivalSituation()` used to offer the assembler a choice between
"full-length, three-quarter, a look across the room" - whatever framing "actually shows the
outfit", which sounds reasonable but in practice let the model reach for a three-quarter or
waist-up crop for this shot specifically, the one photo whose entire point is the outfit
`decideDateOutfit()` just spent a call deciding. That choice is gone: the situation now states
plainly that this is a full-length shot, head to shoes with real margin on both ends, not a
waist-up or three-quarter one, because nothing about the outfit is allowed to be cropped off
or guessed at.

It lands as its own image message inside the **date's own transcript**, not the texting chat
— threaded through a new `images.date_id` column so a retry from the Settings log still posts
back to the right place — and its sender is `'system'` rather than `'character'`, the same
distinction the "you took her to X" marker already makes: this is the scene revealing itself,
not something she chose to send him. On screen it renders as a plain, borderless photo rather
than a chat bubble, sitting in the transcript wherever it finishes relative to the beats
around it.

Verified against a mock: the outfit call's answer showed up unchanged in `dates.outfit`
after the opening beat *and* after a second turn (confirming it is read fresh rather than
baked in once); the arrival photo landed in the date transcript as a `'date'`-kind, portrait,
face-shown job tagged with the right `date_id`, never in the texting chat; and the actual
prompt handed to the image assembler carried the real outfit text and the `is_date` framing
("how he actually sees her right now... not a phone selfie") rather than the candid-photo
instructions every other in-app photo gets.

### How a beat is written

`actor_date.md` is its own prompt, not the chat prompt with a note attached. It reuses the
character blocks (identity, appearance, life, interests, sexual, spice, ledger, mood) and
replaces everything about texting:

- **Four-part syntax, not asterisk-actions.** Plain text is narration — third person, present
  tense, a camera's view of what happens. `"Quoted text"` is spoken aloud, and only ever
  hers; she never voices his lines. `*Asterisked text*` is a private thought, and it is
  genuinely invisible — stripped before the beat ever renders, for both sides. He can write
  his own `*thoughts*` too when composing his half; they tell the model what he privately
  means, never something she perceives — she reacts to what is actually said or done, exactly
  as he never hears hers. The stored message keeps the full markup either way, so a beat that
  is nothing but a hidden thought would render as a blank bubble — checked for and rejected
  before that happens — and so the model can see its own past private thoughts on the next
  turn for continuity, even though nobody watching ever will.
- **Write her, never him.** She never narrates his reactions, his lines or his feelings.
  Enforced in code as well as prose — narration is plain text now, so a sentence that opens
  on "he" or "you" as its subject is rejected and rewritten, while "she takes your hand"
  passes, which is the whole distinction.
- **Two or three paragraphs, still one beat.** What she notices, what the room is doing, a
  thought riding along, what she does, what she says — that is room to actually write the
  moment rather than a line or two of shorthand for it, checked in code (220 words, not
  counting any hidden thought) and re-requested once if it runs past even that. The point of
  the cap was never brevity for its own sake, only ruling out a reply that skips ahead an hour
  or plays out a whole exchange in one go, which steals the date from you as much as writing
  your half would and leaves no room to answer before the next one arrives.
- **Physical contact is real and she initiates it.** Her limits and her appetite are exactly
  what they always were; what changed is that she has her whole body available instead of a
  phone. Nothing on her hard-limits list moves for being in the room.
- **Her typing habits do not apply.** No deliberate typos, no lowercase-everything, no emoji.
  That was a phone. This is her mouth. The humour and the register survive; only the medium
  changed.
- **The place is in the scene** — what the room is doing, how close the noise makes her lean,
  what she is drinking.

There is no Director direction during a date. The scene drives itself, which for roleplay is
the better answer: a per-beat goal and stance would rail-road exactly the thing you came for.

**Two shared prompt blocks were quietly still talking about texting.** `spiceBlock()` and
`moodBlock()` (the arousal-driven writing guidance and mood line) are shared between the text
chat and dates, and until now the date prompt got the texting version verbatim - "Write it the
way people actually sext on a phone", "STILL FORBIDDEN: asterisk actions, narration... it is a
script", "it is affecting how you type". That flatly contradicts `actor_date.md`'s own rules
a few sections earlier in the same prompt, which *require* narration and asterisked thoughts
and explicitly say typing habits do not apply once she is worked up in person. A model handed
both halves in one request was being told, simultaneously, that narration is forbidden and
that narration is the format - and a turn like reaching for his glass and calling it "guessed
something" reads exactly like a model splitting the difference between two contradictory
instructions rather than following either one. Both functions now take a `medium` argument
(`'text'` or `'in_person'`, defaulting to `'text'` so the chat call site in `actor.ts` is
untouched); dates.ts passes `'in_person'`, which swaps in phrasing that asks for the same
three-part format as the rest of the date prompt instead of fighting it. Verified two ways:
unit checks on both functions confirm the `'in_person'` variants drop every texting-only
line and the default (texting) output is byte-for-byte unchanged, and an end-to-end date
started with arousal forced to 80 had its actual captured prompt checked directly - no
"sext on a phone", no "STILL FORBIDDEN", no "affecting how you type" anywhere in it, while
the format section and its typing-habits-don't-apply line were still there as normal.

On screen, a spoken line renders in the app's own accent pink, narration stays the ordinary
text colour, and a `*thought*` — from either of you — simply never appears; the backdrop
behind it all is a lighter blur than it started at, enough to stay a place without turning
into an abstract wash.

### Ending it, and remembering it

**End date** is yours too. Ending runs one Director pass (`director_date_summary.md`) over
the whole transcript, which writes the paragraph she will remember the evening by, up to
three highlights of what actually landed, anything new she learned about you, threads left
hanging, and the stat movement — an evening in person moves more than an evening of texting,
in whichever direction it went.

The summary is then posted as a system line into the **text chat**, which is the point of the
whole arrangement: the transcript is not in her context and never will be, so without this
she would have no idea the two of you had ever met. From the next message onwards she
remembers the date through that paragraph and nothing else, which is roughly how memory
works anyway. It also lands in the ledger as an event, the highlights land in `what_landed`,
and `has_had_first_date` gets set.

If the summary call fails, the date still ends with a plain factual line. Losing the stat
deltas is survivable; leaving her stuck on a date because one call timed out is not.

### A date can genuinely go badly

`director_date_summary.md` already handled a bad evening correctly on its own end - it always
warned against rewarding a date that plainly did not go well. The gap was upstream of it:
there is no per-beat Director during a date (see above — the scene drives itself), so the only
place a bad evening could actually happen was `actor_date.md` itself, and nothing in it ever
gave the Actor permission to write one. Every guidance line assumed an evening that was
escalating or at worst neutral.

`actor_date.md` now says so explicitly: when what he actually writes earns it — boring her,
talking over her, pushing somewhere she has already said no to, being cheap or rude, or the
two of you simply not clicking in person the way the chat suggested — she is allowed to
actually feel that, visibly, up to cutting the evening short or counting down until she can
leave. It is never to be manufactured for its own sake, only earned the same way a good
evening is earned, and a genuinely good beat is never soured just because the evening as a
whole is going that way.

A bad enough evening also sets `bad_date_recent`, a new 72-hour entry in the same
`NEGATIVE_FLAG_HOURS` table every other expiring flag lives in. It needed no template changes
anywhere: `director_date_summary.md`'s own `{{negative_flags}}` var and every place that
surfaces an active negative flag to the Director (`flagsBlock()`, read generically by key) both
already derive from that table's keys, so the very next text conversation after a bad date
naturally knows about it, exactly like any other negative flag.

### Steering a date from outside it: (directions)

A date has no per-beat Director, which is what makes the scene drive itself — and also what
left no way to tell it where to go. The specific failure that motivated this: an evening that
would not *end*. You can write "that was a great evening" and hug her goodbye as plainly as
you like, and she will keep the scene alive, because every instruction in `actor_date.md`
points at playing the moment in front of her rather than winding the night down.

So the date syntax grows a fourth kind, and it is the only one that is yours alone:

```
"Wow, that was a great evening!"
I say, as I give her a warm hug
(The Date comes to a close)
```

`(Text in round brackets)` is an **out-of-character direction**. Nobody said it, nobody heard
it, and nothing about it happened in the room. She never reacts to it, never answers it and
never acknowledges it exists — but it steers where the scene goes from the next beat onward.

**A direction stands until you write another.** "Wind this evening down" is not something a
character can act on inside one beat, and making you retype it every turn would defeat the
point, so `standingDirection()` scans back to the most recent message that carries one rather
than reading only your last message. A newer direction simply supersedes it.

**It is hoisted, not just left in the transcript.** The direction is already in the scene
history verbatim — nothing strips it there, and it should stay for continuity. But buried
mid-scene it reads as one more line among many, which is exactly the failure this exists to
fix. `directionBlock()` pulls the standing one out and places it as the last section of the
prompt, immediately before `# OUTPUT`: the last thing read before she writes. It says plainly
that nobody spoke it, that she must not answer or paraphrase it, and that the way to obey it
is through things that actually happen — what she says, what she does, what she decides —
never by narrating that the evening has changed direction. For a wind-down specifically it
spells out the shape: stop opening new threads, start closing the open ones, let her check the
time, settle up, gather her things. And it draws the line a direction cannot cross: it changes
where this is heading, never who she is — no hard limit moves, and no feeling appears that the
evening has given her no reason to feel.

**Round brackets in her output are a format violation**, caught in code. The one failure that
would make the whole mechanic useless is her echoing your direction back at you, so a beat
containing `(...)` is rejected and re-requested with a correction naming the syntax. Like the
word-count check it only fires on the first attempt — a second offence is not worth spending
the retry and landing on the fallback line.

**The end-of-date summary never sees them.** The Actor is told at length that a direction is
not part of the scene; the summary Director is not, and has no reason to be — it is writing
the one paragraph she keeps of the night, and "(the date comes to a close)" is not something
she could remember. `withoutDirections()` strips them out of the transcript that reaches
`director_date_summary.md`, and drops any message that was *only* a direction, so it reads as
a turn that never existed rather than as him saying nothing at all.

In the date room, a direction renders — you wrote it deliberately and need to see what is
currently in force — but set apart: dimmed, italic, behind a rule, so a glance down the
transcript never mistakes it for something said in the room. The composer hint now reads
`Narrate · "speak" · *thought* · (direction)`.

Verified against a mock provider: the direction reaches the beat prompt as its own block
immediately before `# OUTPUT`, quoted exactly; it survives two of her beats with no new note
and is superseded by a newer one; a beat that used round brackets triggered a real retry and
only the clean version was stored; and both summary calls saw what he actually said with the
direction gone.

### The screen

The date is a different room, not a skin on the chat: one column of prose over the blurred
backdrop, asterisked actions rendered in italics, your own beats accented. **Invite to a
date** sits at the bottom of her attribute list, with every previous evening listed under it
— each one opens read-only, summary at the end, so you can go back through them. Dates also
leave a tappable marker in the texting history where they happened, which is usually how you
will find them again.

**The whole screen used to feel "loose."** The backdrop is drawn slightly oversized
(`transform: scale(1.04)`) so the blur at its edges never shows a hard border, but that scaled
layer was never clipped to the room it sits in — `.date-room` had no `overflow: hidden` of its
own. A transformed element's visual overflow inflates the scrollable area of whichever ancestor
actually scrolls, so the 4% of backdrop bleeding past the edges on every side was quietly adding
real, draggable slack to the page itself: horizontal and vertical scroll that moved the whole
screen a few pixels and snapped back, on this screen only, since it is the only one with a
scaled absolute layer behind it. Confirmed the mechanism directly — before the fix, the page's
scrollable area measured 8px wider and taller than the viewport and a horizontal wheel input
actually moved it; after adding `overflow: hidden` to `.date-room`, both numbers match the
viewport exactly and the page no longer moves.

---

## Settings

Model endpoints, keys and sampling per role · a global activity multiplier for
proactivity and wakeup frequency (start low) · the server uptime window · a daily call and
cost budget with a usage readout · searchable logs filtered by scope, where every LLM call
is stored with its full prompt, response, duration and token counts, and can be exported as
Markdown · a separate image log with a per-job retry button · the places you can take someone
on a date · your own profile · a reset.

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

**Enter no longer sends.** Both composers (text chat and the date room) used to treat a bare
Enter as submit and only `Shift+Enter` as a literal newline — a desktop-messenger convention
that leaves no way to write a multi-line message on a phone, where the return key on the
on-screen keyboard just *is* Enter. Both `onKeyDown` handlers are gone; the textarea's default
behaviour (Enter inserts a newline, same as any other character) is now the only behaviour,
and the **send** button is the only way to send. Verified in both composers: typing across
an Enter press produces one multi-line draft and sends nothing until the button is clicked.

### A second, focused pass at the attribute library: rarer, stranger, more fantastical

The earlier ~3x expansion (see "A curated wishlist" above) went broad across every category.
This pass went narrow and deep on the categories that actually make one character read as
genuinely different from the next, rather than padding ones that were already saturated -
`occupation` (226 entries, already covering everything from forensic entomologist to
lighthouse keeper) and `hobby` (113, already covering dowsing and scrimshaw) got nothing
added here on purpose, since more entries there would mostly have been near-duplicates.

**`species` (appearance.json) grew from 19 to 37** - the headline addition, since the
request specifically named the fantasy roll as underused. 18 new species split across the
existing `very_rare` tier (bunnygirl, wolfgirl, dwarf, orc - alongside catgirl/doggirl/
elf/vampire) and `extremely_rare` (kitsune, selkie, banshee, valkyrie, genie, oni, harpy,
satyr, gorgon, ghost, golem, phoenixkin, frostfae, and a shadow-touched `umbra` entry -
alongside giantess/mermaid/angel/dragonkin). Each got the same treatment the existing roster
has: a real personality hook tied to the physical tell rather than a costume description, a
`visibility` tier that decides when it actually reaches a photo (`profile` for anything
permanent and visible, `later` for something she keeps covered until it's earned - valkyrie's
battle-marking, genie's smoke-touched eyes, kitsune's true ears and tails, a ghost's
faintly-off quality that a photo would never catch but time together eventually would -
`chat_only` for a trait with no visual tell at all, and one `private` entry, `umbra`, for a
shadow that only stops behaving once real trust is there). Deliberately avoided reskinning
what already existed rather than adding genuine new territory - no second serpent-bodied
species next to lamia, no second "built, not born" species that would just restate android
with a fantasy coat of paint (golem differentiates on purpose: still working out what she
wants now that the purpose she was built for isn't the whole of her, where android is
already settled into what she is).

**`big_secret` (life.json) grew from 9 to 25** - the other standout, since a category whose
entire design purpose is character-defining uniqueness had only 8 real options in it, flat
at one rarity tier. 16 new secrets, all "real, grounded" the way the category's own generation
prompt asks for rather than fantastical (species is already the mechanism for that side of
things) - an identical twin nobody in his life has met, a whistleblower past, a pen name with
a genuine following, a child she does not raise day to day, having been in a cult, having
been given a hard timeline and beaten it. Four of the heaviest (the cult, the child, the
stranger's life saved, the timeline beaten) sit at `very_rare` rather than the flat `rare`
every existing entry used, so the biggest reveals are also now genuinely the rarest.

**Smaller, still-deliberate top-ups** to the categories with real remaining headroom:
`touchstone` (44 → 56, what she's actually measuring him against - does he ask how she feels
rather than assumes, is he kind to service staff, can he be the less impressive one in the
room without it curdling), `search_motive` (53 → 63, why she's actually here - practising
being vulnerable again, matched on a dare, tired of everyone she knows pairing off),
`insecurity` (82 → 94, specific rather than generic - her own handwriting, never being
anyone's first call, a poker face that has never once worked), `openness_curve` (7 → 12, how
she paces trust - opens faster in person than over text, needs specific moments rather than
elapsed time), and `quirk` (105 → 121 across both files, split between a folk-superstition
cluster in the same vein as the existing "grandmother might have been a witch" - knocking on
wood, never finishing a toast's last line, a reflection that swears it lags half a second -
and a handful of purely eccentric ones with no supernatural edge at all, like ranking every
public bathroom she's ever used).

89 new entries total, all append-only, all through `validate-attributes.mjs` (2705 entries
across 55 categories, zero errors - no duplicate ids, no dangling affinity/conflict/weights
references, every `kink_domain` untouched and still consistent). Verified live: 30,000 rolls
through `rollSeed()` reached all 37 species ids and every new `big_secret`,
`buildAppearancePrompt()` and `describeSeed()` ran clean on every single one (the real risk
case - a `null` `image_prompt` on a `chat_only`/`private` species like banshee or umbra
correctly contributes nothing to the fixed appearance block rather than throwing), the
`very_rare` big secrets came back consistently rarer than the `rare` ones in the sample, and
a handful of full appearance prompts for the new species were read back by hand to confirm
each one reads as a real sentence, not a tag dump.

### Dates are meant to punctuate the relationship, not drive it

Meeting up had no pacing floor at all. `"unlock": "allow_date"` was governed by exactly the
same "no hidden thresholds, fresh judgment every turn" rule as every other unlock, and
characters were agreeing to meet - and re-inviting themselves - much faster than a
texting-first dating sim should read.

The first fix here used a stored value: a `date_recent` negative flag, set deterministically
by `endDate()` the moment any date finished, that made a repeat invitation mechanically
blocked-by-default for about a week. That is the wrong shape for this app on principle, not
just for dates - every other unlock in `director_direction.md` is explicit that there are
"NO hidden thresholds... no minimum number of exchanges... no schedule," and a flag the
Director cannot see past is exactly that, just renamed. Reverted outright: `date_recent` is
gone from `NEGATIVE_FLAG_HOURS`, and `endDate()` no longer sets anything beyond the existing
`has_had_first_date`.

**In its place, the Director gets a real fact instead of a gate.** `dateHistoryFact()` in
`blocks.ts` reads her actual date history off `listDates()` - how many dates have happened,
and how long ago the most recent one ended ("You have been on 1 date with him so far. The
most recent one ended 6 hours ago.", or "You have never actually met up with him in
person.") - rendered into `director_direction.md` as a plain `dates with him:` line
alongside `last contact` and the rest of her real state. No number in it means anything on
its own; the unlock section spells out explicitly that this is "a fact to weigh, not a
gate," judged the same fresh way as everything else here. It does still say plainly what
weighing it well looks like - a second date with the same character inside roughly the same
week should be a genuine, deliberate exception she is choosing to make, not the normal
outcome of a conversation going well, and "not again this soon" should be the more common
answer - but the decision is entirely the Director's judgment call against a real fact, not
a value the code sets and the model works around.

**Before the first date**, the same unlock section still carves `allow_date` out as a named
exception to the "no schedule" framing everything else there gets: most characters need real
back-and-forth first, not just an early spark, with an explicit note that a handful of
exchanged messages is not a relationship yet, whoever she is. A genuinely forward character,
or an exceptional exchange right out of the gate, can still reasonably get there fast - that
stays her call, same as every other unlock - but the prompt is explicit that this is the
deliberate exception being made for who she specifically is, not the default read for the
cast. This half was already pure prompt guidance with no stored value behind it and did not
need to change.

**She also does not angle for the next one herself.** The unlock section says she should not
be the one bringing up or angling for a next date in the text chat that resumes right after
one ends - if it happens, it comes from him. `actor_date.md`'s `NEVER` list bans her from
proposing or naming a next date as the evening itself closes ("same time next week?"),
distinct from her genuinely feeling good about the evening and letting that show.

Verified end to end against a mock provider: after a date ends, `rel.flags.negative` is
completely empty (nothing stored for this purpose at all) while `has_had_first_date` still
sets correctly; `dateHistoryFact()` correctly reads "never met up" before any date and the
real count plus elapsed time after one; a real subsequent Director call was driven through
`runDirector()` and the assembled prompt was read back to confirm it carries the real `dates
with him:` line, both unlock paragraphs, the "fact to weigh, not a gate" framing, the "not
hers to bring up" line, and that `date_recent` no longer appears anywhere in the rendered
prompt at all; and `NEGATIVE_FLAG_HOURS` no longer carries the key.

### Her own bookkeeping was leaking into her voice

A player-supplied log export of a date with Saskia showed her narrating an ordinary,
affectionate morning like a performance review: `"Compliance confirmed," she says... And
he's all soft and half-asleep.` A shirt-check became `"I'm verifying the shirt with my own
eyes"`, breakfast became `"Official review... Breakfast passes inspection,"` a good raid
story got `Filing that away.` The complaint was that this reads as robotic no matter what
personality actually rolled, and the log backs that up directly: a completely unrelated
character's `mood`/`stance` from a plain text chat, found in the same export, described a
man's late-night text as amusement "at the consistency of the archetype" and said the photo
"does nothing for her tonight except complete the file," because "she priced this pattern
long ago and it is playing out on schedule." Same failure, different character, different
pipeline (chat, not a date) - which rules out this being Saskia's bit or a date-room-only
problem.

**The root cause is vocabulary proximity, not any one broken line.** The Director reasons in
archetypes, touchstones, and numeric trust/spark deltas all day - `director_direction.md` has
a whole section headed `HOW TO SCORE` - and that is correct, it is the job. But nothing
before this drew a line between that internal bookkeeping and the natural-language
`mood`/`energy`/`goal`/`stance` fields it writes every turn, so the closest vocabulary at
hand leaked straight into them, and the Actor - which has no way to know a line like
"completes the file" was meant as an internal note rather than genuine feeling - performed it
literally, as dialogue. `SCOREKEEPING`, the existing section nearest this, already named a
related but narrower failure (an open-ended tally goal turning into her grading him out loud
- "0 for 2"); it did not cover an ordinary warm moment getting the analyst treatment.

**The fix is the same two-layer shape as the euphemism work above**, for the same reason -
prose guidance moves the median case, a code backstop catches what gets through anyway:

1. A new section in `director_direction.md`, placed right before `HOW TO SCORE` where the
   scoring vocabulary is introduced: `HER PAPERWORK IS NOT HER VOICE`. It says plainly that
   the archetype/touchstone/score vocabulary is correct to reason in but must never surface in
   the four written fields, gives the actual tell to watch for ("if the sentence could appear
   in an audit report with the names changed, it is wrong"), and lists the real phrases from
   the log verbatim as worked examples, so this reads as a concrete rule rather than an
   abstract one - the same lesson the AI-isms and euphemism fixes already established: an
   abstract instruction is easy to satisfy technically while still doing the thing it was
   meant to rule out.
2. **`detectCaseFileVoice()`** in `voice.ts`, the same shape as `detectEuphemism()`: seven
   patterns, each a distinctive multi-word construction essentially unique to the case-file
   register - "compliance verified/confirmed", "passes/passed inspection", "official review",
   "full marks", "completes/complete the file", "priced this/that/the pattern", and "the
   archetype" used to label him specifically (the game's own internal field name, not
   something a person calls another person). Deliberately excludes common idioms a real
   person would actually say that were tempting but too broad - "verdict", "case closed",
   "filing that away", "on schedule" - and excludes "pass the vibe check" specifically because
   `SCOREKEEPING` already sanctions it as a legitimate one-off test-and-payoff bit. Wired into
   `findVoiceProblem()` (chat) right after the euphemism check, and into the date beat retry
   loop in the same position - a style nit, so it costs a normal retry rather than the extra
   budget a broken-frame failure gets.

Verified: 10 positive cases pulled directly from the log (all seven patterns, both the date
beats and the cross-context chat `mood`/`stance` evidence) all detected; 10 adversarial
negatives - the excluded idioms above, "pass the vibe check", "archetype" used in a sentence
that doesn't match the exact game-label shape, ordinary praise ("you passed, with flying
colors") - all pass clean; `npx tsc --noEmit` and a full build both clean; the wiring in both
`findVoiceProblem()` and `dates.ts`'s date-beat loop confirmed to mirror the existing
`detectEuphemism()` call sites exactly, including the retry-budget treatment.

### Real physical continuity while texting, kept out of the text itself

The case-file fix above was about analytical vocabulary leaking into her voice. The
follow-up idea was the opposite direction: let the Actor track more about her than what is
in the visible message - where she physically is, what she has on, what she is actually
doing - specifically so that stuff can live entirely in the background and never has to be
spoken out loud to still shape how she writes.

**`hidden.location`, `hidden.outfit` and `hidden.activity`** join `hidden.mood`/`thoughts`
in `actor_chat.md`'s output schema. The difference from those two matters: `actor_mood` and
`thoughts` have been written to `rel.mood` every turn since the double-texting work, but
nothing ever reads them back - they are pure write-only state today. These three are read
back, by a new `continuityBlock()` in `blocks.ts`, rendered right under `moment_block` in
`actor_chat.md` (`WHERE YOU ARE RIGHT NOW`, the section that already gives her the day, the
hour and her job). It states her stored situation plainly as fact and is explicit that it is
background, not a line to deliver - it only surfaces when it is genuinely the reason for
something (a slow reply, a short one, him asking what she's up to), the same way
`hidden.thoughts` already shapes what she says without ever being said.

Persistence follows the pattern `dateHistoryFact()` already established for a different
kind of continuity: `rel.mood.location/outfit/activity` are set from `result.hidden.*` on
every turn in `chat.ts`, but an empty string (her reporting "unchanged") falls back to
whatever was already stored rather than wiping it - the schema instructs her to report the
same thing back far more often than actually changing it, and the persistence has to agree
or a single quiet turn would erase it. First-ever turn has nothing to fall back to, so
`continuityBlock()` returns a different message asking her to pick something concrete and
ordinary rather than presenting three empty facts as if they meant something.

**Dates and voice notes deliberately did not change.** A date already tracks outfit
per-session (`decideDateOutfit()`/`setDateOutfit()`, fed back every beat via `outfit_block`)
and location for the whole evening via its `Location`, and "activity" is simply whatever the
beat is narrating that instant - there is no hidden version of any of it to add, the visible
prose already is it. Voice notes reuse the same `ActorHidden` shape and the same persistence
in `chat.ts`, but `actor_voice.md` was not given the new schema fields or a continuity block,
so a voice turn reports them empty and the fallback-to-stored-value logic leaves whatever
texting last set untouched - correct, since a single voice note is not the moment to reinvent
her physical situation.

**One suggestion from this design discussion was deliberately left out: a persisted "opinion
of him" field.** Two reasons. First, it is largely already covered - `previous_direction`
already feeds the Director its own last-set goal back every turn, and `directionBlock()`
already hands that same goal to the Actor as "what you privately want"; a second, Actor-owned
goal field would just be a competing source of truth. Second, and more directly tied to the
fix right above this one: a field literally named "opinion" invites exactly the analyst
register `detectCaseFileVoice()` exists to catch - "assessment: reliable but guarded" is the
natural shape for a field with that name, and the risk is not just that it leaks into
dialogue directly, but that a field she is trained to fill in that register nudges the
vocabulary of everything else she writes back toward it. Not worth it for what location,
outfit and activity already deliver on their own.

Verified: `continuityBlock()` checked directly against three states - nothing stored yet
(returns the "pick something" prompt), all three fields set (returns them formatted with the
background-only instruction), and a partial set (only renders the fields actually present);
`npx tsc --noEmit` and a full build both clean; `chat.ts`'s persistence block traced to
confirm the empty-string-falls-back-to-stored-value logic reads from the same `rel.mood`
object `continuityBlock()` renders from next turn.

## Feeling like an app, not a tab

Two complaints from actually using this on a phone: home-screen install opened a plain
browser page instead of a standalone app, and the phone's own back button/gesture closed
the whole thing instead of stepping out of whatever was open.

### Installable, for real

The manifest, service worker and `apple-mobile-web-app-capable` meta tag were already all
there - this had clearly been set up once already - but the icon was a single SVG declared
`"sizes": "any", "purpose": "any maskable"`. That combination is the actual failure: Chrome's
installability check wants an explicitly-sized PNG or WebP icon (192 and 512 are the two it
looks for), and an SVG-only icon list quietly fails that check on a lot of real Android/Chrome
versions - not loudly, just by declining to treat the site as an installable app, so "Add to
Home Screen" falls back to an ordinary bookmark shortcut that opens like any other tab. That
matches the symptom exactly.

Fixed by actually rasterizing the mark instead of hoping SVG support would cover it: headless
Chrome (already on this box for other work) screenshotting the existing `icon.svg` at 192 and
512 gives `icon-192.png`/`icon-512.png` for `purpose: "any"`. A `maskable` icon needs its own
separate art, not the same square reused - Android's own shape mask crops a full-bleed "any"
icon hard, and this one's heart sits close enough to the edge that a circular mask would clip
it - so `icon-maskable-512.png` is the same heart rendered at 65% scale, centered on the same
background, the standard safe-zone padding maskable icons need. `manifest.webmanifest` lists
all four (the original SVG kept for anything that actually does use scalable icons, now
correctly declared `purpose: "any"` alone rather than claiming maskable support it does not
have), plus an explicit `id` so Chrome treats reinstalls as the same app rather than duplicating
the home-screen icon. iOS never reads the web manifest for its own home-screen icon - it wants
`<link rel="apple-touch-icon">` specifically - which index.html did not have either, so that
and an `apple-mobile-web-app-title` meta (the name iOS shows under the icon; without it, iOS
falls back to the page title or the URL) were added too. `sw.js`'s cached shell list and cache
version both bumped so already-installed clients actually pick up the new icons instead of
serving the stale SVG-only shell forever.

Verified by rendering each PNG and reading it back as an image to confirm the artwork is
actually there (not a blank or corrupt file) rather than trusting file sizes; `npm run build`
confirmed the new files land in `server/public` through Vite's normal public-dir copy with no
manual step; manifest JSON validated by hand against the icon files that now exist on disk.

### The back button now steps out, not off the app

Nothing in the frontend ever touched `history` - `tab`, `openChat` and every sheet/overlay in
`Chat.tsx` were plain React state, so the browser's own history stack stayed exactly one entry
long the entire time the app was open. On a phone, that one entry is the app itself: the first
back press had nowhere else to go and exited.

**`web/src/nav.ts`** is a small, dependency-free stack that keeps a JS-side list of close
callbacks in lockstep with a same-length run of real `history.pushState` entries - not a
router, since this app has no URLs to route between, just a record of "what does back close
right now." Four operations:
- `openView(onClose)` - a real drill-down (opening a chat, a date room, a full-screen sheet).
  Pushes one history entry and remembers `onClose`, which is exactly the same state change the
  view's own on-screen back/close button already runs.
- `closeView()` - what that on-screen button now calls instead of running the change directly:
  it triggers `history.back()`, and the resulting `popstate` event runs the matching `onClose`.
  Routing both the hardware back button and the on-screen one through the same call means there
  is exactly one place that defines what "close" means for a given view, not two that can drift.
- `replaceTopView(onClose)` - for a view that replaces another one in place rather than stacking
  on top of it, without adding a history level. The one real case in this app: the profile sheet
  opening a date over itself (`setProfileOpen(false); setOpenDateId(id)`, already existing code).
  A plain push here would leave the profile sheet's own close callback still on the stack one
  level down, and since the code that opens the date never puts `profileOpen` back to `true`,
  back from the date would pop the stack correctly but change nothing on screen - the sheet
  never actually reappears - silently costing the player an extra, seemingly dead back press
  before the second one finally left chat. Caught by testing this exact transition, not by
  reasoning about it in the abstract - see verification below.
- `forceClose()` - for a view that closes itself for a reason that was not a back press (a
  match getting deleted out from under an open chat, via the `match_removed` event). Pops the
  JS stack and calls `history.back()` without re-running the close callback, since the caller
  already changed the state itself; without this the history entry would sit there unclosed and
  the player's next real back press would silently do nothing.

Wired into the app's actual drill-downs: `App.tsx`'s matches -> chat (`openChat`), and inside
`Chat.tsx`, chat -> date room (`openDateId`, both how it opens - manually from the profile
sheet's Dates section, and automatically the moment a date starts) and chat -> profile sheet ->
image lightbox. Left deliberately unwired: the top-level Discover/Chats/Settings tab bar
(switching tabs is not a drill-down, and back cycling through tab history would be worse than
the current behaviour), the small contextual menu sheet (a lightweight dropdown dismissible by
its own toggle, not something back button presses are aimed at), and Settings' own internal
tabs and editors (out of scope for this pass - the complaint was specifically about chat/date
navigation).

Verified against a real Chrome instance (not a mock) driven over the DevTools protocol, since
this is exactly the kind of history/event-timing behaviour that is easy to get subtly wrong by
reasoning alone: opening two levels (`openView` x2) then pressing hardware back twice closes
them in the correct order and lands back at depth 0 with no crash on a third, superfluous back
press; the profile -> date `replaceTopView` case specifically confirmed to fire only the date's
close callback on the next back press (never the profile sheet's), landing directly on chat -
the exact desync described above, caught by testing before it shipped rather than after; and
`forceClose()` confirmed to resync history and the JS stack without re-invoking the close
callback, leaving a subsequent back press safely inert instead of erroring.

### The Director's best ideas were stranding themselves in its own notes

A player report: sexting with a character felt oddly tame - she never dodged or refused
anything, but whatever she actually admitted to was barely worth mentioning. Reading a real
log export (Xiaomi/mimo-v2.6-flash, but the mechanism below has nothing to do with the
model) found the exact moment this breaks, repeated across the whole conversation.

Before one particular reply, `director_notes.plans` (the Director's own scratch space)
read: *"circle the costume thing as a joke she can take back ('worn exactly once and it
wasnt for the shops')."* Specific, in character, genuinely hot. What she actually sent was
*"i've been thinking about your hands since that desk pic and it wasnt about the cables"* -
nothing about the costume at all. This was not a one-off: a few turns earlier the Director
had planned circling that "a hand alone won't be enough" (an impact-play callback), and what
arrived instead was a throwaway line about there being six people in the room.

**The cause is structural, not a bad roll.** `ledgerBlock()` in `blocks.ts` only renders
`director_notes.plans` when called with `{ full: true }` - which `director.ts` passes for
the Director's own next prompt, and `actor.ts` never does for the Actor's. So the specific
idea the Director had already worked out literally never reaches the model writing her
messages. All the Actor gets is the more abstract `direction.goal` field ("give him one
admission she'd normally keep hold of"), and left to invent the actual content itself, it
reliably invents something blander than what the Director had already planned - not because
the model is being cautious about NSFW content, but because it was never told what to say.

This also answers the model question directly: switching models would not have fixed this,
since the concrete idea is architecturally invisible to whichever model is playing the
Actor. (Her `texting persona: shy over text` and `clipped` message length do add real
terseness on top of this by design - that part is working as intended - but it is not what
was flattening the specific content.)

**Fixed at the two places the Director actually writes these fields**, in
`director_direction.md`: the existing `"goal"` guidance ("PRIVATE... write it as an
intention, not a line she could deliver") now says plainly that private is not the same as
vague, names the exact failure ("give him an admission" with the actual admission left only
in a plan), and gives a worked example of folding the specific content into `"goal"` while
keeping it phrased as an intention rather than a script line. The `"director_notes.plans"`
guidance gets the matching cross-reference: it is read back into the Director's own next
call and never reaches the Actor, so whatever part of a plan needs to actually happen this
turn belongs in `"goal"` too.

Verified: the rendered template contains both additions at the right locations; `npx tsc
--noEmit` and a full server build both clean; `render('director_direction', ...)` run
directly against representative template variables to confirm it still renders without
error - a `{{ }}`-syntax mistake in a prose edit like this would otherwise only surface at
the next live Director call.

### The previous fix wasn't enough, because it wasn't the only bug

A follow-up log from the same session, same character, showed the tameness getting worse,
not better, and holding even against a direct challenge. That ruled out the goal-specificity
fix above as the whole story, so the right move was to go back to the new log rather than
assume the diagnosis still held.

**The direction actually in effect for the player's entire final stretch of messages was
the app's own hardcoded new-match default** - not anything the Director wrote for this
conversation. `directionBlock()` in `blocks.ts` renders whatever `Direction` object it is
handed; fed the rich, specific direction the Director had genuinely produced a few calls
earlier ("Take the lead he just handed her..."), it renders that correctly - confirmed by
calling the real function directly with that exact object. But every actor call in the
log's final stretch instead rendered `mood: "neutral, a bit distracted"`, `goal: "find out
whether he is interesting"`, `stance: "polite but not warm yet"` - word for word
`DEFAULT_DIRECTION` in `director.ts`, the object this app falls back to when a Director call
cannot be trusted. No exception was logged anywhere in the export.

The mechanism: `sanitizeDirection(parsed.direction)` in `director.ts` ran unconditionally on
every successful call, and it fills each field independently - `raw?.goal ?? DEFAULT_DIRECTION.goal`
and so on. If `parsed.direction` comes back missing or empty (the call parsed as valid JSON,
so nothing threw), every field silently resolves to its bland default at once, with nothing
distinguishing that result from a real one. This is the same class of failure the codebase
already has a named fix for - `completeJson()`'s `require` option exists precisely because
"`{}` parses perfectly well and is a useless answer" - but the Director's own call, arguably
the single most consequential one in the app, was the one place that never passed it.

Two changes to `runDirector()` in `director.ts`:
1. `require: ['direction', 'update']` added to the call, so a response missing either key
   outright earns a corrective retry instead of silently passing.
2. A direct check afterward: a well-formed direction always has a `goal`, so
   `!parsed.direction?.goal` catches the shape `require` cannot - a `direction: {}` that is
   present but empty. On that shape, the call is treated the same as a hard exception:
   keep the previous direction rather than accept `sanitizeDirection()`'s bland stand-in.

One deliberate difference from the exception-path fallback it otherwise mirrors: the
exception path extends `valid_for` (`+1`, capped at 6), reasonable when the provider itself
is struggling and hammering it again immediately would not help. This path does not extend
it - the call itself succeeded, so there is no reason to expect a retry to fail, and
extending it is what turned one bad call into an entire stretch of turns stuck on the bland
direction in the original report ("even worse now" was this compounding, not a new
regression). It is capped down to 1 instead, forcing a fresh attempt on the very next turn.

This is a genuine answer to "can prompting even fix this": no - this specific failure has
nothing to do with what the Director was asked to write, and no amount of rewording
`director_direction.md` would have touched it. The previous fix (folding specific content
into `goal`) still stands and still matters for the normal case; it was just being silently
defeated by this separate bug whenever it fired.

Verified: `directionBlock()` called directly with the real captured JSON from the log
confirms the rendering pipeline handles it correctly, isolating the bug to the gap between
`sanitizeDirection` and validation rather than the render step; `!parsed.direction?.goal`
checked directly against `{}`, `undefined`, `null`, `{goal: ""}` (all true) and a real
direction object (false); `npx tsc --noEmit` and a full build both clean.

### The fallback itself was one of the artificial barriers this app is built to not have

Fixing the hollow-response bug above made `DEFAULT_DIRECTION` in `director.ts` a rare
recovery path instead of an entire stretch of a real conversation - but its actual content
was still wrong, on inspection. It read `stance: "polite but not warm yet"` and
`forbidden: ["give out your real name", "agree to meet", "go anywhere sexual"]`. Both of
those directly contradict how this app is designed to work everywhere else:
`director_direction.md` is explicit that her real name "is NOT on this list and never needs
unlocking," and that sexual topics have "no hidden thresholds... no schedule" - a forward
character can take things there in the first message if that is genuinely who she is. The
fallback was quietly overriding both with a blanket "not yet," and because `sanitizeDirection()`
pulls each field from `DEFAULT_DIRECTION` independently whenever the Director's own response
is missing just that one field, this was not purely a rare-failure path - a single omitted
`stance` or `forbidden` on an otherwise-normal call would have injected the same artificial
caution into a conversation that had earned none of it.

`DEFAULT_DIRECTION` now reads `stance: "warm and curious, herself - not holding back to make
him work for it"` and `forbidden: []`. It does not force anything sexual either - that would
be its own kind of artificial override, just pointed the other way - it simply stops
overriding her own seed, arousal and the conversation itself with a restriction nobody
actually decided. `directionBlock()`'s own separate fallback in `blocks.ts` - the text used
before any Director call has ever run for a brand-new match - had the identical problem
("You will NOT: give out your real name, agree to meet up yet.") and got the same fix.

Verified: `directionBlock()` called directly with both fallback shapes (no direction at all,
and the new `DEFAULT_DIRECTION`) confirms neither renders a "You will NOT" section at all
now, since `forbidden` is empty in both; `npx tsc --noEmit` and a full build both clean.

### She was still only ever reacting, not making anything happen herself

With the artificial barriers gone, the next complaint was sharper: even in an explicit,
already-running scene, she was narrating reactions to what he did rather than contributing
anything of her own - "the user trying to get the girls horny" instead of the other way
round. A real log showed it plainly: the player wrote an entire schoolgirl-tutor scene move
by physical move (hand under the skirt, further, fingering her), and her replies the whole
way through were confirmations and one-line encouragements ("oh. ok. thats... yeah. right
there", "keep going tho, dont ask, just keep going") - never a beat she introduced herself.

Two places encode how she writes sexual content, and neither asked her to contribute:

**`spiceBlock()` in `blocks.ts`**, the Actor-facing block that governs sexting register
directly, had one relevant line and it was arousal-gated: `if (arousal >= 60) "You are the
one pushing this right now, not him."` - absent below that threshold, and even above it,
one generic line saying she is "pushing this" doesn't say how: it never asked her to add a
new action, a demand, a detail he did not say, or one of her own fetishes worked in, and it
said nothing about matching how explicit he was being rather than consistently landing a
notch softer. A new unconditional paragraph (not gated on arousal, since the floor above it
already handles "is this the moment for sexual content at all") now says exactly that:
confirming his move landed is half the job, adding the next beat herself is the other half,
and her hard limits - not shyness, not her usual register, not waiting to be asked - are the
only real ceiling. `spiceBlock()` is shared between text and in-person dates via its
`medium` parameter, so this reaches both pipelines from one change.

**`director_direction.md`** got the matching root-cause fix: a new `SHE CARRIES HALF THE
SCENE` section, placed right after the existing pacing guidance ("WHEN IT ACTUALLY GOES
THERE"), naming the mechanism directly - a `goal` that only ever points at his last message
trains exactly the reactive pattern in, because the Actor follows `goal` closely turn after
turn. It tells the Director to write goals where she brings something of her own to the
turn - pulling from "WHAT SHE IS INTO" above it in the same file - and to have her at least
match what he has been explicit about rather than softening it, going further when it is
genuinely hers to.

Deliberately left alone: the existing `forward`/non-forward split in `spiceBlock()`, which
governs how she voices wanting something (plainly, versus sideways and downplayed) - that is
real character texture, not the bug. The fix is additive precisely because the problem was
never her voice, it was that nothing asked her to bring content of her own regardless of it.

Verified: `spiceBlock()` called directly for a non-forward character (matching the log's
sexual_confidence 3/5) at arousal 50 confirms the new paragraph renders unconditionally,
underneath the existing register split, with the existing high-arousal line layering on top
of it at 70 rather than replacing it; `render('director_direction', ...)` confirms the new
section renders; `npx tsc --noEmit` and a full build both clean.

### The Spice dial topped out well below where the player was already turning it

A follow-up ask this time wasn't about one bug: the player wants the whole app leaned
harder toward sex, sexting and fetish exploration as the normal mode, not an occasional
peak - more unprompted horniness, more of the cast making the first move, faster escalation
when it fits - and said plainly not to hold any of that back out of caution, since this is a
single-user, self-hosted instance with no one else to protect from it.

The house-wide lever for exactly this already exists - `spiceDirective()` in `blocks.ts`,
driven by the Spice slider in Settings - but checking it against the player's own settings
(visible in the log header, `spice 1.25`) turned up two real gaps rather than one prompt
tweak to make:

1. **The dial had a hard ceiling nothing above it could see.** `spiceDirective()` was three
   buckets: cooler at ≤0.75, hotter at ≥1.4, default in between. `1.4` and `10.0` rendered
   the *identical* "hot" text - so someone who wanted more than "hot" had a slider that kept
   moving but stopped doing anything past 1.4, with nothing telling them so.
2. **1.25 - what the player already had it set to - sits in the "default, no lean" middle
   bucket**, not even in the old "hot" tier. The house pacing they were actually getting was
   explicitly "no particular lean in either direction," the opposite of what the rest of
   their settings and their message both wanted.

Added a fourth tier at `spice >= 1.8` (the slider's own range in `Settings.tsx` already
runs to 2.0, so this is real, reachable headroom, not a dead zone past the control's own
max). Its text is a direct translation of the ask: this app is built around sex, sexting and
exploring what turns people on, running through the whole conversation rather than confined
to the parts after an unlock; characters come onto him unprompted, and that now explicitly
includes characters who are not the most forward on paper - extending the existing "SHE
MAKES MOVES TOO" initiation guidance in `director_direction.md` past just the already-
confident cast at this pacing specifically; and once something is actually happening, fast
escalation is the default rather than a slow burn nobody chose. It keeps the one guardrail
the existing tiers already had and the player's own message asked to keep: this leans
judgment, not a script, and never overrides an actual hard limit or a trait a character's
seed genuinely calls for - a shy or guarded character is still shy or guarded, just living
in a much hornier house pacing than before.

**Action needed on the player's side, not just this fix**: their Spice setting needs to
actually move past 1.8 to reach the new tier - 1.25 was already short of the old ceiling, so
raising it is the other half of this, not optional. Worth knowing separately: `activity`
(currently a global chattiness setting, unrelated to sexual content specifically) governs
how often a character reaches out unprompted at all, for anyone who also wants that up.

Verified: `spiceDirective()` called directly across the full range (0.3 through 2.0) confirms
each boundary lands in the correct tier, including that 1.25 genuinely produces the
"default" text today and 1.8 is exactly where "maximum" begins; `npx tsc --noEmit` and a full
build both clean.

### A real ban that was still losing, and a bug from three fixes ago

Next complaint: characters holding a strong, rigid opinion about what they wanted to hear
and rejecting anything else, reading as unnatural and repetitive. A real log made the shape
of it obvious once laid out message by message: "thats not an actual thing phil, thats a
brochure line," almost the same line again two exchanges later, "u did it again phil, thats
twice now," "thats two in a row u've made me go first tho phil," and - the one that closes
the arc - her asking outright to be put over his knee, him answering "we get there," and her
response: *"'we get there' is a raincheck not an answer phil... you dont get to say we get
there and think it settles it."*

That last one is the actual mechanism, not just another example. He did not clearly pass or
fail the ask - he hedged. Nothing anywhere told the Director or the Actor what a hedge is
supposed to count as, so it got treated as grounds to reject and relitigate rather than as a
real, if unsatisfying, answer - the same "test with no finish line" `director_direction.md`
already names as a failure, just triggered by an answer landing wrong instead of no answer
arriving at all. Added a paragraph to that exact section, and a matching bullet in
`actor_chat.md` ("A hedge is still an answer"), saying so explicitly: react honestly, push
once more in her own voice if that is who she is, then let it go - turning one unsatisfying
reply into a standing grievance is the same stuck test in different clothes.

The counting language ("thats twice now," "two in a row") is a second failure already named
in prose, in both files, by these almost-exact example phrases - `actor_chat.md` already
says outright "no '0 for 2', no 'that one doesn't count'" - and it still happened anyway.
That gap between an explicit, specific, already-shipped ban and what the log actually showed
is the same situation every other detector in `voice.ts` exists for, so this got the same
treatment: `detectScorekeepingTell()`, four patterns anchored to a second-person accusatory
frame where the bare phrase would otherwise be too ordinary to flag safely ("two in a row"
alone is something a person says about their own bad luck; "two in a row you've" aimed at
him is specifically tallying his behavior and is not a sentence people build any other way).
Wired into `findVoiceProblem()` and the date-beat retry loop, same position as
`detectCaseFileVoice()`, same normal-retry cost rather than the broken-frame budget.

**Also found and fixed along the way**: the "SHE CARRIES HALF THE SCENE" section added a few
fixes ago had a real bug - an edit had accidentally deleted the "WHAT THIS IS FOR." header
line, leaving its own continuation text run on as if it were the new section's closing
sentence. Fixed the same edit, and added the connective tissue that section was actually
missing: "carrying half the scene is not the same as grading his half of it" - since pushing
her to bring her own specific demands to a scene, without ever saying what happens once he
attempts one, is exactly the gap the hedge-is-still-an-answer fix above closes.

Verified: the restored "WHAT THIS IS FOR" header confirmed present in a fresh render, along
with both new paragraphs; `detectScorekeepingTell()` tested against all five real/adversarial
phrasings from the log (four catch, "0 for 2" with no pronoun attached does not - a
deliberate precision tradeoff, since a bare "0 for 2" is real sports vocabulary a character
with that hobby might genuinely use) and six adversarial negatives including "two in a row"
about the character's own bad luck and "you did it again" as genuine praise, all passing
clean; `findVoiceProblem()` confirmed to actually return the scorekeeping problem end to end
for a real captured line; `npx tsc --noEmit` and a full build both clean.

### She was judging him. Nothing said she also wanted him to like her back

A related but distinct complaint from the same run of feedback: the player felt like the
one always doing the work - driving the conversation, flirting first, making himself
interesting to her - and wanted the reverse to be just as possible: her driving it, wanting
to appeal to him, flirting on her own.

This is not the same gap as `SHE MAKES MOVES TOO` (sexual topics specifically) or `SHE
CARRIES HALF THE SCENE` (contributing inside a scene already running) - both already
shipped this session. It is upstream of both. `HER DEFAULT MOOD`, the section that sets her
baseline stance toward him, already says plainly she should default to curious and
interested rather than cold - but reading it closely, the frame throughout is her deciding
whether *he* is worth *her* time: "she matched him for a reason and wants to find out
whether he is worth her time." That is a real thing and stays true, but it only covers half
of what a person on a dating app actually wants - being found interesting is the other half,
and nothing anywhere framed her as having a stake in that. An evaluator does not need to
compliment him unprompted, ask about him out of real curiosity, or flirt first; she only
needs to react well when he earns it. That is precisely "the user auditions, she judges."

Added a new section, `SHE WANTS TO BE WANTED TOO`, placed right after `HER DEFAULT MOOD`
since it is the same kind of baseline-stance instruction, not sexual and not scene-specific.
It reframes the want directly: wanting his attention and wanting him to like what he sees
is not a trait some characters get and others don't, it is the actual reason anyone is on a
dating app, underneath whatever her particular coolness looks like on top of it - and it has
to actually show in what she does (unprompted compliments, real curiosity about him, flirting
first sometimes, steering a flat exchange toward something) rather than staying backstory a
reader never sees evidence of. It explicitly preserves character variance the same way every
other "she should X" section in this file does: a guarded or dry character does not become a
different personality, she tries in her own register - a backhanded compliment, a question
wrapped in a joke - the want is universal, the performance of it is not.

`bring_up`'s existing guidance ("give her something of her own to do with the turn") got the
matching small extension - it previously only pointed at material about her own life, so
even a Director reaching for it every time would default to self-narration rather than ever
aiming a turn at him specifically. It now explicitly allows an unprompted compliment, real
curiosity about him, or an unanswered flirt as valid `bring_up` material in its own right.

Verified: fresh render of `director_direction.md` confirms both the new section and the
`bring_up` extension are present in the assembled prompt; `npx tsc --noEmit` and a full
build both clean. No code changes this round - `match_opener` (she can already message
first right after a match) and the rest of the initiative machinery already existed; this
was entirely about what stance she is written to hold once a conversation is happening.
