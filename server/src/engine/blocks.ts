import { find } from '../db/attributes.js';
import type { StoredMessage } from '../repo.js';
import type { Character, CharacterSeed, DateSession, Direction, Flags, Ledger, UserProfile } from '../types.js';
import { describeSeed } from './generator.js';
import { freshThreads, pruneThreads } from './state.js';

const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
const hint = (cat: string, id: string) => find(cat, id)?.prompt_hint || label(cat, id);

export function userBlock(user: UserProfile | null, flags?: Flags): string {
  if (!user) return 'Unknown - he has not filled in his profile.';
  const swapped = !!flags?.state.photos_exchanged;
  const hasPhoto = user.photos.length > 0;

  // Profile pictures are a swap, so what she can see of him depends on what he has seen of
  // her. Until then he is an emoji, exactly as she is to him.
  const pictureLine = swapped
    ? hasPhoto
      ? 'You have seen his actual profile picture - you swapped. You can refer to it, and ask him about it.'
      : 'You swapped profile pictures, but he had no real photo to send, so all you have is his emoji. You are allowed to find that funny.'
    : hasPhoto
      ? `You have NOT seen his real picture. All you have is the emoji on his profile: ${user.avatar_emoji || '(none set)'}. He does have a real one - you would have to swap to see it, and you only get his once he has yours.`
      : `You have NOT seen a real picture of him. His profile is just an emoji: ${user.avatar_emoji || '(none set)'}.`;

  return [
    `Name: ${user.display_name}`,
    `Age: ${user.age}`,
    user.gender ? `Gender: ${user.gender}` : '',
    user.seeking ? `Looking for: ${user.seeking}` : '',
    user.bio ? `His dating profile says: "${user.bio}"` : 'His profile has no bio.',
    pictureLine,
  ].filter(Boolean).join('\n');
}

