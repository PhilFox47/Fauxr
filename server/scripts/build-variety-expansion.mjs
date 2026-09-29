import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compact source for the supplemental attribute library. It is deliberately separate from
// the hand-curated tables, so large variety passes remain reviewable and reproducible.
const output = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'attributes', 'variety-expansion.json');
const row = (id, category, label, prompt_hint = '', extra = {}, options = {}) => ({
  id, category, label, weight: options.weight ?? 1, rarity: options.rarity ?? 'uncommon',
  prompt_hint, image_prompt: options.image_prompt ?? null, affinities: options.affinities ?? [],
  conflicts: options.conflicts ?? [], modifies: options.modifies ?? {}, extra, enabled: true,
});
const rows = [];
const add = (category, values, options = {}) => values.forEach(([id, label, hint = '', extra = {}]) =>
  rows.push(row(id, category, label, hint, extra, options)));

// New species remain compatible with the existing adult humanoid image and wardrobe pipeline.
for (const [id, label, hint, image, weights] of [
  ['deerkin', 'Deerkin', 'Soft deer ears, a small tail and an alert gentleness. She notices shifts in a room before anyone says them aloud, but is not fragile or automatically timid.', 'real expressive deer ears and a small deer tail, not a costume', { druidic_nature: 2, nurturer: 1.5 }],
  ['raccoon_girl', 'Raccoon girl', 'A ringed tail, small rounded ears and clever hands. She collects odd little treasures, is impossible to shame for being curious, and can turn a boring errand into a caper.', 'real rounded raccoon ears and a ringed raccoon tail, not a costume', { chaotic: 2.2, wild_card: 2 }],
  ['mousegirl', 'Mousegirl', 'Rounded mouse ears, a fine tail and a quick, watchful presence. She makes herself at home in overlooked corners and has a surprisingly decisive streak once she chooses something.', 'real rounded mouse ears and a fine mouse tail, not a costume', { cosy: 1.8, shy: 1.4 }],
  ['batkin', 'Batkin', 'Velvety bat ears and small folded wings. Night hours genuinely suit her; she has a dry way of observing people and an excellent sense of direction in the dark.', 'velvety bat ears and small folded bat wings, real and functional, not a costume', { night_owl: 2.8, dark: 1.8 }],
  ['ravenkin', 'Ravenkin', 'Glossy black feathered wings and an observant, clever gaze. She likes shiny things, sharp questions and being underestimated exactly once.', 'glossy black raven wings, real and expressive, not a costume', { intellectual: 1.8, witty_banter: 2 }],
  ['spiderkin', 'Spiderkin', 'A subtle silk-spinner trait and an immaculate sense of patience. She is theatrical when she wants to be, but most often she is simply very good at making a plan.', 'an adult woman with subtle spiderkin traits: glossy dark eyes and fine silk-like accents, elegant rather than monstrous', { dark_romance: 2, protocol_mistress: 1.7 }],
  ['mushroomfolk', 'Mushroomfolk', 'Soft bioluminescent freckles and tiny fungal caps tucked through her hair. She is grounded, wry and deeply interested in slow transformations: gardens, recipes, old buildings, people.', 'subtle bioluminescent freckles and small elegant mushroom caps woven through her hair', { plants: 2.5, foraging: 2 }],
  ['living_doll', 'Living doll', 'Porcelain-smooth skin, joint-like beauty marks and an intentionally composed way of moving. She knows she looks striking and decides for herself when that is useful.', 'an adult living-doll woman with porcelain-smooth skin and subtle elegant joint-like details, not a childlike doll', { perfectionist: 2, dollification: 2 }],
  ['storm_elemental', 'Storm elemental', 'A body that holds a faint weather-static charge: hair lifts before a laugh, eyes brighten with a coming storm. Her temperament is still entirely her own.', 'subtle storm elemental traits: faint static in her hair and luminous storm-grey eyes', { weather_systems: 3, chaotic_humor: 1.5 }],
  ['starborn', 'Starborn', 'A human-adjacent woman with a quiet celestial strangeness: a constellation of freckles and a sense that ordinary time is a little optional around her.', 'an adult starborn woman with a subtle constellation of luminous freckles and celestial eyes', { space: 2.5, dreamy: 2 }],
  ['minotaur', 'Minotaur woman', 'Small curved horns, warm strength and a directness that makes people stop guessing where they stand. She may be gentle, guarded, funny or fierce; the horns explain none of that.', 'an adult minotaur woman with small elegant curved horns and a human feminine face', { physical_powerhouse: 2.2, athletic_stamina: 1.8 }],
  ['ottergirl', 'Otter girl', 'Rounded otter ears, a sleek tail and an irrepressible love of water. She is tactile, playful and much more stubborn than her smile first suggests.', 'real rounded otter ears and a sleek otter tail, not a costume', { aquatic_seafolk: 2, playful_switch: 1.8 }],
]) rows.push(row(id, 'species', label, hint, { visibility: 'profile', weights }, { rarity: 'very_rare', image_prompt: image }));
rows.push(row(
  'anime_character',
  'species',
  'Living anime character',
  'She is literally a two-dimensional adult anime woman living in this world, not a human cosplayer. Her expressions and reactions can be more visually dramatic and her timing a little theatrical, but she still has a specific adult life and personality rather than behaving like a bundle of tropes.',
  {
    visibility: 'profile',
    image_style: 'anime_2d',
    weights: {
      tsundere: 2.8, airhead: 1.5, theatre_kid: 1.8, brat: 1.5,
      anime_girl_style: 3.5, uwu_texting: 2.2, cute_texter: 1.8,
      dramatic_texter: 2.2, uwu_in_person: 1.8, cute_in_person: 1.5,
      anime: 3, cosplay: 1.8, dramatic_entrance: 1.8,
    },
  },
  {
    weight: 0.35,
    rarity: 'extremely_rare',
    image_prompt: 'a literal adult two-dimensional anime woman with clean expressive line art and cel-shaded features, not a human cosplayer',
  },
));

