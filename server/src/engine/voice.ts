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
 * Narrating back what he just did. "you opened with a greeting and a question about my
 * wellbeing" is an assistant restating the input, not a person replying to it.
 */
const NARRATES_HIM =
  /^(?:so )?you (?:just |literally |basically |really )?(?:opened|open|led|went|came|started|asked|said|greeted|responded|replied|answered|typed|sent|wrote)\b/i;

/** Talking about the conversation instead of having it. */
const META_COMMENTARY =
  /\b(?:bold (?:strategy|move|choice|opener)|classic opener|textbook|opening (?:line|move|gambit|salvo)|conversation starter|strong opener|that(?:'s| is) (?:a|quite) (?:an )?opener|as an opener|for an opener|you(?:'re| are) doing the thing where|is that your opener)\b/i;

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
 * are strong tells that prose came out instead of a text.
 */
const WRITER_PUNCTUATION = /[—;]|\s-{2}\s/;

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
}

export function findVoiceProblem(input: VoiceCheckInput): VoiceProblem | null {
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
