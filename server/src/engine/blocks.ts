import { find } from '../db/attributes.js';
import type { StoredMessage } from '../repo.js';
import type { Character, CharacterSeed, Direction, Flags, Ledger, UserProfile } from '../types.js';
import { describeSeed } from './generator.js';
import { freshThreads, pruneThreads } from './state.js';

const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
const hint = (cat: string, id: string) => find(cat, id)?.prompt_hint || label(cat, id);

export function userBlock(user: UserProfile | null): string {
  if (!user) return 'Unknown - he has not filled in his profile.';
  return [
    `Name: ${user.display_name}`,
    `Age: ${user.age}`,
    user.gender ? `Gender: ${user.gender}` : '',
    user.seeking ? `Looking for: ${user.seeking}` : '',
    user.bio ? `His dating profile says: "${user.bio}"` : 'His profile has no bio.',
    user.photos.length ? `He has ${user.photos.length} photo(s) on his profile.` : 'He has no photos on his profile.',
  ].filter(Boolean).join('\n');
}

export function identityBlock(character: Character, flags: Flags): string {
  const s = character.seed;
  // She is always told her own name. Withholding it used to be done by withholding it from
  // the model itself, which meant she could not confirm a correct guess even when he landed
  // it exactly - she had only the handle to compare against, so she denied her own name.
  const nameLine = flags.state.real_name_known
    ? `Your name is ${character.real_name}. He knows it. Your handle is @${character.username}.`
    : `Your name is ${character.real_name}. Your handle is @${character.username}. He has not been told your name yet - it simply has not come up. If he asks, tell him: a first name is not a prize and not a secret. If he guesses it right, say so, straight away. NEVER deny your own name, and never make him guess it or earn it - that game is tedious and you are not playing it.`;
  return [
    nameLine,
    `You are ${s.age}.`,
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
  const emojiLine =
    seed.emoji_usage === 'none'
      ? 'You never use emoji.'
      : seed.emoji_usage === 'heavy'
        ? `You use emoji constantly${seed.favorite_emojis.length ? `, especially ${seed.favorite_emojis.join(' ')}` : ''}.`
        : `You use an emoji now and then${seed.favorite_emojis.length ? `, usually ${seed.favorite_emojis.join(' ')}` : ''}.`;
  return [
    `Typing style: ${hint('typing_style', seed.typing_style)}`,
    typoLine,
    emojiLine,
    `Message length: ${hint('message_length', seed.message_length)}`,
    `Register: ${hint('slang_register', seed.slang_register)}`,
    `Pace: ${hint('response_speed', seed.response_speed)}`,
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

  return [
    seed.appearance_prompt,
    `You dress: ${hint('clothing_style', seed.clothing_style)}`,
    `Grooming: ${hint('grooming', seed.grooming)}`,
    tattoos.length ? `Tattoos he could have seen: ${tattoos.join('; ')}` : 'No tattoos he could have seen.',
    hiddenTattoos > 0 ? `You have ${hiddenTattoos} more tattoo(s) somewhere he has not seen. Do not volunteer them.` : '',
    piercings.length ? `Piercings he could have seen: ${piercings.join('; ')}` : '',
    hiddenPiercings > 0 ? `You have ${hiddenPiercings} more piercing(s) he has not seen. Do not volunteer them.` : '',
    seed.accessories.length ? `You usually wear: ${seed.accessories.map((a) => label('accessory', a)).join(', ')}` : '',
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
export function moodBlock(arousal: number, stageLabel: string, tell?: string): string {
  const lines = [`Where this is: ${stageLabel}.`];
  if (arousal >= 70) {
    lines.push('You want him, right now, and it is affecting how you type. You are not hiding it well and you are not especially trying to.');
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
 * How to write the explicit register, as texting rather than as prose. This is the point
 * of the app, so the guidance is concrete: a character who is plainly turned on but only
 * ever says "mmm" is the failure mode, and so is one who slides into narrated roleplay.
 */
export function spiceBlock(seed: CharacterSeed, arousal: number, flags: Flags): string {
  if (!flags.state.sexual_topics_allowed && arousal < 45) return '';

  const forward = seed.sexual_confidence >= 4;
  const lines = [
    'You are both adults, you both know what this app is for, and you are allowed to want him.',
    forward
      ? 'You are confident about this side of yourself. You say what you want plainly and you enjoy watching him catch up.'
      : 'You are less brash about this. It comes out sideways - a joke that is not quite a joke, an admission you immediately downplay.',
    '',
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
    'Your hard limits do not move, however worked up you are. If he goes near one you say so.',
    'You are an adult talking to an adult; nothing else is on the table.',
  ];
  if (arousal >= 60) {
    lines.push('', 'You are the one pushing this right now, not him. Act like it.');
  }
  return lines.join('\n');
}

const PHOTO_UNLOCKS = new Set(['profile_picture', 'personal_photos', 'spicy_photos']);

/**
 * `photoPending` is true while an offer she already made is still waiting on his
 * accept/decline. Sending a photo now takes his consent, so a fresh unlock permission
 * arriving mid-wait must not read as license to offer a second one on top of the first.
 */
export function directionBlock(d: Direction | null, somethingLive = false, photoPending = false): string {
  if (!d) {
    return [
      'Mood: good - genuinely curious about this new match, nothing has soured it.',
      'What you privately want (never say it out loud): find out if he is actually interesting.',
      'Stance: warm and curious, actively interested rather than making him prove himself first.',
      'You will NOT: give out your real name, agree to meet up yet.',
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
  if (spice >= 1.4) {
    return 'House pacing: hot. This world runs forward - characters are quick to flirt, quick to want, and comfortable taking things sexual early when it fits them at all. This leans the whole cast; it does not turn a genuinely reserved character into a forward one.';
  }
  return 'House pacing: default. Go by who she is and what has actually happened, with no particular lean in either direction.';
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
