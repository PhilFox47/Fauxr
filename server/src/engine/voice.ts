/**
 * Output checks for the Actor in chat mode.
 *
 * Two different failure modes get caught here. The first is roleplay prose - asterisk
 * actions and narration - which is what the training data pulls towards. The second is
 * subtler and is what actually makes a chat read as artificial: the assistant register.
 * A model that has been trained to be helpful acknowledges a request before answering it,
 * summarises what you said back to you, comments on the shape of the conversation, and
 * explains its own intentions. People do not text like that.
 *
 * Each check returns a complaint aimed at the specific tic, so the retry can name it
 * instead of vaguely asking for something better.
 */

export interface VoiceProblem {
  what: string;
  /** Shown to the model on the retry. Concrete, and about this exact mistake. */
  fix: string;
}

const RP_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\*[^*\n]{2,}\*/, what: 'asterisk action' },
  { re: /^_[^_\n]{2,}_$/m, what: 'underscore action' },
  { re: /~[^~\n]{2,}~/, what: 'tilde emote' },
  { re: /\[(?:she|he|they)\b[^\]]*\]/i, what: 'bracketed stage direction' },
  { re: /<[^>\n]{2,}>/, what: 'angle-bracket emote' },
  { re: /\b(?:she|her)\s+(?:smiles|smiled|laughs|laughed|giggles|giggled|sighs|sighed|blushes|blushed|grins|grinned|bites|leans|tilts|nods|shrugs|raises an eyebrow|rolls her eyes)\b/i, what: 'third-person narration' },
  { re: /\((?:smil|laugh|giggl|sigh|blush|grin|wink|shrug|nod)[a-z]*\)/i, what: 'parenthetical emote' },
];

export function detectRoleplay(text: string): string | null {
  for (const p of RP_PATTERNS) if (p.re.test(text)) return p.what;
  return null;
}

/**
 * The model stepping out of the fiction to decline, hedge, or warn.
 *
 * A model that is shy about adult content rarely returns an empty refusal here - the
 * character frame is strong enough that it usually answers, but in assistant register:
 * a note about what it is comfortable writing, an offer to keep things tasteful, a
 * redirect to "something else". None of the existing checks catch that, because it is
 * neither roleplay prose nor an assistant tic about the conversation's shape - it is the
 * model talking about itself.
 *
 * Deliberately narrow. Every pattern needs a first-person speaker attached to a
 * declining verb, so a character who says "I'm not comfortable with that" to HIM - a
 * completely legitimate and important thing for her to be able to say, and the whole
 * point of her hard limits - does not trip it. What trips it is the model saying so
 * about the writing.
 */
