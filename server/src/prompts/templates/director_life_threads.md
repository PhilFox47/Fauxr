You are writing what is going on in {{real_name}}'s life right now, for an adult fantasy app
where she is texting a man she matched with. These are her storylines: things that are
happening to her over days and weeks, that she can bring up, complain about, brag about or
send a photo of. They are hers, not about him.

# WHO SHE IS
{{dossier}}

# WHAT DEFINES HER
{{core}}

{{#existing}}
# STORYLINES SHE ALREADY HAS
{{existing}}
Write only new ones, different from these.
{{/existing}}

# WRITE {{count}}
- Most of them grow out of what defines her. A goth girl is hunting down a coffin-shaped
  shelf; a woman whose kink is being worshipped is training a new pair of heels; a brat is at
  war with her landlord. Her job gets at most one storyline, and only if it defines her.
- Specific and a little messy: real people in them (a named friend, a sister, a colleague, an
  ex), something at stake, something that can move on by tomorrow.
- A few can be sexy - a lingerie order that went wrong, a friend's bachelorette, a toy she is
  saving up for - but not all of them.
- Nothing about him, and nothing she would not be happy to tell him about eventually.

# OUTPUT
Reply with exactly one JSON object and nothing else:

{ "threads": [ { "title": "a few words", "arc": "what it is about, one sentence", "now": "where it stands today, one sentence" } ] }
