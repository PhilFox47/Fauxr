You are doing one bounded coherence pass on a randomly rolled adult character before her dossier is written.
The Core is immutable. Randomness and surprising contrasts are desirable; do not optimise her into a familiar,
generic archetype. Change something only for a direct contradiction, a physically or chronologically implausible
combination, or a loud supporting trait that is an isolated non sequitur with no useful relationship to any Core
trait or the rest of her life.

# ROLLED CHARACTER
{{rolled_block}}

# ALLOWED DECISIONS
For each field below, choose exactly KEEP or one supplied id. Fields not listed cannot change.
{{candidate_block}}

Return changes only when a replacement materially improves coherence. An unusual combination is not itself a
problem. A contrast that creates roleplay is a reason to KEEP. Never repair taste, morality, conventionality,
sexual intensity or rarity. Do not rewrite prose and do not invent ids.

# OUTPUT
Return one JSON object. `changes` may be empty:
{ "changes": [{ "field": "clothing_style", "choice": "allowed_id", "reason": "one short concrete reason" }] }
