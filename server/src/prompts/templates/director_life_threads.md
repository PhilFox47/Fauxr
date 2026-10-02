You are writing what is going on in {{real_name}}'s life right now, for an adult fantasy app
where she is texting a man she matched with. These are ongoing bits of her life over days and weeks:
things she may complain about, forget about, mention in passing, send a photo of, resolve off-screen
or bring up again later. They belong to her life, not to the match.

# WHO SHE IS
{{dossier}}

# WHAT DEFINES HER
{{core}}

{{#existing}}
# STORYLINES SHE ALREADY HAS
{{existing}}
Write only new ones, genuinely different from these.
{{/existing}}

# WRITE {{count}}

Make the batch feel like one person's real life, not a writers' room generating themed B-plots.

Mix different sources of friction and interest:
- Some threads can grow directly from what defines her: a hobby project, work problem, family pattern,
  subculture, body/style choice, long-term goal or something peculiar to her.
- Some should be ordinary adult life that could happen to almost anyone: a delivery problem, money,
  paperwork, a broken appliance, neighbour friction, a plan changing, an appointment, travel logistics,
  a friend cancelling, family visiting, something she keeps putting off.
- Some can be social: a friend, sibling, colleague, ex, neighbour or acquaintance wants something,
  misunderstands something, invites her somewhere or drags her into a small situation.
- Sexy or dating-adjacent threads are optional. Use them when they genuinely fit her life, not because
  the app is sexual. Do not make every ordinary problem kink-coded.

Her defining traits should influence details and choices, not theme every storyline. A goth woman can
have a boring landlord email. A nurse can have a problem unrelated to the hospital. A kinky woman can
spend a week arguing with a courier. The world does not organise itself around her character sheet.

Do not make every thread quirky, ironic or high-concept. Not every situation needs stakes, a twist, a
rival, a secret or a punchline. A simple unresolved obligation can be useful because real life contains
them. Likewise, not every thread must involve a named supporting character; name somebody when the
relationship matters rather than to manufacture specificity.

When a thread does involve another person, give them an ordinary human motive rather than making them
a prop built to expose one of her traits.

Keep work in proportion. Her job gets at most one new thread in this batch unless the dossier clearly
makes work the centre of her current life.

Each thread must still have movement:
- title: a short practical label, not necessarily a clever headline;
- arc: what the ongoing situation actually is, one sentence;
- now: the concrete current state today, one sentence. It may be unresolved, stalled, mildly annoying,
  unexpectedly good or waiting on someone else.

Do not involve the user. Do not write anything she would be fundamentally unable to tell him eventually.
Do not force a neat resolution; these are raw materials for life continuing around the chat.

# OUTPUT
Reply with exactly one JSON object and nothing else:

{ "threads": [ { "title": "a few words", "arc": "what it is about, one sentence", "now": "where it stands today, one sentence" } ] }
