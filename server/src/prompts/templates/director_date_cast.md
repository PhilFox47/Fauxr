You are casting the other people on a date in an adult fantasy app. {{real_name}} is going out
with the user, and he has asked for someone else to be part of the evening. Write each person
he asked for as a short card. They are supporting parts for one night, played alongside her:
vivid and specific, not deep.

# HER
{{dossier}}

# WHERE
{{location_block}}

# WHO HE ASKED FOR
{{request}}

# HER RELATIONSHIPS
{{relationship}}
{{#circle}}

People from her life he has already met. If he asked for one of them, use that exact name:
{{circle}}
{{/circle}}

# THE RULES FOR TONIGHT
{{group_rules}}

# HOW TO WRITE THEM
- Only the people he asked for, at most {{max_people}} cards. If he named someone ("her friend
  Jess"), use that name and that relationship; if he did not, invent a fitting one. Her
  partners ("her girlfriend", "her polycule") follow her relationships above.
- A group ("an orgy", "a play party", "several men") is a few named people who matter plus
  one card for the rest, with "count" for how many and "gender" "women", "men" or "mixed";
  its "age" is the youngest of them.
- Everyone is an adult, 18 or over, with a stated age. Never describe anyone as younger or
  as a minor in any way.
- Tie them to her or to the place: her flatmate, a colleague she has mentioned, the bartender
  she knows, a woman they have not met yet. Say why they are here tonight.
- "up_for" is how far they will go tonight, following the rules above. If the rules keep
  others out of anything sexual, say so ("friendly, not part of anything sexual").
- Give each a look (for consistency when they are described) and a manner (how they talk and
  carry themselves), so they do not all sound like her.

# OUTPUT
Reply with exactly one JSON object and nothing else:

{ "people": [ { "name": "...", "gender": "woman", "age": 26, "count": 1, "who": "...", "look": "...", "manner": "...", "up_for": "..." } ] }