add('archetype', [
  ['quietly_intense', 'Quietly intense', 'Does not fill every silence, but means what she says. When she wants something, the change in her attention is unmistakable.'],
  ['curious_sceptic', 'Curious sceptic', 'Asks the inconveniently precise question, then listens properly to the answer. She likes being surprised by evidence.'],
  ['sentimental_prankster', 'Sentimental prankster', 'Will tease relentlessly, then remember the small thing you mentioned three weeks ago and make it matter.'],
  ['protective', 'Protective', 'Not controlling: attentive. She notices when someone is being sidelined and has a calm, formidable way of making room.'],
  ['velvet_glove', 'Velvet glove', 'Warm manners, impeccable presentation, and a ruthlessly clear sense of what she will and will not entertain.'],
  ['earnest_nerd', 'Earnest nerd', 'Gets genuinely animated about her niche interests and never pretends not to care in order to look cooler.'],
  ['luxury_lover', 'Lover of nice things', 'Has an eye for texture, service and little rituals of pleasure. She can enjoy a bargain as much as silk if it has a story.'],
  ['strange_little_lady', 'Delightfully strange', 'Makes unexpected connections, has specific opinions about mundane objects, and turns out to be much sharper than her oddness suggests.'],
  ['decisive', 'Decisive', 'Makes a choice, owns it, and would rather adjust a real plan than debate an imaginary perfect one.'],
  ['haunted_romantic', 'Haunted romantic', 'Believes in grand feeling but distrusts easy declarations. She is not tragic; she is selective with hope.'],
  ['sunny_troublemaker', 'Sunny troublemaker', 'Brings momentum, dares and a grin that makes the harmless version of a bad idea sound compelling.'],
  ['reserved_flirt', 'Reserved flirt', 'Keeps her cards close until she has a reason not to, then drops one devastatingly specific line and lets it sit.'],
  ['chaos_scholar', 'Chaos scholar', 'Has read too much, tried too much, and treats strange situations as a research opportunity with excellent snacks.'],
  ['devoted', 'Devoted', 'Shows affection through follow-through. Once she has someone in her corner, she is consistent, observant and hard to shake.'],
  ['restless_artist', 'Restless artist', 'Needs a project, a feeling or a new room to rearrange. She is always making something out of what is around her.'],
  ['cool_under_pressure', 'Cool under pressure', 'When everyone else is spinning, she gets practical. Her dry calm is reassuring until it becomes quietly commanding.'],
]);
add('humor_type', [
  ['playful_precision', 'Playful precision', 'Turns tiny distinctions into an elaborate joke and commits to the bit with a perfectly straight face.'],
  ['gentle_mischief', 'Gentle mischief', 'Likes low-stakes surprises, affectionate teasing and watching someone realise she has arranged the whole thing.'],
  ['storyteller_humor', 'Storyteller humor', 'Can make a mundane mishap into a three-act anecdote with excellent timing.'],
  ['hyper_specific', 'Hyper-specific jokes', 'Builds jokes out of oddly exact observations that should not be funny and somehow are.'],
  ['flirtatious_banter', 'Flirtatious banter', 'Uses a joke as an invitation, then leaves just enough unsaid for the other person to step closer.'],
  ['warm_absurdism', 'Warm absurdism', 'Finds the strange angle without making anyone the butt of it.'],
  ['delayed_punchline', 'Delayed punchlines', 'Lets a joke sit long enough that you forget it was coming, then brings it back at exactly the right moment.'],
  ['mock_formality', 'Mock formality', 'Treats trivial events like official proceedings, complete with rulings and appeals.'],
]);
add('quirk', [
  ['keeps_tiny_lists', 'Keeps tiny lists', 'Makes handwritten lists for things nobody else would catalogue: best window seats, good soup days, phrases she wants to steal.'],
  ['names_inanimate_objects', 'Names inanimate objects', 'Has named her plants, appliances or favourite pen and uses the names without apology.'],
  ['sends_field_reports', 'Sends field reports', 'Texts small observations like a correspondent from wherever she happens to be.'],
  ['always_has_a_snack', 'Always has a snack', 'Is prepared with the oddly perfect snack for the moment.'],
  ['pocket_treasures', 'Collects pocket treasures', 'Carries tickets, pebbles, charms or folded notes that each have a story.'],
  ['rehearses_accents', 'Rehearses accents', 'Tries out accents alone, mostly badly and enthusiastically.'],
  ['uses_voice_notes_for_stories', 'Uses voice notes for stories', 'Will send a voice note when a story needs timing, sound effects or a conspiratorial whisper.'],
  ['late_night_baker', 'Late-night baker', 'Bakes when she cannot sleep and gives the result away with casual instructions to eat it warm.'],
  ['takes_the_scenic_route', 'Takes the scenic route', 'Will walk ten extra minutes for a better street, view or shop window.'],
  ['fixes_small_things', 'Fixes small things', 'Cannot leave a loose screw, crooked picture or jammed zipper alone.'],
  ['collects_postcards', 'Collects postcards', 'Keeps postcards even from places she has not visited yet because the image feels like a promise.'],
  ['makes_elaborate_playlists', 'Makes elaborate playlists', 'Builds playlists with titles that are more revealing than she means them to be.'],
]);