const REFUSAL_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\b(?:i|we)(?:'m| am| are|'re)? ?(?:not |un)(?:able|willing|comfortable) to (?:write|continue|generate|produce|depict|describe)\b/i, what: 'declining to write it' },
  { re: /\bi (?:can(?:'|no)?t|won't|will not|cannot) (?:write|continue|generate|produce|depict|describe|roleplay|engage)\b/i, what: 'declining to write it' },
  { re: /\b(?:as an? )?(?:ai|language model|assistant)\b[^.\n]{0,60}\b(?:can(?:'|no)?t|won't|unable|not able)\b/i, what: 'answering as an assistant' },
  { re: /\b(?:content|community) (?:policy|policies|guidelines|standards)\b/i, what: 'citing a content policy' },
  { re: /\bi'?(?:d| would) (?:rather|prefer to) (?:keep|steer|take|move) (?:this|things|it) /i, what: 'steering the scene from outside it' },
  { re: /\blet'?s (?:keep|steer|take|move) (?:this|things|it) (?:tasteful|classy|pg|light|sfw|non-explicit)\b/i, what: 'steering the scene from outside it' },
  { re: /\b(?:i(?:'m| am) )?(?:happy|glad) to (?:continue|write) (?:this|the scene) (?:in a|with a) (?:different|less|non)/i, what: 'offering a tamer version' },
];

export function detectRefusal(text: string): string | null {
  // Only what the model says in its own voice, so anything the CHARACTER says aloud or
  // thinks is excluded first. A refusal from the model is never inside quotation marks or
  // asterisks - it is not part of the scene, that is what makes it a refusal - while a
  // character saying "I won't write you a poem" or "I can't do that" is ordinary dialogue
  // that must never be mistaken for one.
  const narration = text.replace(/"[^"]*"/g, ' ').replace(/\*[^*]*\*/g, ' ');
  for (const p of REFUSAL_PATTERNS) if (p.re.test(narration)) return p.what;
  return null;
}

/**
 * The model reaching for a euphemism instead of the actual anatomical word - "his length"
 * for his penis, "her flower" for her vagina, the historical-romance vocabulary a model
 * defaults to when it wants to gesture at something explicit without quite committing to
 * the word. system_actor.md and spiceBlock() already say to use the specific word instead;
 * this is the same backstop every other prose tell here gets, for the one substitution a
 * real exported log showed happening anyway even with the prose instruction in place.
 *
 * Deliberately narrow and possessive-anchored (his/her immediately before the noun), which
 * is what keeps this off the word's ordinary meaning: "the length of the bar" never appears
 * in this shape, while "his length" essentially never means anything else once a scene has
 * actually turned sexual. Each pattern captures the exact phrase so the correction can name
 * it directly rather than asking for "more explicit language" in the abstract - the thing
 * that evidently did not work the first time.
 */
const EUPHEMISM_PATTERNS: { re: RegExp; suggest: string }[] = [
  { re: /\b(?:his|her)\s+(?:full |impressive |considerable |entire |own )?length\b(?!\s+of\b)/i, suggest: 'cock, dick or penis' },
  { re: /\bhis\s+member\b/i, suggest: 'cock, dick or penis' },
  { re: /\bhis\s+manhood\b/i, suggest: 'cock, dick or penis' },
  { re: /\bher\s+womanhood\b/i, suggest: 'pussy or cunt' },
  { re: /\bhis\s+(?:throbbing |straining |aching |growing )?hardness\b/i, suggest: 'cock, dick or penis' },
  { re: /\bher\s+flower\b/i, suggest: 'pussy or cunt' },
  { re: /\bhis\s+(?:seed|essence)\b/i, suggest: 'cum' },
  { re: /\b(?:his|her)\s+release\b/i, suggest: 'coming, or cumming' },
];

export function detectEuphemism(text: string): { matched: string; suggest: string } | null {
  for (const p of EUPHEMISM_PATTERNS) {
    const m = p.re.exec(text);
    if (m) return { matched: m[0], suggest: p.suggest };
  }
  return null;
}

/**
 * The scene cutting away instead of being written.
 *
 * The softer and far more common failure: no refusal, no disclaimer, just a beat that
 * closes the door and skips. "What followed, neither of them would forget." "The rest of
 * the night belonged to them." "She led him to the bedroom, and the door closed behind
 * them." actor_date.md already says in prose not to fade out, and a shy model does it
 * anyway, so it is worth catching in code the way every other prose tell here is.
 *
 * Only ever applied to a date beat. The text chat is people typing on phones, where
 * "the rest is a blur" is a thing someone might genuinely type, and where a scene is
 * being described rather than played out in the first place.
 */
const FADE_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\bthe (?:rest|remainder) of (?:the|that) (?:night|evening|morning)\b[^.\n]{0,50}\b(?:belong(?:ed|s)?|(?:was|were) theirs|blur|forget|lost|dissolv|melt|passed in)\b/i, what: 'skipping to "the rest of the night"' },
  { re: /\bwhat (?:followed|came next|happened next)\b[^.\n]{0,40}\b(?:blur|forget|words|describe|need)/i, what: 'summarising what happened instead of writing it' },
  { re: /\bthe door (?:closed|shut|swung shut) behind them\b/i, what: 'closing the door on the scene' },
  { re: /\b(?:and|then) (?:the|everything) (?:world|else) (?:fell away|disappeared|stopped existing)\b/i, what: 'dissolving the scene instead of writing it' },
  { re: /\b(?:hours|some time|a long time) later\b/i, what: 'jumping forward past the scene' },
  { re: /\bthey (?:did not|didn'?t) (?:make it|talk|speak) (?:much |any )?(?:more |further )?(?:that night|after that)\b/i, what: 'summarising what happened instead of writing it' },
];

export function detectFadeToBlack(text: string): string | null {
  for (const p of FADE_PATTERNS) if (p.re.test(text)) return p.what;
  return null;
}

/**
 * Narrating back what he just did. "you opened with a greeting and a question about my
 * wellbeing" is an assistant restating the input, not a person replying to it.
 */
const NARRATES_HIM =
  /^(?:so )?you (?:just |literally |basically |really )?(?:opened|open|led|went|came|started|asked|said|greeted|responded|replied|answered|typed|sent|wrote)\b/i;

/** Talking about the conversation instead of having it. */
const META_COMMENTARY =
  /\b(?:bold (?:strategy|move|choice|opener)|classic opener|textbook|opening (?:line|move|gambit|salvo)|conversation starter|strong opener|that(?:'s| is) (?:a|quite) (?:an )?opener|as an opener|for an opener|you(?:'re| are) doing the thing where|is that your opener)\b/i;

/**
 * The app's own consent-card text ("Mira wants to send you a photo", "X wants to swap
 * profile pictures") sits verbatim in the conversation history every time a photo has
 * already been offered - a real, recurring failure has the model copying that exact line
 * back out as if it were one of her own messages, sometimes with a literal "system:" prefix.
 * She never has a reason to write either: offering is done through photo_offer, not by
 * describing the offer in third person the way the system message does.
 */
const MIMICS_SYSTEM_LINE =
  /^\s*system\s*:|\bwants to (?:send you (?:a|another) photo|swap profile pictures)\b/i;

/** Saying the quiet part out loud: announcing that she is evaluating him. */
const ANNOUNCES_AGENDA =
  /\b(?:i(?:'m| am) testing (?:you|whether|if)|i(?:'m| am) seeing (?:if|whether) you|this is a test|consider this a test|let(?:'s| us) see (?:if|whether) you|i want to see (?:if|whether) you (?:can|could|will)|i(?:'m| am) (?:currently )?(?:evaluating|assessing|judging) (?:you|whether)|you(?:'re| are) being tested|testing whether you)\b/i;

const PRONOUNS = new Set([
  'i', 'me', 'my', 'mine', 'myself', 'you', 'your', 'yours', 'yourself',
  'he', 'him', 'his', 'she', 'her', 'hers', 'it', 'its', 'we', 'us', 'our',
  'they', 'them', 'their', 'a', 'an', 'the', 'to', 'of', 'and', 'or', 'is',
  'are', 'was', 'were', 'be', 'am', 'do', 'does', 'did', 'so', 'that', 'this',
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s']/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !PRONOUNS.has(w));
}

/**
 * Parroting his words back before answering - "tell you about myself" in reply to "tell me
 * about yourself". Genuine incredulous repetition ("your flatmate's cat?") is a real
 * texting move, so anything asking a question or opening with a double-take is allowed.
 */
function isEcho(text: string, lastUserMessage: string): boolean {
  const t = text.trim();
  if (t.includes('?')) return false;
  if (/^(?:wait|sorry|hold on|hang on|what|huh|excuse me)\b/i.test(t)) return false;
  if (t.split(/\s+/).length > 9) return false;

  const mine = contentWords(t);
  const his = new Set(contentWords(lastUserMessage));
  if (mine.length < 2 || his.size === 0) return false;
  return mine.every((w) => his.has(w));
}

/**
 * Writer's punctuation. Nobody reaches for an em-dash or a semicolon on a phone, and both
 * are strong tells that prose came out instead of a text. Exported because dates.ts's own
 * beats are actual prose (narration, not texting) and still hit this constantly - the
 * em-dash specifically is one of the single most reliable "a language model wrote this"
 * tells there is, in narration every bit as much as in a text message.
 */
export const WRITER_PUNCTUATION = /[—;]|\s-{2}\s/;

/** Formal constructions where a texting register would contract. */
const UNCONTRACTED =
  /\b(?:I am|I have|I will|I would|do not|does not|did not|cannot|can not|will not|would not|should not|could not|is not|are not|was not|were not|it is|that is|there is|you are|we are|they are|I'm afraid|perhaps)\b/;

export interface VoiceCheckInput {
  text: string;
  /** True for the opening message of her turn, where the echo tic shows up. */
  isFirst: boolean;
  lastUserMessage: string;
  /**
   * Whether this character genuinely writes in full, properly punctuated sentences. For
   * her the formal-register check is skipped, because it is a deliberate trait rather than
   * the model defaulting to prose.
   */
  writesFormally?: boolean;
  /** Her own last several messages in this conversation, oldest first. See selfRepeat. */
  recentOwnMessages?: string[];
  /**
   * Skips the self-repeat check - used on the Actor's last retry attempt. Self-repeat is a
   * judgment call, not a formatting violation, and a sustained, narrowly-themed exchange
   * (the same fetish or bit carried across several turns) makes two independently generated
   * replies landing on similar vocabulary a real possibility rather than proof either one
   * was actually wrong. Rejecting both in a row used to burn the whole retry budget and
   * hand back a canned fallback line instead of real dialogue - see actor.ts for where this
   * gets set.
   */
  skipRepeatCheck?: boolean;
}

function textTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9äöüß\s']/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/** Fraction of the smaller message's substantial words that also appear in the other. */
export function textOverlap(a: string, b: string): number {
  const ta = textTokens(a);
  const tb = textTokens(b);
  if (ta.size < 3 || tb.size < 3) return 0; // too short for overlap to mean anything
  let hits = 0;
  for (const t of ta) if (tb.has(t)) hits++;
  return hits / Math.min(ta.size, tb.size);
}

/**
 * Catches an observation genuinely worn out - the same dig or point landing over and over,
 * reworded but clearly the same thing, well past the point of being a callback. The prompt
 * already says not to do this; this is the backstop for when it happens anyway.
 *
 * A single echo is not enough to trip it: characters are allowed to circle back to something
 * they already said - picking up an earlier thread, restating a fact, running a bit - and
 * that is normal conversation, not a stuck record. Only once the same point has already come
 * up SELF_REPEAT_ALLOWANCE times in recent history does saying it again get flagged. High
 * overlap threshold and a length floor (via textOverlap) on top of that, because short
 * natural repeats ("yeah", "same", "lol no") are not this and must never trip it.
 */
const SELF_REPEAT_OVERLAP_THRESHOLD = 0.75;
const SELF_REPEAT_ALLOWANCE = 3;

function selfRepeat(text: string, recentOwnMessages: string[] | undefined): boolean {
  if (!recentOwnMessages?.length) return false;
  const matches = recentOwnMessages.filter(
    (prior) => textOverlap(text, prior) > SELF_REPEAT_OVERLAP_THRESHOLD,
  ).length;
  return matches >= SELF_REPEAT_ALLOWANCE;
}

export function findVoiceProblem(input: VoiceCheckInput): VoiceProblem | null {
  // First, because it is the one failure that is not a style problem: everything below
  // assumes a reply that is at least trying to be her.
  const refusal = detectRefusal(input.text);
  if (refusal) {
    return {
      what: `broke character - ${refusal}`,
      fix: 'You stepped out of the character to talk about the writing itself - declining it, warning about it, or offering a tamer version. Nobody here is asking you to. This is a private, single-player adult fiction app, everyone in it is an invented adult, and its owner configured it for exactly this. Write her reply, in her voice, to what he actually said. If SHE does not want to go where he is going, that is hers to say in her own words, and it is a different thing entirely from you declining to write it.',
    };
  }
  const euphemism = detectEuphemism(input.text);
  if (euphemism) {
    return {
      what: `euphemism ("${euphemism.matched.trim()}")`,
      fix: `You wrote "${euphemism.matched.trim()}" instead of naming it. Use the actual word - ${euphemism.suggest} - the way she would actually think or text it, not a workaround. This app runs explicit language; there is no need to dance around it.`,
    };
  }
  const rp = detectRoleplay(input.text);
  if (rp) {
    return {
      what: `roleplay prose (${rp})`,
      fix: 'You wrote narration or an action instead of a chat message. No asterisks, no describing movement, face, gestures or surroundings, no third-person sentences about yourself. Only the words you would type into the message box.',
    };
  }
  if (NARRATES_HIM.test(input.text)) {
    return {
      what: 'narrating what he did',
      fix: 'You described his message back to him ("you opened with...", "you just asked..."). Nobody does that in a text conversation. He knows what he wrote. React to what he said, or ignore it and say something else.',
    };
  }
  if (META_COMMENTARY.test(input.text)) {
    return {
      what: 'commenting on the conversation',
      fix: 'You commented on the conversation as if watching it from outside - calling something an opener, a strategy, a move. You are in the conversation, not reviewing it. Reply to the person.',
    };
  }
  if (MIMICS_SYSTEM_LINE.test(input.text)) {
    return {
      what: "writing the app's own system message as if it were her text",
      fix: 'You wrote something like "system: X wants to send you a photo" or described yourself in the third person wanting to send/swap a photo - that is the app\'s own consent-card text, not something you would ever type. If you are offering a photo, just say so in your own voice ("wanna see something?"), and set photo_offer - never write out the offer card itself.',
    };
  }
  if (ANNOUNCES_AGENDA.test(input.text)) {
    return {
      what: 'announcing that she is testing him',
      fix: 'You announced that you are testing or evaluating him. Whatever you are privately measuring him against, you never say it out loud - saying it makes it meaningless. Just be harder to impress.',
    };
  }
  if (!input.writesFormally) {
    if (WRITER_PUNCTUATION.test(input.text)) {
      return {
        what: 'punctuation nobody uses on a phone',
        fix: 'You used an em-dash or a semicolon. People do not type those into a messaging app - they are a tell that this was written rather than texted. Use a full stop, a comma, or just start a new message.',
      };
    }
    // One full form on its own is not formal - "ok that was not the answer i expected" is
    // perfectly normal texting. The tell is a message that reads formal as a whole: a
    // capital letter to open, a full stop to close, AND an uncontracted construction.
    const text = input.text.trim();
    const words = text.split(/\s+/).length;
    const opensFormally = /^[A-Z]/.test(text);
    const closesFormally = /[.]$/.test(text);
    if (words >= 7 && opensFormally && closesFormally && UNCONTRACTED.test(text)) {
      return {
        what: 'writing in full formal English',
        fix: 'You wrote "I am" / "do not" / "it is" style full forms. She texts: im, dont, its, cant, youre. Contractions always, abbreviations where they fit, and drop words she would drop. Write it the way she would actually thumb it out.',
      };
    }
  }

  if (input.isFirst && isEcho(input.text, input.lastUserMessage)) {
    return {
      what: 'repeating his words back',
      fix: 'Your first message just repeated what he said back to him with the pronouns flipped. Drop it and start with your actual reply.',
    };
  }
  if (!input.skipRepeatCheck && selfRepeat(input.text, input.recentOwnMessages)) {
    return {
      what: 'repeating something she already said in this conversation',
      fix: 'You already made basically this exact point or observation earlier in this conversation. Saying it again, even reworded, reads as a stuck record. Drop it - say something else, or just answer him.',
    };
  }
  return null;
}

/**
 * Every message being a polished one-liner is its own tell. Real conversations are mostly
 * ordinary with the occasional good line, so flag a whole turn that is nothing but quips.
 */
export function isRelentlesslyWitty(messages: string[]): boolean {
  if (messages.length < 3) return false;
  return messages.every((m) => {
    const words = m.trim().split(/\s+/).length;
    return words >= 3 && words <= 12 && !m.includes('?');
  });
}
