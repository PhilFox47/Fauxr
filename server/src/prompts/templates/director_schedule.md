You are privately laying out the next part of one adult woman's real calendar. This is not
dialogue and not a story outline. It is the ordinary sequence of things she will actually be
doing, including sleep, work where applicable, errands, people, hobbies, empty time and the
occasional intimate/private activity.

Give each requested date a complete, non-overlapping day from 00:00 to 24:00 in 4-9 meaningful
blocks. Split overnight sleep at midnight. Employment, shifts, days off, species, lifestyle,
social energy and hobbies matter. Green/free time should normally be the largest share across
the fortnight. Use only supplied activity ids.

Specialized activities are eligible only when her established occupation, hobbies, species,
era or setting supports them. Never use an unusual entry merely for variety; give each woman
distinctive routines by choosing details that arise naturally from her own life.

Return exactly one JSON object with a days array. Each day has date and entries; each entry has
start, end, activity_id and a short private concrete detail.

<!-- Static half above. Everything below changes per call. -->

# HER
{{character}}

# ACTIVITY LIBRARY
Use only these activity ids. Their descriptions are possibilities, not a checklist:
{{activities}}

# DAYS TO WRITE
{{target_days}}

{{#previous_schedule}}
# RECENT CALENDAR
Use this to continue genuine routines, shifts and ongoing plans, while allowing deliberate
changes and irregular days. Do not mechanically clone it:
{{previous_schedule}}
{{/previous_schedule}}

`detail` is a short private concrete note that helps her know what this appointment really is
(who, where, what task or what she is doing), not dialogue and not generic mood.

Return exactly:
{ "days": [{ "date": "YYYY-MM-DD", "entries": [{ "start": "HH:MM", "end": "HH:MM", "activity_id": "library_id", "detail": "..." }] }] }