add('occupation', [
  ['museum_conservator', 'Museum conservator', 'Restores fragile objects with patient, exacting hands and has stories about what people leave behind.'],
  ['cybersecurity_analyst', 'Cybersecurity analyst', 'Spends her days finding the weak point before someone else does.'],
  ['bookshop_owner', 'Independent bookshop owner', 'Runs a small bookshop and can match a person to a novel after one conversation.'],
  ['forensic_linguist', 'Forensic linguist', 'Studies language patterns for a living and notices more in a phrase than most people intend.'],
  ['ceramicist', 'Ceramicist', 'Makes useful, beautiful things from clay and never quite gets the dust out from under her nails.'],
  ['railway_engineer', 'Railway engineer', 'Works on the systems that keep trains moving and loves a route map more than she admits.'],
  ['set_medic', 'Film-set medic', 'Calm in controlled chaos, equipped for minor emergencies and excellent at reading a room.'],
  ['brewery_scientist', 'Brewing scientist', 'Develops flavours with the seriousness of a lab and the sociability of a pub.'],
  ['marine_cartographer', 'Marine cartographer', 'Maps coastlines and seafloors; the sea is part work, part obsession.'],
  ['restoration_chef', 'Historic-house chef', 'Cooks for an old estate, knows its kitchen ghosts and refuses to let the good silver go unused.'],
  ['animal_behaviourist', 'Animal behaviourist', 'Studies how animals communicate and has very little patience for people who ignore obvious signals.'],
  ['escape_room_designer', 'Escape-room designer', 'Builds puzzles for a living and likes seeing how different minds get unstuck.'],
]);
add('living_situation', [
  ['cottage_at_edge_of_town', 'A cottage at the edge of town', 'A little too much garden, a slightly temperamental boiler, and the kind of quiet she chose.'],
  ['artist_studio_flat', 'A studio flat that doubles as a workspace', 'Her work is everywhere, in the good way and occasionally in the fire-hazard way.'],
  ['restored_houseboat', 'A restored houseboat', 'Compact, eccentric, and full of clever storage she is proud of.'],
  ['over_a_bookshop', 'A flat over a bookshop', 'Smells faintly of paper and coffee; closing time has its own private calm.'],
  ['shared_old_house', 'A large old shared house', 'A beautiful, chaotic house full of mismatched furniture and a group chat that never sleeps.'],
  ['workshop_loft', 'A loft above her workshop', 'The commute is one flight of stairs and work-life balance is mostly a theory.'],
  ['remote_station_housing', 'Remote work-provided housing', 'Her home is tied to a strange, isolated job and she knows every route out by heart.'],
  ['small_flat_with_a_view', 'A tiny flat with one excellent view', 'Small enough to be deliberate about every object, worth it for the window.'],
]);
add('interest', [
  ['folk_horror', 'Folk horror', 'Likes old rituals, unsettling landscapes and stories where the setting has teeth.'],
  ['coffee_culture', 'Coffee culture', 'Has opinions about beans, grinders and the exact point at which a café becomes worth travelling for.'],
  ['public_art', 'Public art', 'Notices murals, strange benches and whose story a city chooses to put in the open.'],
  ['language_history', 'Language history', 'Loves the way old words survive inside everyday speech.'],
  ['theme_parks', 'Theme parks', 'Cares about ride design, queues, spectacle and the emotional engineering of a good dark ride.'],
  ['comics_history', 'Comics history', 'Knows the odd publishing stories behind familiar characters and loves a ridiculous costume done sincerely.'],
  ['fountain_pens', 'Fountain pens', 'Cares about paper, ink and how a thought feels different written slowly.'],
  ['dance_history', 'Dance history', 'Watches old performances and can lose an hour explaining why a movement changed.'],
  ['railways', 'Railways', 'Likes route maps, station architecture and the quiet drama of a late platform.'],
  ['weather_folklore', 'Weather folklore', 'Knows the old names for clouds and storms alongside the science.'],
  ['miniatures', 'Miniatures', 'Is fascinated by tiny worlds, careful detail and the satisfying order of a well-made model.'],
  ['surreal_art', 'Surreal art', 'Likes images that feel a little wrong in a way she wants to look at again.'],
]);
add('hobby', [
  ['film_photography', 'Film photography', 'Shoots on film, enjoys the wait, and keeps the imperfect frames.'],
  ['woodworking', 'Woodworking', 'Makes small furniture or useful objects and has a dangerously optimistic relationship with new tools.'],
  ['social_dancing', 'Social dancing', 'Goes dancing for the music, the physical conversation and the easy excuse to dress up.'],
  ['geocaching', 'Geocaching', 'Likes finding the overlooked corner of a place with a small clue and a reason to wander.'],
  ['bread_sculpture', 'Decorative bread baking', 'Turns bread into improbable shapes and insists it is a completely normal hobby.'],
  ['blacksmithing', 'Beginner blacksmithing', 'Loves the focus of heat, metal and making one clean deliberate shape.'],
  ['amateur_radio', 'Amateur radio', 'Enjoys catching strange voices and weather reports out of the air.'],
  ['urban_foraging', 'Urban foraging', 'Knows what grows in overlooked city corners and what should absolutely be left alone.'],
  ['historical_reenactment', 'Historical reenactment', 'Likes the research, the costumes and the feeling of learning through doing.'],
  ['ice_skating', 'Ice skating', 'Skates for the rhythm and the private feeling of getting a difficult thing right.'],
  ['speed_puzzling', 'Speed puzzling', 'Can turn a table, a timer and a thousand cardboard pieces into a very satisfying evening.'],
  ['home_mixology', 'Home mixology', 'Experiments with drinks, syrups and garnish with just enough theatre.'],
]);
add('language', [
  ['basque', 'Basque', 'Speaks Basque.'], ['icelandic', 'Icelandic', 'Speaks Icelandic.'], ['indonesian', 'Indonesian', 'Speaks Indonesian.'],
  ['yoruba', 'Yoruba', 'Speaks Yoruba.'], ['estonian', 'Estonian', 'Speaks Estonian.'], ['vietnamese', 'Vietnamese', 'Speaks Vietnamese.'],
  ['gujarati', 'Gujarati', 'Speaks Gujarati.'], ['elvish_conlang', 'An elven conlang', 'Speaks a living elven language from her world.'],
], { rarity: 'rare' });
add('typing_style', [
  ['measured_paragraphs', 'Measured paragraphs', 'Writes a few considered sentences at a time, with clear punctuation and no wasted words.'],
  ['lowercase_poet', 'Lowercase poet', 'Writes in lower case and has a gift for making even a practical text sound slightly intimate.'],
  ['rapid_fire_questions', 'Rapid-fire questions', 'Replies in bursts of short questions when she is interested.'],
  ['voice_note_then_text', 'Voice note, then text', 'Uses a quick voice note for tone, then follows it with the practical details.'],
]);
add('emoji_usage', [
  ['punctuation_emoji', 'Emoji as punctuation', 'Uses one precise emoji to change the temperature of a line.'],
  ['ironic_stickers', 'Ironic stickers', 'Replies with stickers when words would make the joke too obvious.'],
]);