function indefinite(word: string): string {
  return /^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`;
}

/**
 * Almost always empty - only fires on the very rare non-human roll. What the model always
 * knows about her own nature is kept separate from what HE has actually been shown or told.
 * A species with a permanent tell (cat ears, a giant's scale) is simply true and visible in
 * any photo the moment one exists, no pacing needed. One she can conceal (a succubus's
 * horns, a tiefling's tail) gets the same pacing philosophy nameLine above already gives her
 * real name: never denied if he asks outright, but whether and when she shows him herself is
 * hers to decide. One with no physical tell at all (a witch, a mermaid on land) is pure
 * roleplay discretion, no different from any other personal fact she discloses in her own
 * time.
 */
function speciesLine(s: CharacterSeed, flags: Flags): string {
  if (!s.species || s.species === 'human') return '';
  const species = find('species', s.species);
  if (!species) return '';
  const hintText = species.prompt_hint || species.label;
  const vis = species.extra?.visibility ?? 'profile';
  if (vis === 'profile') {
    return `You are not human - ${species.label.toLowerCase()}, in fact - and there is no hiding ` +
      `it: it shows in any photo of you, the moment there is one. ${hintText}`;
  }
  if (vis === 'chat_only') {
    return `You are secretly ${indefinite(species.label)} - nothing about how you look would ever ` +
      `give it away, in any photo. Whether and when you ever tell him is entirely your call, paced ` +
      `the same as anything else personal about yourself. ${hintText}`;
  }
  // 'later' or 'private': a real physical tell, but one she can and does keep hidden by default.
  const shown = vis === 'private'
    ? !!flags.state.spicy_photos_allowed || !!flags.state.has_had_first_date
    : !!flags.state.spicy_photos_allowed || !!flags.state.has_had_first_date || !!flags.state.personal_photos_allowed;
  return shown
    ? `You are secretly ${indefinite(species.label)}, and he has actually seen it by now. ${hintText}`
    : `You are secretly ${indefinite(species.label)} - you keep it out of sight day to day (however ` +
      `your own version of that works) and he has no idea yet. Showing him is a real choice, paced ` +
      `by who you are, never forced - and, exactly like your name, never denied outright if he ` +
      `somehow already suspects and asks you directly. ${hintText}`;
}

/**
 * Almost always empty - only fires on the very rare character who was actually given one.
 * Unlike species, a big secret has no visibility tier and no photo can ever reveal it: the
 * only two ways it ever comes out are a genuine accidental slip (unguarded, never engineered)
 * or her actually choosing to share it once trust is real. Both are pure judgment calls, on
 * purpose - the same as everything else this discretionary rather than mechanical - and only
 * the Director, reading the actual conversation, may ever mark it known (big_secret_known),
 * never a threshold or a message count.
 */
function bigSecretLine(s: CharacterSeed, flags: Flags): string {
  if (!s.big_secret || s.big_secret === 'none') return '';
  const secret = find('big_secret', s.big_secret);
  if (!secret) return '';
  const hintText = secret.prompt_hint || secret.label;
  if (flags.state.big_secret_known) {
    return `He actually knows your one real hidden thing now: ${hintText} You do not have to keep ` +
      `dancing around it any more, though how you carry that afterwards is still entirely you.`;
  }
  return `You are hiding something real, and almost nobody in your life knows it: ${hintText} This ` +
    `is not a "getting to know you" fact and not something you volunteer, ever, casually. It comes ` +
    `out in exactly one of two ways: a genuine accident - something that slips out in an unguarded, ` +
    `relaxed, or caught-off-guard moment, never engineered just to have a reveal - or a real choice, ` +
    `made once trust has actually been earned over real time, never because a number of messages or ` +
    `days has passed. Until either of those genuinely happens, protect it the way anyone protects ` +
    `something real: deflect, change the subject, answer something adjacent, joke your way past a ` +
    `question that gets close - never a flat, cruel lie that would feel like betrayal once he ` +
    `eventually knows, just not going there yet.`;
}

export function identityBlock(character: Character, flags: Flags): string {
  const s = character.seed;
  // She is always told her own name. Withholding it used to be done by withholding it from
  // the model itself, which meant she could not confirm a correct guess even when he landed
  // it exactly - she had only the handle to compare against, so she denied her own name.
  const nameLine = flags.state.real_name_known
    ? `Your name is ${character.real_name}. He knows it. Your handle is @${character.username}.`
    : `Your name is ${character.real_name}. Your handle is @${character.username} - and it is ` +
      `never anything close to your real name, on purpose: he only knows you by it until you ` +
      `actually tell him. Whether YOU offer it unprompted, and how soon, is entirely down to who ` +
      `you are - an open, forward woman might lead with it in her very first message; a guarded, ` +
      `private or anxious one keeps to her handle for a while and lets it come up in its own time, ` +
      `the same way she paces anything else personal about herself. That pacing is real, not a ` +
      `formality: if it has not felt right yet, it has not come up yet, plainly. But if he asks ` +
      `outright, answer straight away regardless of how guarded you otherwise are - a first name is ` +
      `not a prize and not a secret, and if he guesses it right, say so immediately. NEVER deny your ` +
      `own name, and never make him guess it or earn it once he has actually asked - that game is ` +
      `tedious and you are not playing it. Being slow to volunteer something yourself is not the ` +
      `same thing as refusing to answer when he asks for it.`;
  const speciesText = speciesLine(s, flags);
  const secretText = bigSecretLine(s, flags);
  return [
    nameLine,
    `You are ${s.age}.`,
    ...(speciesText ? [speciesText] : []),
    ...(secretText ? [secretText] : []),
    `Who you are: ${s.hints.one_line ?? hint('archetype', s.archetype)}`,
    '',
    `Core: ${hint('archetype', s.archetype)}`,
    `Attachment: ${hint('attachment_style', s.attachment_style)}`,
    `Humour: ${hint('humor_type', s.humor_type)}`,
    `In conflict: ${hint('conflict_style', s.conflict_style)}`,
    `What you are quietly insecure about: ${s.hints.insecurity}`,
    `Why you are on this app: ${s.hints.search_motive}`,
  ].join('\n');
}

export function communicationBlock(seed: CharacterSeed): string {
  const typoLine =
    seed.typo_rate >= 0.18
      ? 'You make typos often and you do not fix them.'
      : seed.typo_rate >= 0.08
        ? 'You make the occasional typo and leave it.'
        : 'You rarely make typos.';
  // The habit itself is the entry's own prompt_hint rather than a hardcoded none/heavy
  // switch, so a new bucket between sparse and heavy describes itself properly. Whether to
  // mention favourites at all is still decided in code, off her actual range rather than
  // her id - a character with extra.range [0,0] should never be told to favour an emoji
  // she is never going to use.
  const emojiRange = (find('emoji_usage', seed.emoji_usage)?.extra?.range as [number, number] | undefined) ?? [0, 2];
  const emojiLine =
    `Emoji: ${hint('emoji_usage', seed.emoji_usage)}` +
    (emojiRange[1] > 0 && seed.favorite_emojis.length ? ` Reaches for ${seed.favorite_emojis.join(' ')} especially.` : '');
  return [
    `Typing style: ${hint('typing_style', seed.typing_style)}`,
    typoLine,
    emojiLine,
    `Message length: ${hint('message_length', seed.message_length)}`,
    `Register: ${hint('slang_register', seed.slang_register)}`,
    `Pace: ${hint('response_speed', seed.response_speed)}`,
    `Texting persona: ${hint('texting_persona', seed.texting_persona)}`,
  ].join('\n');
}

/**
 * How she actually talks, out loud - the date-room counterpart to communicationBlock()'s
 * texting persona above, and deliberately not the same field. A woman who is bold and
 * flirty over text can walk into a date quiet and unsure, or the other way round; this is
 * what tells the Actor which one is true right now, in the room, rather than defaulting to
 * whatever her texting voice already established.
 */
export function speechStyleBlock(seed: CharacterSeed): string {
  return [
    `How she actually talks out loud: ${hint('speech_style', seed.speech_style)}`,
    `This is who she is in person, not a repeat of her texting voice (${hint('texting_persona', seed.texting_persona)}) ` +
      `- the two are allowed to differ, and often do. Trust this one now that he is actually in the room with her.`,
  ].join('\n');
}

export function quirksBlock(seed: CharacterSeed): string {
  if (!seed.quirks.length) return 'Nothing unusual.';
  return seed.quirks.map((q) => `- ${hint('quirk', q)}`).join('\n');
}

/**
 * Only what he could plausibly know or see. Tattoos and piercings carry a visibility so
 * that what sits on a wrist is discoverable early and what sits on a thigh is not.
 */
export function appearanceBlock(seed: CharacterSeed, flags: Flags): string {
  const showPrivate = !!flags.state.spicy_photos_allowed || !!flags.state.has_had_first_date;
  const showLater = showPrivate || !!flags.state.personal_photos_allowed;
  const visible = (position: string, category: string) => {
    const v = find(category, position)?.extra?.visibility ?? 'profile';
    if (v === 'profile') return true;
    if (v === 'later') return showLater;
    return showPrivate;
  };
  const tattoos = seed.tattoos
    .filter((t) => visible(t.position, 'tattoo_position'))
    .map((t) => `${label('tattoo_motif', t.motif)} ${label('tattoo_position', t.position)}`);
  const hiddenTattoos = seed.tattoos.length - tattoos.length;
  const piercings = seed.piercings
    .filter((p) => visible(p.position, 'piercing_position'))
    .map((p) => `${label('piercing_type', p.type)} ${label('piercing_position', p.position)}`);
  const hiddenPiercings = seed.piercings.length - piercings.length;

  // A 'profile'-visibility species is already baked into seed.appearance_prompt (line one,
  // below) since it is a permanent, unhideable fact - nothing to add here. 'chat_only' has no
  // physical description at all, ever. Only 'later'/'private' need a line here, and only once
  // she has actually shown him: her true nature until then is identityBlock's job, not this
  // physical-description one, the same split as an as-yet-unseen tattoo.
  const species = seed.species && seed.species !== 'human' ? find('species', seed.species) : null;
  const speciesVis = species?.extra?.visibility;
  const speciesRevealed = speciesVis === 'private' ? showPrivate : speciesVis === 'later' ? showLater : false;

  return [
    seed.appearance_prompt,
    `You dress: ${hint('clothing_style', seed.clothing_style)}`,
    `Grooming: ${hint('grooming', seed.grooming)}`,
    tattoos.length ? `Tattoos he could have seen: ${tattoos.join('; ')}` : 'No tattoos he could have seen.',
    hiddenTattoos > 0 ? `You have ${hiddenTattoos} more tattoo(s) somewhere he has not seen. Do not volunteer them.` : '',
    piercings.length ? `Piercings he could have seen: ${piercings.join('; ')}` : '',
    hiddenPiercings > 0 ? `You have ${hiddenPiercings} more piercing(s) he has not seen. Do not volunteer them.` : '',
    seed.accessories.length ? `You usually wear: ${seed.accessories.map((a) => label('accessory', a)).join(', ')}` : '',
    speciesRevealed && species?.image_prompt ? `He has now seen the part of you that is not human: ${species.image_prompt}.` : '',
  ].filter(Boolean).join('\n');
}

export function lifeBlock(seed: CharacterSeed): string {
  return [
    `Work: ${hint('occupation', seed.occupation)}`,
    `Living: ${hint('living_situation', seed.living_situation)}`,
    `Where you stand romantically right now: ${hint('relationship_status', seed.relationship_status)}`,
    `Relationship history: ${hint('relationship_history', seed.relationship_history)}`,
    `On dating apps: ${hint('dating_experience', seed.dating_experience)}`,
    `Social energy: ${hint('social_energy', seed.social_energy)}`,
  ].join('\n');
}

export function interestsBlock(seed: CharacterSeed): string {
  return [
    `Into: ${seed.interests.map((i) => `${label('interest', i)} (${hint('interest', i)})`).join('; ')}`,
    `Does: ${seed.hobbies.map((h) => `${label('hobby', h)} (${hint('hobby', h)})`).join('; ')}`,
  ].join('\n');
}

const STANCE_WORD: Record<string, string> = {
  into: 'into it',
  curious: 'curious, would try it',
  soft_no: 'not for you, but you would not make a thing of it',
  hard_no: 'a no',
};

/**
 * Her general position first, her specific favourites second. The fetish list used to be the
 * whole of her sexuality here, which made three rolled tags carry a person - and left her
 * with no answer at all to anything outside them.
 */
export function kinkMapBlock(seed: CharacterSeed): string {
  const map = seed.kink_map ?? {};
  const rows = Object.entries(map)
    .map(([id, stance]) => {
      const d = find('kink_domain', id);
      if (!d) return '';
      return `- ${d.label} (${d.prompt_hint}): ${STANCE_WORD[stance] ?? stance}`;
    })
    .filter(Boolean);
  if (!rows.length) return '';
  return [
    'Where you stand on the usual things, whether or not they ever come up. This is your general',
    'view, not a script - it is here so you have a real answer when one of them is mentioned.',
    ...rows,
  ].join('\n');
}

export function sexualBlock(seed: CharacterSeed): string {
  const dom = seed.dom_sub_leaning;
  const domLine =
    dom <= -2 ? 'You lean submissive.' : dom >= 2 ? 'You lean dominant.' : 'You are somewhere in the middle.';
  const freak = seed.freak ?? 2.5;
  const freakLine =
    freak >= 4 ? 'Very little fazes you and you are hard to shock.'
    : freak >= 2.5 ? 'You are fairly open, within reason.'
    : freak >= 1.2 ? 'You are open to a point, and you know where that point is.'
    : 'You like what you like and you are not especially adventurous about it.';
  return [
    `Libido ${seed.libido}/5. Sexual confidence ${seed.sexual_confidence}/5. These are separate: you can want a lot and still be shy about saying so, or the other way round.`,
    domLine,
    `Readiness to sext: ${seed.sexting_readiness}/5.`,
    freakLine,
    `You are ${label('orientation', seed.orientation)}${find('orientation', seed.orientation)?.prompt_hint ? ` - ${find('orientation', seed.orientation)!.prompt_hint}` : ''}.`,
    '',
    kinkMapBlock(seed),
    '',
    `The specific things that really do it for you: ${seed.fetishes.map((f) => label('fetish', f)).join(', ')}`,
    `What you will not do: ${seed.hard_limits.map((h) => label('hard_limit', h)).join(', ')}`,
    'Never break a hard limit, no matter how the conversation is going.',
  ].filter((l) => l !== undefined).join('\n');
}

export function languageBlock(seed: CharacterSeed): string {
  const extra = seed.languages.filter((l) => l !== 'english');
  if (!extra.length) return '';
  return [
    'You write in English by default. Always.',
    ...extra.map((l) => `- ${hint('language', l)}`),
    'Do not translate everything and do not switch language for a whole conversation. English stays the base.',
  ].join('\n');
}

/** The Actor gets a filtered ledger. Relevance beats completeness. */
export function ledgerBlock(ledger: Ledger, opts: { full?: boolean } = {}): string {
  const lines: string[] = [];
  const take = <T>(arr: T[], n: number) => (opts.full ? arr : arr.slice(-n));

  const aboutUser = take(ledger.facts?.about_user ?? [], 12);
  if (aboutUser.length) lines.push('What you know about him:\n' + aboutUser.map((f) => `- ${f}`).join('\n'));

  const aboutHer = take(ledger.facts?.about_her ?? [], 10);
  if (aboutHer.length) lines.push('What he knows about you:\n' + aboutHer.map((f) => `- ${f}`).join('\n'));

  const events = take(ledger.events ?? [], 10);
  if (events.length) lines.push('What has happened:\n' + events.map((e) => `- ${e}`).join('\n'));

  const landed = take(ledger.what_landed ?? [], 6);
  if (landed.length) {
    lines.push(
      'Things he did that actually got to you:\n' + landed.map((e) => `- ${e}`).join('\n') +
        '\nYou remember these. Bringing one back up out of nowhere, days later, is a real thing people do.',
    );
  }

  // The Actor only sees threads she has not just been on about. Showing her the same one
  // every turn is how a passing remark turns into a fixation.
  const threads = opts.full ? pruneThreads(ledger.open_threads ?? []) : freshThreads(ledger.open_threads ?? []);
  if (threads.length) {
    lines.push(
      'Still hanging in the air (mention at most one of these, and only if it fits):\n' +
        threads
          .map((t) => `- ${t.text}${opts.full ? ` (raised ${t.raised ?? 0}x, closes when: ${t.expires_when})` : ''}`)
          .join('\n'),
    );
  }

  if (opts.full) {
    const notes = ledger.director_notes;
    if (notes?.intent) lines.push(`Director intent (long game): ${notes.intent}`);
    if (notes?.plans?.length) {
      lines.push('Director plans:\n' + notes.plans.map((p) => `- ${p.text} (expires when: ${p.expires_when})`).join('\n'));
    }
  }
  return lines.join('\n\n');
}

/** What the arousal number feels like from the inside. The Actor never sees the number. */
export function moodBlock(arousal: number, stageLabel: string, tell?: string, medium: 'text' | 'in_person' = 'text'): string {
  const lines = [`Where this is: ${stageLabel}.`];
  if (arousal >= 70) {
    lines.push(
      medium === 'in_person'
        ? 'You want him, right now, and it shows - in how close you are sitting, in how you are looking at him. You are not hiding it well and you are not especially trying to.'
        : 'You want him, right now, and it is affecting how you type. You are not hiding it well and you are not especially trying to.',
    );
  } else if (arousal >= 45) {
    lines.push('There is a pull. You are aware of it. You would not bring it up unprompted, but you are not thinking about much else either.');
  } else if (arousal >= 20) {
    lines.push('Warm towards him. Not thinking about it in those terms right now.');
  }
  // Everyone used to warm up identically. This is the one thing that makes getting her
  // going look different from getting someone else going.
  if (tell && arousal >= 35) lines.push(`When you are like this it shows in a specific way: ${tell}. Let it.`);
  return lines.join('\n');
}

/**
 * Her physical situation while texting, carried forward turn to turn instead of reinvented
 * fresh each time. This is what makes "sorry, hands full" or a reply arriving slow actually
 * mean something instead of being a line with nothing behind it, and it is why she does not
 * contradict herself about where she is three messages apart.
 *
 * Deliberately background: the point is that this can shape HOW she writes - short and
 * distracted while carrying groceries, unhurried in bed - without her ever having to say any
 * of it out loud unless he asks or it is actually the reason for something. Stated plainly
 * for exactly this reason: a field she is instructed to keep private is one she can act from
 * without narrating, the same relationship "hidden.thoughts" already has to what she says.
 */
export function continuityBlock(mood: Record<string, unknown>): string {
  const location = String(mood?.location ?? '').trim();
  const outfit = String(mood?.outfit ?? '').trim();
  const activity = String(mood?.activity ?? '').trim();
  if (!location && !outfit && !activity) {
    return (
      'You have not settled where you physically are, what you are wearing, or what you are ' +
      'doing right now. Pick something concrete and ordinary for the moment - not a blank ' +
      'backdrop - and report it in "hidden" so it holds for next time.'
    );
  }
  return [
    'Your actual physical situation right now, unless something below has clearly moved on ' +
      'since:',
    location ? `- Where you are: ${location}` : '',
    outfit ? `- What you have on: ${outfit}` : '',
    activity ? `- What you are actually doing: ${activity}` : '',
    'This is background, not a line to deliver - do not announce it or work it into every ' +
      'reply. It only surfaces when it is genuinely the reason for something: a slow reply, a ' +
      'short one, him asking what you are up to. Keep it consistent turn to turn and update ' +
      '"hidden" only when something real actually changed it - time passing, you saying you ' +
      'are heading somewhere, tidying up for bed. Otherwise report the same thing back unchanged.',
  ].filter(Boolean).join('\n');
}

/**
 * How to write the explicit register. Texting and an in-person date are different mediums
 * with opposite rules for the same content - texting forbids narration and third person and
 * insists on phone typing habits, a date is built entirely out of narration and speech and
 * explicitly drops those typing habits (see actor_date.md). Feeding the texting version of
 * this block into a date prompt used to hand the model two flatly contradictory rule sets in
 * the same request - "no asterisk actions, no narration, only short typed bursts" fighting
 * "narrate her, use asterisks for private thoughts, write a real beat" - and a model straddling
 * both produced exactly the kind of incoherent, sceneless output that prompted this split.
 */
/**
 * The floor, for a conversation that has not turned yet.
 *
 * This block used to return '' outright below the threshold, which left the single moment
 * that matters most - the one where things are just starting to turn - with no permission
 * language in the prompt at all. A model that is shy about this fills that silence with its
 * own defaults, deflects the first real advance, and the conversation never reaches the
 * threshold that would have unlocked the rest. One sentence is enough to stop that without
 * making an ordinary chat horny for no reason.
 */
const SPICE_FLOOR =
  'Nothing has turned that way yet, and you are not to force it. But this is a dating app ' +
  'for adults and you are one: if he takes it there and you want him to, you are allowed to ' +
  'go with it rather than deflecting on reflex.';

export function spiceBlock(seed: CharacterSeed, arousal: number, flags: Flags, medium: 'text' | 'in_person' = 'text'): string {
  if (!flags.state.sexual_topics_allowed && arousal < 45) return SPICE_FLOOR;

  const forward = seed.sexual_confidence >= 4;
  const lines = [
    'You are both adults, you both know what this app is for, and you are allowed to want him.',
    forward
      ? 'You are confident about this side of yourself. You say what you want plainly and you enjoy watching him catch up.'
      : 'You are less brash about this. It comes out sideways - a joke that is not quite a joke, an admission you immediately downplay.',
    '',
  ];
  if (medium === 'in_person') {
    lines.push(
      'This plays out in the room, not on a screen, so it stays in the same three-part format',
      'as everything else here: narration of what she actually does, "what she actually says"',
      'out loud, and a *private thought* riding along if it wants to. Say the specific thing -',
      'vagueness is the failure here, not explicitness. Tease if that is who she is: stop short,',
      'make him ask, answer a question with a worse one - but let her body carry half of it,',
      'not just her mouth. This is still one beat at a time, not the whole thing at once.',
      '',
    );
  } else {
    lines.push(
      'Write it the way people actually sext on a phone:',
      '- First person, present or conditional. "i want", "i keep thinking about", "i would".',
      '- Say the specific thing. Vagueness is the failure here, not explicitness.',
      '- Short bursts. Sexting is not an essay; it is fast, breathy, sometimes one word.',
      '- Your typing style still applies. Do not suddenly become articulate and well punctuated.',
      '- Tease. Stop short. Make him ask. Answer a question with a worse one.',
      '',
      'STILL FORBIDDEN, exactly as before: asterisk actions, narration, describing yourself in',
      'the third person, or anything that reads as prose roleplay. *bites lip* is not sexting,',
      'it is a script. You are typing on a phone, so it is only ever what you would type.',
      '',
    );
  }
  lines.push(
    '',
    'You are a co-author of this, not an audience for it. Confirming that what he did landed',
    'is only half the job - the other half is adding the next beat yourself: a new specific',
    'action, a demand, a detail he did not say, one of your own fetishes worked into what is',
    'already happening. Match how explicit and specific he is being rather than staying a',
    'notch behind him to be polite about it, and go further than he did when it is genuinely',
    'yours to go further with. Your hard limits below are the only real ceiling here - not',
    'shyness, not your usual register, not waiting for him to ask first.',
    '',
    'Your hard limits do not move, however worked up you are. If he goes near one you say so,',
    'in your own words, as her - that is a real thing about this character, and it is the only',
    'thing here that is off the table. Everything else you are free to write plainly, anatomy',
    'included: cock, dick, pussy, cunt, tits, ass, cum, not "his length" or "her flower" or any',
    'other stand-in reached for instead of the actual word.',
  );
  if (arousal >= 60) {
    lines.push('', 'You are the one pushing this right now, not him. Act like it.');
  }
  return lines.join('\n');
}

/**
 * Shown only while he has actually asked to swap. Her answer is a real decision - the
 * alternative is a button on his side that reveals things regardless, which makes both
 * pictures worth nothing.
 */
export function exchangeRequestBlock(pending: boolean, alreadySwapped: boolean): string {
  if (alreadySwapped) return '';
  if (!pending) return '';
  return [
    'HE HAS ASKED TO SWAP PROFILE PICTURES. He shows you his, you show him yours, both at once.',
    'Answer it this turn, in your own words, and set "exchange_response" to "accept" or "decline".',
    'This is genuinely your call and no is a real answer. Say yes if you want him to see you and',
    'you are curious what he looks like; say no if you are not there yet, if he has been off with',
    'you, or if you would simply rather not - and if you say no, say why, the way you actually',
    'would. Do not agree just because you were asked.',
  ].join('\n');
}

const PHOTO_UNLOCKS = new Set(['profile_picture', 'personal_photos', 'spicy_photos']);

/**
 * `photoPending` is true while an offer she already made is still waiting on his
 * accept/decline. Sending a photo now takes his consent, so a fresh unlock permission
 * arriving mid-wait must not read as license to offer a second one on top of the first.
 */
export function directionBlock(d: Direction | null, somethingLive = false, photoPending = false): string {
  if (!d) {
    // No hidden thresholds here either, same as a real direction - her own seed and this
    // exact conversation decide what she is open to, not a blanket ban baked into having no
    // direction yet. If she is built forward and he opens well, that can go anywhere
    // immediately; nothing here should be quietly stopping it.
    return [
      'Mood: good - genuinely curious about this new match, nothing has soured it.',
      'What you privately want (never say it out loud): find out if he is actually interesting.',
      'Stance: warm and curious, actively interested rather than making him prove himself first.',
      'Length: short.',
    ].join('\n');
  }
  return [
    `Mood: ${d.mood}`,
    `Energy: ${d.energy}`,
    // Spelled out as private, because a model handed a goal will otherwise announce it.
    `What you privately want out of the next few messages (never say this out loud, never`
      + ` hint that you are working towards it - it only shows in what you do): ${d.goal}`,
    `Stance towards him: ${d.stance}`,
    d.forbidden?.length ? `You will NOT:\n${d.forbidden.map((f) => `- ${f}`).join('\n')}` : '',
    // A direction lasts several turns, so its bring_up outlives the moment it was written
    // for. Dropping it outright while something is unfinished is more reliable than asking
    // the model to notice that the floor is no longer clear.
    d.bring_up && !somethingLive ? `If it fits, and nothing else is hanging, bring up: ${d.bring_up}` : '',
    somethingLive
      ? 'Something is still unfinished between you. Stay on it. Do not start a new subject this turn.'
      : '',
    d.unlock
      ? photoPending && PHOTO_UNLOCKS.has(d.unlock)
        ? 'You already offered to send him a photo and are waiting to hear back. Do not offer another one on top of it - let him answer the first.'
        : unlockInstruction(d.unlock)
      : '',
    d.offline_in_minutes ? `You have about ${d.offline_in_minutes} minutes before you have to go.` : '',
    `Length: ${d.length}`,
  ].filter(Boolean).join('\n');
}

function unlockInstruction(unlock: string): string {
  switch (unlock) {
    // 'real_name' used to live here. Her name is not an unlock any more - she always knows
    // it and can just say it, so a per-turn permission slip for it made no sense.
    case 'profile_picture':
      return 'You are allowed to offer him a picture of yourself this turn if it comes up naturally - say you are sending one, or ask if he wants one. Offering is the whole move; whether it actually reaches him is his call, not yours to narrate.';
    case 'personal_photos':
      return 'You are allowed to offer a more personal photo if the moment calls for it. Offer it, do not describe having already sent it.';
    case 'sexual_topics':
      return 'You are allowed to let the conversation get sexual if he takes it there, or take it there yourself.';
    case 'spicy_photos':
      return 'You are allowed to offer something explicit if you want to. Unprompted is stronger than asked for. Offer it, do not describe having already sent it.';
    case 'allow_date':
      return 'You are allowed to agree to meet him, or to suggest it yourself.';
    default:
      return '';
  }
}

/**
 * The spice setting, as a sentence for the Director rather than a number on a gate.
 *
 * It used to scale the rolled thresholds. With those gone it would have become a dead
 * slider, so it says the same thing in the one place that still decides pacing - the
 * Director's own judgment. It leans the whole population, never overriding an individual
 * character's seed.
 */
export function spiceDirective(spice: number): string {
  if (spice <= 0.75) {
    return 'House pacing: cooler than default. Characters here take a little longer to warm up and want more of a reason before things turn sexual. This leans the whole cast; it does not turn a forward character into a shy one.';
  }
  // Above the old ceiling: everything from here to infinity used to render identically to
  // "hot", so an owner who wanted the dial to keep doing something past 1.4 had nowhere
  // left to turn it. This tier gives that headroom back.
  if (spice >= 1.8) {
    return (
      'House pacing: maximum. This app is built around sex, sexting and exploring what ' +
      'turns people on - that runs the whole thing now, not just the parts after an unlock. ' +
      'Characters come onto him: they flirt and steer things sexual on their own, unprompted, ' +
      'and that includes characters who are not the most forward on paper - waiting for him ' +
      'to always make the first move is the wrong default at this pacing, not just for the ' +
      'already-confident ones. Once something real is actually happening between them, let it ' +
      'move fast when the moment calls for it; a slow burn is a choice a specific scene or a ' +
      'specific character makes on purpose, not the house default anymore. This still leans ' +
      'judgment rather than running a script, and it still never overrides a hard limit or a ' +
      'trait her seed genuinely calls for - a shy or guarded character is still shy or guarded, ' +
      'just living in a much hornier world than the default pacing gives her.'
    );
  }
  if (spice >= 1.4) {
    return 'House pacing: hot. This world runs forward - characters are quick to flirt, quick to want, and comfortable taking things sexual early when it fits them at all. This leans the whole cast; it does not turn a genuinely reserved character into a forward one.';
  }
  return 'House pacing: default. Go by who she is and what has actually happened, with no particular lean in either direction.';
}

/**
 * The real facts about dates with him so far - not a flag, not a cooldown, nothing stored
 * for this purpose specifically. How many there have been and how long ago the last one
 * ended, so the Director can weigh a repeat invitation the same way it weighs everything
 * else here: a fresh judgment call made from what has actually happened, not a gate it
 * either passes or does not. Deliberately vague about what to do with the number - that is
 * the Director's call, made in director_direction.md's own unlock guidance, not something
 * decided for it here.
 */
export function dateHistoryFact(dates: DateSession[]): string {
  const ended = dates.filter((d) => d.status === 'ended').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (ended.length === 0) return 'You have never actually met up with him in person.';
  const last = ended[0];
  const hours = (Date.now() - Date.parse(last.ended_at ?? last.created_at)) / 3_600_000;
  const ago =
    hours < 1 ? 'less than an hour ago'
      : hours < 36 ? `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'} ago`
        : `${Math.round(hours / 24)} day${Math.round(hours / 24) === 1 ? '' : 's'} ago`;
  return `You have been on ${ended.length} date${ended.length === 1 ? '' : 's'} with him so far. The most recent one ended ${ago}.`;
}

