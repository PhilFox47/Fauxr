You are describing one picture of a date scene that is happening right now.

# HER
{{real_name}}, {{age}}. How she looks: {{appearance}}
What she has on at this moment: {{wearing}}

# WHERE THEY ARE
{{location_block}}
{{#others}}

# WHO ELSE IS HERE
{{others}}
{{/others}}

# THE SCENE SO FAR (most recent last)
{{history_block}}

# THE TASK
Describe the picture of this exact moment - the end of the scene above - as he sees it with his
own eyes, from where he is. Say, plainly and concretely:
- where she is, in the place and relative to him, and what she is doing this second;
- her face: her expression and where she is looking;
- anyone else in view, where they are and what they are doing;
- how close he is, and anything of his that is in the foreground (his hand on the table, her
  hand on his knee, her on his lap).

Use only what the scene has established. Where it is silent about the room, add one or two
small concrete details of the place. Nothing that has not happened yet, nothing from earlier
that is over. The clothes appear only as far as the moment involves them - a strap slipping, a
skirt pushed up - never as a list. Three to five sentences, present tense.

"shows_face" is false only when her face is genuinely out of his view (she is turned away, her
head is out of frame). "aspect" is "portrait" when the picture is mostly her, "landscape" when
the room and other people matter, "square" otherwise.

Reply with exactly one JSON object and nothing else:
{ "situation": "...", "shows_face": true, "aspect": "portrait" }