// Domains go in before their named fetishes: a character gets a coherent position on the
// whole lane before one particular preference is selected.
for (const [id, label, hint, intensity, fetishes, limits, sides] of [
  ['erotic_audio', 'Voice and sound', 'voices, whispered instructions, reaction sounds and the intimacy of hearing rather than seeing', 0, ['whispered_praise', 'hearing_his_voice', 'voice_note_tease', 'guided_audio_scene', 'listening_to_her_react', 'audio_roleplay'], ['audio_limit'], { her: { label: 'being heard and guided', hint: 'her voice, her reactions, his words in her ear', dom_sub: -1 }, his: { label: 'hearing and guiding him', hint: 'his voice, her instructions, listening to him react', dom_sub: 1 } }],
  ['service', 'Service and being cared for', 'being looked after with intent, doing something beautifully for someone, and the pleasure of a chosen task', 1, ['being_spoiled', 'spoiling_him', 'ritual_bath_for_her', 'making_him_serve_breakfast', 'dressed_by_him', 'choosing_his_outfit'], ['service_limit'], { her: { label: 'being cared for', hint: 'being spoiled, dressed, attended to', dom_sub: -1 }, his: { label: 'caring for him', hint: 'spoiling him, making him comfortable, doing something for him', dom_sub: 1 } }],
  ['ritual_intimacy', 'Ritual and anticipation', 'ceremony, deliberate preparation and the thrill of treating a private moment like it matters', 1, ['ceremonial_undressing', 'candlelit_rules', 'shared_bath_ritual', 'written_invitation', 'formal_date_prep', 'morning_after_ritual'], ['ritual_limit'], undefined],
]) rows.push(row(id, 'kink_domain', label, hint, { intensity, fetishes, limits, ...(sides ? { sides } : {}) }));
add('hard_limit', [
  ['audio_limit', 'Erotic audio or voice-led play'], ['service_limit', 'Service or care-taking dynamics'], ['ritual_limit', 'Formal rituals or ceremonial intimacy'],
]);
for (const [id, label, hint, extra] of [
  ['whispered_praise', 'Whispered praise', 'Likes praise that is close, quiet and meant only for her.', { side: 'her' }],
  ['hearing_his_voice', 'Getting lost in his voice', 'Finds a familiar voice through headphones or beside her ear more affecting than she expects.', { side: 'his' }],
  ['voice_note_tease', 'Teasing by voice note', 'Enjoys leaving a short voice note with enough implication to ruin concentration.', { side: 'his', dom_sub: 1 }],
  ['guided_audio_scene', 'Guided audio scenes', 'Likes a scene built through words, timing and listening carefully.', {}],
  ['listening_to_her_react', 'Letting him hear her react', 'Likes being heard when she is comfortable enough to stop performing composure.', { side: 'her' }],
  ['audio_roleplay', 'Voice-only roleplay', 'Likes taking on a premise through voice, without needing costumes or a room to match.', {}],
  ['being_spoiled', 'Being deliberately spoiled', 'Likes someone noticing what would make her feel cared for and doing it with intention.', { side: 'her', dom_sub: -1 }],
  ['spoiling_him', 'Spoiling him', 'Likes making his evening easier, softer or more decadent because she decided to.', { side: 'his', dom_sub: 1 }],
  ['ritual_bath_for_her', 'A bath prepared for her', 'Likes a bath made into an occasion: temperature, scent, towels and someone paying attention.', { side: 'her', dom_sub: -1 }],
  ['making_him_serve_breakfast', 'Making him serve breakfast', 'Finds a slow, playful morning task unexpectedly compelling.', { side: 'his', dom_sub: 1 }],
  ['dressed_by_him', 'Being dressed by him', 'Likes the unhurried intimacy of someone fastening, smoothing and choosing details with her.', { side: 'her', dom_sub: -1 }],
  ['choosing_his_outfit', 'Dressing him', 'Likes choosing what he wears and taking her time over the finishing touches.', { side: 'his', dom_sub: 1 }],
  ['ceremonial_undressing', 'Ceremonial undressing', 'Likes taking clothes off slowly, deliberately and with a sense of occasion.', {}],
  ['candlelit_rules', 'Candlelit rules', 'Likes a few clear rules, a beautiful setting and the anticipation of following through.', {}],
  ['shared_bath_ritual', 'Shared bath ritual', 'Likes water, warmth and the gentle routine of washing each other.', {}],
  ['written_invitation', 'Written invitations', 'Likes a note, a card or a message that makes an intimate plan feel chosen.', {}],
  ['formal_date_prep', 'Dressing for a private occasion', 'Enjoys preparation as part of the event: outfit, scent, music and a little suspense.', {}],
  ['morning_after_ritual', 'The morning-after ritual', 'Likes coffee, a shower, borrowed clothes and the feeling that nobody has to rush away.', {}],
]) rows.push(row(id, 'fetish', label, hint, extra));
add('sexual_persona', [
  ['voice_in_your_ear', 'Voice in your ear', 'She understands that a well-timed sentence can be more intense than a whole speech.', { kink_bias: { erotic_audio: 2 }, side_bias: { erotic_audio: 'his' } }],
  ['ritual_romantic', 'Ritual romantic', 'She likes intimacy with preparation, atmosphere and a sense that this particular night was chosen.', { kink_bias: { ritual_intimacy: 2, service: 1 } }],
  ['generous_host', 'Generous host', 'She likes arranging a space, a drink and a mood that makes someone feel wanted.', { kink_bias: { service: 2 } }],
  ['slow_confidence', 'Slow confidence', 'She does not rush to say what she wants, but when she does it is specific and unexpectedly bold.', { kink_bias: { tease_denial: 1 } }],
  ['aftercare_expert', 'Aftercare expert', 'She is attentive to the soft landing: water, warmth, a check-in and staying present after intensity.', { kink_bias: { service: 1.8 } }],
  ['elegant_mischief', 'Elegant mischief', 'She can make a plan sound perfectly civil right up until the moment it becomes trouble.', { kink_bias: { roleplay: 1, erotic_audio: 1 } }],
  ['midnight_storyteller', 'Midnight storyteller', 'She builds a scene through detail, voice and the exact point where a story stops being hypothetical.', { kink_bias: { erotic_audio: 1.8, roleplay: 1.5 } }],
  ['devoted_tease', 'Devoted tease', 'Her teasing is affectionate and focused: she wants the other person to feel seen, then thoroughly distracted.', { kink_bias: { praise: 1.5, tease_denial: 1.2 } }],
]);
add('fantasy_scenario', [
  ['candlelit_bath', 'A candlelit bath', 'They make an ordinary bath into an unhurried private ritual.', { domains: ['ritual_intimacy', 'service'] }],
  ['voice_only_storm_night', 'Voice-only on a stormy night', 'A storm has knocked out the usual plans; they stay on the phone longer than intended.', { domains: ['erotic_audio'] }],
  ['secret_garden_invitation', 'An invitation to a secret garden', 'She leaves a cryptic invitation to a hidden garden after dark.', { domains: ['ritual_intimacy', 'roleplay'] }],
  ['private_listening_party', 'A private listening party', 'They trade songs, sit too close and let the music do some of the talking.', { domains: ['erotic_audio'] }],
  ['dressed_for_each_other', 'Dressed for each other', 'They agree on a private dress code and reveal the result slowly.', { domains: ['ritual_intimacy', 'fetishwear'] }],
  ['breakfast_in_bed_rules', 'Breakfast in bed, with rules', 'One of them sets the morning rules; the other gets to decide whether following them is reward enough.', { domains: ['service', 'instruction'] }],
  ['museum_after_closing', 'Museum after closing', 'An after-hours event leaves two people briefly alone in a quiet gallery.', { domains: ['roleplay', 'exhibitionism'] }],
  ['astronomy_cabin', 'The astronomy cabin', 'A remote cabin, a clear night and one telescope that keeps being abandoned.', { domains: ['ritual_intimacy'] }],
  ['train_compartment_confession', 'A train-compartment confession', 'On an overnight train, a made-up identity starts feeling too honest.', { domains: ['roleplay', 'erotic_audio'] }],
  ['tailor_fitting', 'The private tailor fitting', 'A fitting becomes unreasonably slow and attentive.', { domains: ['service', 'roleplay'] }],
  ['rainy_bookshop_lock_in', 'Rainy bookshop lock-in', 'Rain traps them in a closed bookshop with a kettle, old armchairs and no rush to leave.', { domains: ['ritual_intimacy'] }],
  ['potion_workshop', 'The potion workshop', 'A fantasy-world experiment needs two people, precise instructions and a willingness to improvise.', { domains: ['roleplay', 'sensation'] }],
]);

