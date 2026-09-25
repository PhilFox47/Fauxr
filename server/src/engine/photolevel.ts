import { find } from '../db/attributes.js';
import type { CharacterSeed } from '../types.js';

/**
 * How bold her photos are, from her own seed - two scales on one score. Her profile picture is
 * the first image of her anyone sees and sits on her profile for good, so it leans teasing,
 * sometimes flirty and only rarely bold, and even bold stops at implied. What she sends him in
 * the chat is between the two of them: there bold is the most common level and goes topless.
 * Which level a woman lands on is as much her as her style is - her confidence and how far she
 * goes, not a house setting.
 *
 * Each level sets the whole photo, not just the outfit: what she shows, what the picture is
 * about, how she positions herself and the look she gives the lens. Clothing alone left every
 * level free to fall back on the same standing mirror selfie with a different amount of fabric.
 */
const PROFILE_LEVELS: Record<'bold' | 'flirty' | 'teasing', { name: string; shows: string; about: string; pose: string; look: string }> = {
  bold: {
    name: 'Bold',
    shows: 'Lingerie, a bikini, wet or sheer fabric, or an arm across a bare chest - openly sexy, but this is the first photo anyone sees, so your nipples stay covered.',
    about: 'Openly about your body and sex: lying across your bed, the bathroom mirror, the shower doorway, a hotel bed, your usual photo spot with the lights set up for it.',
    pose: 'Posed to show it off: back arched, looking back over a bare shoulder, stretched across the sheets, leaning into the mirror, a hand on your own body.',
    look: 'Straight into the lens - a bitten or parted lip, heavy-lidded eyes. You know exactly what this photo does.',
  },
  flirty: {
    name: 'Flirty',
    shows: 'Your figure in something tight, short or low-cut, a bikini or a sports set - no underwear on show.',
    about: 'You out in the world looking good: a night out, the gym mirror, a pool, the mirror before you leave, your car, a festival.',
    pose: 'Angled to show your shape: a shoulder turned to the lens, looking back over it, leaning in towards the camera, chin down and eyes up.',
    look: 'A smirk or a knowing smile, and eye contact that holds a beat too long.',
  },
  teasing: {
    name: 'Teasing',
    shows: 'Mostly covered - the point is what peeks out: a bare shoulder, a slipping strap, an oversized shirt and bare legs, a glimpse of lace.',
    about: 'An everyday moment with an edge: in bed in the morning, curled up on the sofa, a close-up of your face, a mirror half fogged up.',
    pose: 'Half covered: a sheet or an oversized shirt slipping off one shoulder, knees pulled up, a hand in your hair, the camera close.',
    look: 'A look that suggests more than it shows - shy from under your lashes, or knowing and patient, whichever you are.',
  },
};

const boldnessOf = (category: string, id: string | undefined) =>
  Number((id ? find(category, id)?.extra?.photo_boldness : 0) ?? 0);

/**
 * Which level her lead photo is, from who she is: confidence and how far she goes, plus how
 * her persona, archetype and style lean a photo (extra.photo_boldness). Driven by the first
 * two alone it was right on average and still free to hand a commanding domme a shy teasing
 * photo, so the persona and archetype count directly, and three combinations that would
 * contradict her outright are ruled out whatever the score says.
 */
type Level = 'bold' | 'flirty' | 'teasing';

function boldnessScore(seed: CharacterSeed): { score: number; persona: number; archetype: number } {
  const persona = boldnessOf('sexual_persona', seed.sexual_persona);
  const archetype = boldnessOf('archetype', seed.archetype);
  const score =
    ((seed.sexual_confidence ?? 3) - 3) * 0.8 + ((seed.freak ?? 3) - 3.5) * 0.6 +
    persona + archetype + boldnessOf('clothing_style', seed.clothing_style);
  return { score, persona, archetype };
}

// Measured on the current cast. In the chat: about half bold, 40% flirty, a tenth teasing.
// On her profile picture: about half teasing, 40% flirty, under a tenth bold.
const CHAT = { boldFrom: 2.5, teasingUpTo: 0.3, publicPhoto: false };
const PROFILE = { boldFrom: 4.6, teasingUpTo: 2.8, publicPhoto: true };

/** Her level for photos she sends in the chat. */
export function chatPhotoLevel(seed: CharacterSeed): Level {
  return levelFor(seed, CHAT);
}