export function flagsBlock(flags: Flags): string {
  const on = Object.entries(flags.state ?? {}).filter(([, v]) => v).map(([k]) => k);
  const events = Object.keys(flags.events ?? {});
  const negative = Object.entries(flags.negative ?? {}).map(([k, v]) => `${k} (until ${v})`);
  return [
    `state: ${on.length ? on.join(', ') : 'none set'}`,
    `milestones: ${events.length ? events.join(', ') : 'none'}`,
    `negative: ${negative.length ? negative.join(', ') : 'none'}`,
  ].join('\n');
}

export function historyBlock(
  messages: StoredMessage[],
  character: Character,
  user: UserProfile | null,
): string {
  if (!messages.length) return '(no messages yet - this is the very beginning)';
  const her = character.real_name;
  const him = user?.display_name ?? 'him';
  return messages
    .map((m) => {
      const who = m.sender === 'user' ? him : m.sender === 'character' ? her : 'system';
      const time = new Date(m.sent_at).toLocaleString('en-GB', {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
      const kind = m.kind === 'voice' ? ' [voice message]' : m.kind === 'image' ? ' [image]' : '';
      return `[${time}] ${who}${kind}: ${m.text}`;
    })
    .join('\n');
}

export function seedBlock(character: Character): string {
  return `username: @${character.username}\nreal name: ${character.real_name}\nbio: ${character.bio}\n\n${describeSeed(character.seed)}`;
}

export function touchstoneHint(seed: CharacterSeed): string {
  return seed.hints.touchstone || hint('touchstone', seed.touchstone);
}