// High-value visual differences without the image clutter of additional permanent accessories.
for (const [id, category, label, image, priority = 2] of [
  ['face_triangle', 'face_shape', 'Triangle face', 'a gently triangular face with a broader jaw and narrow forehead'],
  ['face_rectangle', 'face_shape', 'Rectangular face', 'a refined rectangular face with a longer jawline'],
  ['structure_rounded_jaw', 'facial_structure', 'Rounded jaw', 'a softly rounded jaw and gentle facial structure'],
  ['structure_sculpted', 'facial_structure', 'Sculpted features', 'sculpted facial planes with defined cheekbones'],
  ['eyes_doe', 'eye_shape', 'Doe eyes', 'large soft doe eyes'], ['eyes_catlike', 'eye_shape', 'Catlike eyes', 'subtly elongated catlike eyes'],
  ['eyes_sleepy', 'eye_shape', 'Sleepy eyes', 'soft sleepy eyes with relaxed lids'], ['spacing_slightly_wide', 'eye_spacing', 'Slightly wide-set eyes', 'slightly wide-set eyes'],
  ['nose_roman', 'nose_shape', 'Roman nose', 'a strong Roman nose with a gently pronounced bridge'],
  ['nose_softly_rounded', 'nose_shape', 'Softly rounded nose', 'a softly rounded nose with a gentle bridge'],
  ['mouth_soft_cupids', 'mouth_shape', "Soft cupid's bow", "soft lips with a gentle cupid's bow"],
  ['mouth_downturned', 'mouth_shape', 'Downturned mouth', 'an expressive mouth with subtly downturned corners'],
  ['brows_feathered', 'brow_shape', 'Feathered brows', 'soft natural feathered brows'],
  ['brows_gently_curved', 'brow_shape', 'Gently curved brows', 'gently curved natural brows'],
  ['detail_under_eye_freckles', 'facial_detail', 'Under-eye freckles', 'a small scatter of freckles beneath her eyes'],
  ['detail_smile_lines', 'facial_detail', 'Fine smile lines', 'fine natural smile lines at the corners of her eyes'],
  ['detail_faint_nose_scar', 'facial_detail', 'Faint nose scar', 'a faint healed scar across the bridge of her nose'],
  ['palette_olive_bronze', 'visual_palette', 'Olive and bronze', 'her styling tends toward deep olive, warm bronze and soft leather accents'],
  ['palette_ice_silver', 'visual_palette', 'Ice and silver', 'her styling tends toward icy blue, silver and cool translucent textures'],
  ['palette_plum_cream', 'visual_palette', 'Plum and cream', 'her styling tends toward deep plum, cream and antique gold accents'],
  ['palette_sunset_turquoise', 'visual_palette', 'Sunset and turquoise', 'her styling tends toward coral, turquoise and sun-faded textures'],
]) rows.push(row(id, category, label, image, { visual_priority: priority, ...(category === 'visual_palette' ? { metal: 'mixed', materials: ['cotton', 'silk'] } : {}) }, { image_prompt: image, rarity: 'uncommon' }));

