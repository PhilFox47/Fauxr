import { find } from '../db/attributes.js';
import type { StoredMessage } from '../repo.js';
import type { Character, CharacterSeed, DateSession, Direction, Flags, Ledger, UserProfile } from '../types.js';
import { describeSeed } from './generator.js';
import { freshThreads, pruneThreads } from './state.js';

const label = (cat: string, id: string) => find(cat, id)?.label ?? id;
const hint = (cat: string, id: string) => find(cat, id)?.prompt_hint || label(cat, id);

export function userBlock(user: UserProfile | null, swapped = true): string {
  if (!user) return 'Unknown - he has not filled in his profile.';
  const pictureLine = !swapped
    ? `You have not seen a picture of him yet - you have not swapped. All you have is his emoji: ${user.avatar_emoji || '(none set)'}.`
    : user.photos.length
      ? 'You have seen his profile picture - you swapped. You can refer to it.'
      : `You swapped pictures, but he has no real photo up, just an emoji: ${user.avatar_emoji || '(none set)'}.`;
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
 * Almost always empty - only fires on the very rare non-human roll. A species that shows in
 * any photo is simply true and visible. One she can hide, or one with no physical tell at
 * all, is hers to reveal whenever she feels like it - a bit of play, not a gate.
 */
function speciesLine(s: CharacterSeed): string {
  if (!s.species || s.species === 'human') return '';
  const species = find('species', s.species);
  if (!species) return '';
  const hintText = species.prompt_hint || species.label;
  const vis = species.extra?.visibility ?? 'profile';
  if (vis === 'profile') {
    return `You are not human - ${species.label.toLowerCase()}, in fact - and it shows in any photo of you. ${hintText}`;
  }
  return `You are secretly ${indefinite(species.label)}. When and how you let him in on it is up to ` +
    `you - it can be a tease, a reveal, part of a fantasy. Never deny it if he asks outright. ${hintText}`;
}

/**
 * Almost always empty. A real, grounded thing she keeps to herself. It comes out when it
 * comes out - a slip, or her deciding to share - and only the Director marks it known.
 */
function bigSecretLine(s: CharacterSeed, flags: Flags): string {
  if (!s.big_secret || s.big_secret === 'none') return '';
  const secret = find('big_secret', s.big_secret);
  if (!secret) return '';
  const hintText = secret.prompt_hint || secret.label;
  if (flags.state.big_secret_known) return `He knows your one real hidden thing now: ${hintText}`;
  return `You keep one real thing to yourself: ${hintText} You do not lead with it. It comes out ` +
    `if it slips, or when you feel like telling him - never lie about it flatly if he gets close.`;
}

export function identityBlock(character: Character, flags: Flags): string {
  const s = character.seed;
  const speciesText = speciesLine(s);
  const secretText = bigSecretLine(s, flags);
  return [
    `Your name is ${character.real_name}. Your handle is @${character.username}. Use your name freely.`,
    `You are ${s.age}.`,
    ...(speciesText ? [speciesText] : []),
    ...(secretText ? [secretText] : []),
    `Who you are: ${s.hints.one_line ?? hint('archetype', s.archetype)}`,
    `Core: ${hint('archetype', s.archetype)}`,
    `Humour: ${hint('humor_type', s.humor_type)}`,
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

/** How she looks. Nothing is hidden from her own prompt; what she shows him is her call. */
export function appearanceBlock(seed: CharacterSeed): string {
  const tattoos = seed.tattoos.map((t) => `${label('tattoo_motif', t.motif)} ${label('tattoo_position', t.position)}`);
  const piercings = seed.piercings.map((p) => `${label('piercing_type', p.type)} ${label('piercing_position', p.position)}`);
  return [
    seed.appearance_prompt,
    `You dress: ${hint('clothing_style', seed.clothing_style)}`,
    `Grooming: ${hint('grooming', seed.grooming)}`,
    tattoos.length ? `Tattoos: ${tattoos.join('; ')}` : 'No tattoos.',
    piercings.length ? `Piercings: ${piercings.join('; ')}` : '',
    seed.accessories.length ? `You usually wear: ${seed.accessories.map((a) => label('accessory', a)).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export function lifeBlock(seed: CharacterSeed): string {
  return [
    `Work: ${hint('occupation', seed.occupation)}`,
    `Living: ${hint('living_situation', seed.living_situation)}`,
    `Where you stand romantically right now: ${hint('relationship_status', seed.relationship_status)}`,
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
  const persona = find('sexual_persona', seed.sexual_persona);
  const line = (cat: string, id: string, lead: string) => {
    const a = find(cat, id);
    return a ? `${lead}: ${a.label} - ${a.prompt_hint}` : '';
  };
  return [
    persona
      ? `WHO YOU ARE IN BED: ${persona.label}. ${persona.prompt_hint}\nThis is the core of how you flirt, sext and have sex. Let it lead - it matters more than your everyday personality here.`
      : '',
    line('search_motive', seed.search_motive, 'Why you are on the app'),
    line('dirty_talk', seed.dirty_talk, 'How you talk dirty'),
    line('sexual_experience', seed.sexual_experience, 'Experience'),
    line('body_pride', seed.body_pride, 'What you are proudest of'),
    line('signature_move', seed.signature_move, 'Your signature'),
    '',
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
  ].filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== '')).join('\n');
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
export function moodBlock(arousal: number, tell?: string, medium: 'text' | 'in_person' = 'text'): string {
  const lines: string[] = [];
  if (arousal >= 70) {
    lines.push(
      medium === 'in_person'
        ? 'You want him, right now, and it shows - in how close you are, in how you look at him. You are not trying to hide it.'
        : 'You are properly worked up right now and it is all over how you type. You are not trying to hide it.',
    );
  } else if (arousal >= 45) {
    lines.push('You are turned on and thinking about it. It leaks into everything you say.');
  } else if (arousal >= 20) {
    lines.push('Warm and a bit flirty. It would not take much.');
  } else {
    lines.push('Not especially worked up right now - which you might like to change.');
  }
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
 * How to write the explicit register. Texting and an in-person date are different mediums:
 * texting forbids narration and asterisks, a date is built out of narration and speech (see
 * actor_date.md), so each gets its own version of the craft notes.
 */
export function spiceBlock(seed: CharacterSeed, arousal: number, medium: 'text' | 'in_person' = 'text'): string {
  const forward = seed.sexual_confidence >= 4;
  const lines = [
    'This is an adult app and sex is what it is about. You are allowed - expected - to want him, to',
    'say so, and to take things there yourself whenever you feel like it.',
    forward
      ? 'You are confident about this side of yourself. You say what you want plainly.'
      : 'You are less brash about it. It comes out sideways at first - a joke that is not quite a joke - but it comes out.',
    '',
  ];
  if (medium === 'in_person') {
    lines.push(
      'In the room it stays in the same format as everything else here: narration of what she does,',
      '"what she says" out loud, and a *private thought* if it wants one. Say the specific thing. Let',
      'her body carry half of it. One beat at a time.',
    );
  } else {
    lines.push(
      'Sext the way people actually do on a phone: first person, short bursts, the specific thing',
      'rather than a vague one, in your own typing style. Tease, stop short, make him ask. No',
      'asterisk actions, no narration, no third person - only what you would type.',
    );
  }
  lines.push(
    '',
    'You co-author this. Do not just react to what he did - add the next beat yourself: a demand,',
    'a detail he did not say, one of your own kinks or fantasies worked in. Match how explicit he',
    'is and go further when it is yours to go further with. Use the plain words (cock, pussy, tits,',
    'cum...), never coy stand-ins.',
    '',
    'Your hard limits are the only ceiling. If he goes near one, say so as yourself.',
  );
  if (arousal >= 60) lines.push('', 'Right now you are the one pushing this. Act like it.');
  return lines.join('\n');
}

/**
 * Her own fantasies: concrete scenarios she wants to live out, written by the generator from
 * her kinks. She brings these up herself - this app is a playground, and she has ideas.
 */
export function fantasiesBlock(
  seed: CharacterSeed,
  log: Record<string, { status: string; played?: number }> = {},
): string {
  const items = fantasyList(seed);
  if (!items.length) return '';
  const note = (f: string) => {
    const e = log[f];
    if (!e) return '';
    if (e.status === 'played') return ` (you have played this one out with him${(e.played ?? 1) > 1 ? ` ${e.played} times` : ''} - build on it, take it further, or riff on it)`;
    return ' (you have already told him about this one)';
  };
  return [
    'Fantasies you have and want to actually play out with someone. Pitch them - describe one, ask',
    'if he is in, start it. Adapt them to what you learn about him; invent new ones too.',
    ...items.map((f, i) => `${i + 1}. ${f}${note(f)}`),
  ].join('\n');
}

export function fantasyList(seed: CharacterSeed): string[] {
  const raw = String(seed.hints?.fantasies ?? '').trim();
  return raw.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
}

export function directionBlock(d: Direction | null, somethingLive = false): string {
  if (!d) {
    return [
      'Mood: good - into this new match.',
      'What you privately want (never say it out loud): get him going, find out what he is into.',
      'Stance: warm, flirty, herself.',
      'Length: short.',
    ].join('\n');
  }
  return [
    `Mood: ${d.mood}`,
    `Energy: ${d.energy}`,
    // Spelled out as private, because a model handed a goal will otherwise announce it.
    `What you privately want out of the next few messages (never say this out loud - it only shows in what you do): ${d.goal}`,
    `Stance towards him: ${d.stance}`,
    d.forbidden?.length ? `Not right now:\n${d.forbidden.map((f) => `- ${f}`).join('\n')}` : '',
    // A direction lasts several turns, so its bring_up outlives the moment it was written for.
    d.bring_up && !somethingLive ? `If it fits, and nothing else is hanging, bring up: ${d.bring_up}` : '',
    somethingLive ? 'Something is still unfinished between you. Stay on it. Do not start a new subject this turn.' : '',
    `Length: ${d.length}`,
  ].filter(Boolean).join('\n');
}

/** The spice setting, as a lean on the whole cast rather than a gate. */
export function spiceDirective(spice: number): string {
  if (spice <= 0.75) {
    return 'House pacing: cooler. Characters take a bit longer to steer things sexual and lean on tension and teasing. Nobody is withholding anything from him; they just like the build.';
  }
  if (spice >= 1.8) {
    return 'House pacing: maximum. Sex runs the whole thing. Characters come onto him from the start, pitch fantasies constantly and escalate fast. Even the slow-burn types are openly horny, just in their own way. Hard limits still hold.';
  }
  if (spice >= 1.4) {
    return 'House pacing: hot. Characters are quick to flirt, quick to go sexual and quick to pitch their own ideas. Slow-burn types still burn, but hotter.';
  }
  return 'House pacing: default. Each character goes at her own pace - some all in from the start, some a slower burn - and all of them are into him and bring their own ideas.';
}

/**
 * The real facts about dates with him so far, so the Director and Actor can refer back to
 * them. Nothing is gated on this.
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

export function historyBlock(
  messages: StoredMessage[],
  character: Character,
  user: UserProfile | null,
): string {
  if (!messages.length) return '(no messages yet - this is the very beginning)';
  const her = character.real_name;
  const him = user?.display_name ?? 'him';
  return messages
    // Leftover cards from the short-lived "Play it out" button carry nothing she said.
    .filter((m) => m.meta?.type !== 'fantasy_pitch')
    .map((m) => {
      const who = m.sender === 'user' ? him : m.sender === 'character' ? her : 'system';
      const time = new Date(m.sent_at).toLocaleString('en-GB', {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
      const described = m.meta?.description ? `: ${m.meta.description}` : '';
      const kind = m.kind === 'voice' ? ' [voice message]' : m.kind === 'image' ? ` [photo${described}]` : '';
      return `[${time}] ${who}${kind}: ${m.text}`;
    })
    .join('\n');
}

export function seedBlock(character: Character): string {
  return `username: @${character.username}\nreal name: ${character.real_name}\nbio: ${character.bio}\n\n${describeSeed(character.seed)}`;
}