/** Her level for her profile picture - the same woman, a much more public photo. */
export function profileLevel(seed: CharacterSeed): Level {
  return levelFor(seed, PROFILE);
}

function levelFor(seed: CharacterSeed, t: { boldFrom: number; teasingUpTo: number; publicPhoto: boolean }): Level {
  const { score, persona, archetype } = boldnessScore(seed);
  let level: Level = score >= t.boldFrom ? 'bold' : score <= t.teasingUpTo ? 'teasing' : 'flirty';
  // A woman who is in charge, or whose whole thing is being looked at, does not send coy
  // photos. On her public profile picture only the real show-offs are held to that: a domme
  // can lead with a tease - covered, knowing, the camera low - and photoManner keeps it hers.
  const neverCoy = t.publicPhoto
    ? persona >= 2 || archetype >= 1.5
    : (seed.dom_sub_leaning ?? 0) >= 2 || persona >= 1.5 || archetype >= 1;
  if (level === 'teasing' && neverCoy) level = 'flirty';
  // A genuinely shy woman with a soft persona does not lead topless. A shy one with a filthy
  // persona can - that contrast is the point of her - and her manner keeps it shy.
  if (level === 'bold' && archetype <= -1 && persona <= 0) level = 'flirty';
  // Some personas are exactly the contrast between a shy surface and what she shows ("shy but
  // filthy"): scored on her shyness alone she came out teasing four times in five. The floor
  // lives on the persona row (extra.photo_level_min); her manner keeps the photo shy.
  const floor = find('sexual_persona', seed.sexual_persona)?.extra?.photo_level_min;
  if (floor === 'flirty' && level === 'teasing') level = 'flirty';
  if (floor === 'bold') level = 'bold';
  return level;
}

export function profileHeat(seed: CharacterSeed): string {
  const l = PROFILE_LEVELS[profileLevel(seed)];
  return [
    `${l.name}.`,
    `- What you show: ${l.shows}`,
    `- What the photo is about: ${l.about}`,
    `- How you pose: ${l.pose}`,
    `- Your look: ${l.look}`,
  ].join('\n');
}

/**
 * The attitude of every photo of her, whatever the level: where the camera sits and what she
 * does with it follows who she is in bed. The level lists said "kneeling on the bed" and "a shy
 * smile" to everyone, which is exactly how a commanding domme ended up looking up at the lens
 * like a nervous first-timer.
 */
export function photoManner(seed: CharacterSeed): string {
  const lean = seed.dom_sub_leaning ?? 0;
  const lines = [
    lean >= 2
      ? 'You are the one in charge and your photos say so: the camera low, you looking down into it; standing over it, sitting back with your legs apart, a heel up on the bed, a hand on your hip. Never kneeling, never asking.'
      : lean <= -2
        ? 'You love giving yourself over and your photos show it: the camera above you, looking down; kneeling, lying back, looking up into the lens - eager, soft, a little wicked.'
        : 'Your photos are as much a dare as an invitation: eye-level, playful, confident either way round.',
  ];
  if (boldnessOf('archetype', seed.archetype) <= -1) {
    lines.push('You are a little camera-shy even when you show a lot: a glance away, a half-hidden smile, a hand that almost covers your chest - never your face.');
  } else if (boldnessOf('sexual_persona', seed.sexual_persona) >= 1.5 || boldnessOf('archetype', seed.archetype) >= 1) {
    lines.push('You like being looked at and it shows: nothing coy, you hold the lens.');
  }
  return lines.join(' ');
}

/**
 * How far her chat photos usually go, as one line for her own prompts (the Actor's sexual block
 * and the photo-idea prompt). A baseline, not a cap: as things heat up she goes further.
 */
const CHAT_LINES: Record<Level, string> = {
  bold: 'Bold. Once it turns sexual, topless and fully naked are normal for you - you send the photo other women would think twice about.',
  flirty: 'Flirty. Lingerie and underwear are your go-to, a hand or an arm over your chest; you go topless or further when things get really hot.',
  teasing: 'Teasing. You hint more than you show - a slipping strap, a bit of lace, your thighs, a hand where his should be - and make him ask for the rest. When he does and it is hot, you give it.',
};

export function chatPhotoLine(seed: CharacterSeed): string {
  return CHAT_LINES[chatPhotoLevel(seed)];
}