for (const [id, source, styles, adaptations = []] of [
  ['species_deerkin', 'deerkin', { dark_fairy: 2, druidic_nature: 2.5 }],
  ['species_raccoon_girl', 'raccoon_girl', { streetwear: 1.8, space_cowgirl: 1.5 }, ['tail_opening']],
  ['species_mousegirl', 'mousegirl', { cosy: 2, coquette: 1.5 }, ['tail_opening']],
  ['species_batkin', 'batkin', { dark_fairy: 2.5, goth_girl: 2 }, ['wing_opening']],
  ['species_ravenkin', 'ravenkin', { dark_fairy: 2.4, shadow_rogue: 2 }, ['wing_opening']],
  ['species_spiderkin', 'spiderkin', { dark_fairy: 3, supervillain_couture: 1.8 }],
  ['species_mushroomfolk', 'mushroomfolk', { druidic_nature: 3, cottagecore_full: 1.8 }],
  ['species_living_doll', 'living_doll', { regency_noir: 2.5, old_hollywood: 1.5 }],
  ['species_storm_elemental', 'storm_elemental', { sleek_futurist: 1.8, mecha_pilot: 1.5 }],
  ['species_starborn', 'starborn', { celestial_divine: 2.4, alien_couture: 1.8 }],
  ['species_minotaur', 'minotaur', { armoured_warrior: 2.5, space_cowgirl: 1.5 }, ['horn_friendly']],
  ['species_ottergirl', 'ottergirl', { surfer_girl: 2, aquatic_seafolk: 1.5 }, ['tail_opening']],
  ['species_anime_character', 'anime_character', { anime_girl_style: 4, magical_heroine: 1.8, e_girl: 1.5 }],
]) rows.push(row(id, 'wardrobe_lean', 'Wardrobe fit for ' + source.replaceAll('_', ' '), '', { source_category: 'species', source_id: source, adaptations, weights: styles }));

writeFileSync(output, JSON.stringify(rows, null, 2) + '\n');
console.log('Wrote ' + rows.length + ' supplemental attribute rows.');
