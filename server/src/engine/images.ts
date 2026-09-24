import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings } from '../config.js';
import { db, nowIso, DATA_DIR } from '../db/index.js';
import { bus } from '../events.js';
import { completeJson, generateImage } from '../llm/client.js';
import { logger } from '../log.js';
import {
  addMessage,
  findMessageByImageId,
  getCharacter,
  getRelationship,
  saveRelationship,
  updateMessageMeta,
} from '../repo.js';
import { render } from '../prompts/render.js';
import { find } from '../db/attributes.js';
import { pickOne, randInt } from './dice.js';
import { describeSeed } from './generator.js';
import type { Character, CharacterSeed, Relationship } from '../types.js';

/** Whether image generation is switched on at all. */
export function photosEnabled(): boolean {
  return getSettings().images_enabled;
}

/**
 * Whether the two of them have swapped profile pictures. A character whose picture already
 * exists (generated before the swap existed) counts as swapped - the cost is already paid.
 */
export function hasSwapped(rel: Relationship | null | undefined): boolean {
  return !!rel?.flags.state.photos_exchanged || !!rel?.flags.state.profile_picture_sent;
}

/**
 * Whether she can send him a photo right now: images on, and the pictures swapped. Before the
 * swap nothing about her is generated - that is his call, made with the swap button.
 */
export function canSendPhotos(rel: Relationship | null | undefined): boolean {
  return photosEnabled() && hasSwapped(rel);
}

/**
 * Whether a profile picture already exists or is already on its way - checked against the
 * `images` table itself, not `profile_picture_sent`, because that flag only flips once
 * generation actually finishes, so two callers in quick succession would otherwise both
 * start one.
 */
export function hasProfileImageJob(characterId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM images WHERE character_id = ? AND kind = 'profile' AND status != 'failed' LIMIT 1")
    .get(characterId);
  return !!row;
}

/**
 * Makes sure her profile picture exists, generating it if needed, and resolves once it is
 * done (or has failed). Every later photo uses it as the reference for her face, so a photo
 * she sends before one exists waits on this first. The profile picture lives on her profile;
 * it is not posted into the chat.
 */
export async function ensureProfilePicture(characterId: string): Promise<void> {
  if (!photosEnabled()) return;
  const existing = db
    .prepare("SELECT id, status FROM images WHERE character_id = ? AND kind = 'profile' AND status != 'failed' ORDER BY rowid ASC LIMIT 1")
    .get(characterId) as { id: string; status: string } | undefined;
  if (!existing) {
    const job = insertImageJob({ characterId, kind: 'profile', situation: '' });
    await runImageJob(job.id, '', false);
    return;
  }
  // Already queued or running from another caller: wait for it rather than starting a second.
  const deadline = Date.now() + 10 * 60_000;
  let status = existing.status;
  while ((status === 'queued' || status === 'running') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    status = getImageJob(existing.id)?.status ?? 'failed';
  }
}

/**
 * She sends him a photo. No consent card, no unlock: she decided to, so it happens. If she has
 * no profile picture yet, that is generated first so this one can match her face.
 */
export async function sendPhoto(opts: {
  characterId: string;
  kind: 'chat' | 'spicy';
  situation: string;
  aspect: 'portrait' | 'landscape' | null;
  showsFace: boolean;
}): Promise<void> {
  if (!photosEnabled()) return;
  await ensureProfilePicture(opts.characterId);
  const job = insertImageJob({
    characterId: opts.characterId,
    kind: opts.kind,
    situation: opts.situation || DEFAULT_SITUATION[opts.kind],
    aspect: opts.aspect,
    showsFace: opts.showsFace,
  });
  await runImageJob(job.id, job.situation ?? '', true);
}

type PromptStyle = 'seedream' | 'z_image_turbo';

/**
 * The floor every generated photo lands on, whatever kind of shot it is - split per
 * prompt-model, because the two send this in completely different shapes.
 *
 * Seedream 5.0 Lite: a short natural-language suffix, and constraints as a genuinely
 * separate negative_prompt (see SEEDREAM_NEGATIVE below).
 *
 * Z Image Turbo: this model runs with no classifier-free guidance at all, so a
 * negative_prompt is simply never read - everything SEEDREAM would put there instead has to
 * be folded into this suffix as a positive statement ("natural, unretouched skin", not "no
 * airbrushing"). See images.ts's runImageJob for where negativePrompt is skipped entirely
 * in this mode, and image_prompt_assembler.md for the matching instructions to the model
 * that writes the rest of the prompt.
 *
 * Used to be one fixed "candid amateur phone photo" suffix forced onto every image, profile
 * pictures included - which is exactly why every profile picture came out the same. This is
 * now only the part that has to hold regardless of format: a real texture, not a plastic
 * one, and an attractive but fairly represented woman rather than a bad angle excused as
 * "candid". Which kind of photo it actually is - candid or composed, phone or studio - is
 * CANDID_SUFFIX below plus whatever the assembler itself wrote from her own account of the
 * shot.
 */
const BASE_SUFFIX: Record<PromptStyle, string> = {
  seedream:
    'Rendered as a photorealistic photograph, not an illustration or a render, with real ' +
    'unretouched skin texture.',
  z_image_turbo:
    'Rendered as a photorealistic photograph, not an illustration, cgi render or anime ' +
    'style - real, unretouched skin with natural texture and pores, and anatomically ' +
    'correct hands and limbs.',
};

/**
 * The "flattering angle" clause, which used to live in BASE_SUFFIX and therefore rode along
 * with every single image.
 *
 * On her profile picture that is right - it is the one photo she chose precisely because it
 * came out well. On a snapshot from inside the conversation it is the single most
 * glamourising instruction in the whole prompt, and it arrived last, after everything asking
 * for a candid. A photo of someone that happens to catch a good angle is a photo; a photo
 * composed to catch a good angle is a shoot, and the difference is most of what reads as
 * fake. The candid and date paths carry their own, milder "she is an attractive woman,
 * photographed honestly" language in the assembler template instead.
 */
const FLATTERING_SUFFIX = 'Shot from a flattering angle that shows off her face and her figure.';

/**
 * The "taken on her phone, right now" look - added on top of BASE_SUFFIX for a chat or
 * spicy photo, which is always a moment inside the conversation rather than a picture she
 * chose to lead with. A profile picture does not get this forced on: see is_moment in the
 * assembler template for the matching instructions, and runImageJob for where it applies.
 */
const CANDID_SUFFIX: Record<PromptStyle, string> = {
  seedream:
    'Shot as a candid amateur phone photo, taken in this exact moment: natural available ' +
    'light, softly imperfect handheld framing, a little sensor grain, shallow phone-lens ' +
    'depth of field.',
  z_image_turbo:
    'Shot as a candid amateur phone photo taken in this exact moment, with natural ' +
    'available light, softly imperfect handheld framing, a little sensor grain and shallow ' +
    'phone-lens depth of field - not a studio-lit or posed professional-model photo.',
};

/**
 * The "seen by him, right now" look for a date's arrival photo - added on top of BASE_SUFFIX
 * instead of CANDID_SUFFIX, for the same reason a date beat's own prose is not written like a
 * text message: this was never a picture anyone took on a phone, it is simply how she looks
 * to him in the room. See images.ts's runImageJob for where this replaces CANDID_SUFFIX for a
 * 'date'-kind job, and image_prompt_assembler.md's is_date section for the matching framing
 * instructions to the model that writes the rest of the prompt.
 */
const DATE_SUFFIX: Record<PromptStyle, string> = {
  seedream:
    'Framed as if by an unseen observer standing right there with them - a natural social ' +
    'distance, eye-level, real depth of field falling off into the actual room behind her - ' +
    'not a phone selfie and not a posed studio portrait.',
  z_image_turbo:
    'Framed as if by an unseen observer standing right there with them, natural eye-level ' +
    'distance, real depth into the room behind her - not a phone selfie, not a posed studio ' +
    'portrait.',
};

/**
 * A spicy photo is still a phone photo, but not an accident: she took it for him, on purpose,
 * and posed for it. CANDID_SUFFIX's "caught in this exact moment" framing used to be forced on
 * these too, and together with CANDID_NEGATIVE's ban on posing it pulled the hottest shots in
 * the app back towards snapshots.
 */
const SPICY_SUFFIX: Record<PromptStyle, string> = {
  seedream:
    'Shot as an intimate amateur phone photo she took of herself for one man, posed on purpose ' +
    'the way she knows looks good: real skin, a natural body, a little sensor grain.',
  z_image_turbo:
    'Shot as an intimate amateur phone photo she took of herself for one man, posed on purpose ' +
    'the way she knows looks good, with real skin, a natural body and a little sensor grain - ' +
    'not a studio shoot.',
};

/**
 * Sent with every Seedream image regardless of kind - the airbrushed-render look, the
 * opposite over-correction into unflattering, and the usual anatomy rubbish. Kept short and
 * in plain language on purpose: this model's own negative-prompt guidance says a long list
 * of banned tags produces inconsistent results, where one or two clear sentences actually
 * get honored. Used to be five long comma-separated tag dumps. Z Image Turbo has no
 * equivalent constant - see BASE_SUFFIX/CANDID_SUFFIX above for where those constraints go
 * for that model instead.
 */
const BASE_NEGATIVE =
  'No airbrushing, beauty-filter skin or doll-like retouching. No cgi, illustration or ' +
  'anime look, and no deformed anatomy or extra limbs.';

/**
 * Only for a chat/spicy moment: a profile picture is now allowed to genuinely be a studio
 * headshot or a posed professional-looking shot, so banning that look outright would
 * contradict the one case it is meant to happen. Seedream-only, same reason as above.
 */
const CANDID_NEGATIVE =
  'No studio lighting or posed professional-model styling. No golden-hour rim light, no ' +
  'lens flare, no halo of backlit hair, no perfectly tidy staged room.';

/** The spicy version: posing is the point, a studio is not. */
const SPICY_NEGATIVE = 'No studio backdrop or professional photoshoot lighting, no perfectly tidy staged room.';

/**
 * The three pools below are the fix for "technically good, somehow fake".
 *
 * Every other lever in this pipeline pushed toward a *good photograph*: the assembler was
 * told to write like a cinematographer naming the light, the suffix asked for a flattering
 * angle, and nothing anywhere ever asked for the specific, nameable defects that make a real
 * photo read as real. With nothing anchoring it, a model asked to invent lighting converges
 * on its favourite lighting every single time - warm window light, golden hour, a soft rim
 * on the hair - and a model asked to invent a room converges on a show home.
 *
 * So the condition is drawn here, in code, per shot, and handed to the assembler as a
 * requirement rather than left to its taste. Exactly the same reasoning as seedFor() above
 * and demeanourFor()'s labelled lines: the failure was never that the model wrote badly, it
 * was that nothing varied, so it wrote its one favourite answer over and over.
 *
 * Written to be place-agnostic on purpose - each one describes what the light is *doing*,
 * not where it is, so the assembler can apply it to whatever room or street the situation
 * already established rather than fighting it.
 */
const LIGHT_CONDITIONS = [
  'One bare source almost directly above her: short hard shadows under her brows, nose and chin, and a dull fall-off everywhere it does not reach.',
  'Direct on-camera phone flash - flat and harsh, the nearest surfaces blown too bright, everything more than a couple of metres behind her dropping away to near-black.',
  'Two light sources that do not match: something warm and yellow on one side, something cold and blue on the other, and the white balance resolving neither - one side of her skin running warm, the other faintly blue.',
  'Lit from behind by something far brighter than she is - a window, a doorway, a screen - so that blows out to featureless white and her face sits a stop under, lifted only by what bounces back off the room.',
  'Hard high sun: sharp-edged shadows, real contrast, a bright hotspot where it lands on her, and her eyes narrowed very slightly against it.',
  'Flat grey overcast light with almost no shadow at all - even, a little dull, faintly blue, nothing sculpting her face.',
  'A single lamp off to one side doing all the work while the rest of the room falls into genuine dark, the fall-off steep rather than gentle.',
  'Overhead strip lighting with a faint green cast to it, even and unflattering, the kind of light nobody would ever choose.',
  'Not quite enough light: a dim room at night with the sensor pushed hard, colour slightly muddy, noise sitting visibly in the shadows.',
  'A screen as the main light source - phone, laptop, television - cool and uneven, brightest on whatever happens to be closest to it.',
];

/**
 * Capture defects, for a moment shot only. A date image is not a photograph anybody took
 * (see DATE_SUFFIX), so motion blur and compression artefacts would be nonsense there, and a
 * profile picture is the one shot she specifically chose because it came out sharp.
 */
const CAPTURE_FLAWS = [
  'slight motion blur on her hands or hair, because she moved while the shutter was open',
  'focus landing slightly behind her, so something in the background is crisper than her face is',
  'visible sensor noise through the shadows and the flat areas',
  'the brightest areas clipped to flat white with no detail left in them at all',
  'the horizon a couple of degrees off level, and never corrected',
  'carelessly framed - too much dead space on one side, her head close to the top edge',
  'part of something else intruding into one corner of the frame, unnoticed at the time',
  'a faint haze over the bright parts, the way a lens looks when it has not been wiped',
  'slightly over-sharpened and over-compressed, the way a photo looks once a messaging app has had it',
];

/**
 * The room being genuinely lived in rather than staged. The single biggest "fake" tell after
 * lighting: real homes have a charger on the floor and a mug someone forgot, and a model
 * inventing a room never puts one there.
 */
const LIVED_IN_DETAILS = [
  'a charging cable trailing across a surface or the floor',
  'a mug or glass left where it does not belong, with a ring under it',
  'clothes slung over the back of a chair or the end of a bed',
  'a bed or sofa nobody has straightened',
  'shoes kicked off and left exactly where they landed',
  'a cardboard parcel that has not been broken down yet',
  'a drying rack or a radiator with washing on it',
  'a plate or a wrapper not cleared away',
  'too many cables around an overloaded socket',
  'a bin that could do with going out',
];

/**
 * The date equivalent of LIVED_IN_DETAILS: a venue that is genuinely open and occupied
 * rather than a set dressed to look like one.
 */
const VENUE_TRUTH = [
  'other customers genuinely occupying the place, at their own tables, mid-conversation, none of them arranged to suit the composition',
  'the table actually in use: glasses with rings under them, a crumpled napkin, a menu pushed off to one side',
  'real wear on the floor and the furniture, for somewhere that is open every night',
  'staff moving through the background, caught mid-task rather than posed',
  'coats, bags and a phone taking up exactly the space people really leave them in',
];

/**
 * The light for a spicy photo. LIGHT_CONDITIONS is deliberately unflattering - green strip
 * lights, a pushed sensor - which is right for a snapshot and wrong for a photo she set up to
 * turn him on. These are the lights a woman actually uses for that: still real sources with a
 * visible cause, never a studio.
 */
const SPICY_LIGHT = [
  'A ring light in front of her, the round catchlight in her eyes and a soft even glow on her skin, the room behind it falling off into dim.',
  'LED strip lights washing the room pink and purple, the colour sitting on her skin and the shadows going deep violet.',
  'One warm bedside lamp, low and to the side, gold on the skin it reaches and real dark everywhere it does not.',
  'Her phone flash in a mirror: the flash itself a bright star in the glass, her skin lit bright and flat, the room behind her dark.',
  'Late sun through half-closed blinds, striping her body in warm light and shadow.',
  'A bathroom vanity light straight above the mirror, bright and slightly warm, steam softening the edges.',
  'Candles and a string of fairy lights, warm and flickering, most of the room in soft dark.',
  'The cool blue glow of a television or laptop beside her, the only light in the room.',
  'Soft grey morning light from a window beside the bed, gentle on her skin, the sheets bright.',
];

/** Capture flaws mild enough for a photo she chose to send - no blown-out face, no missed focus. */
const SPICY_FLAWS = [
  'a little sensor grain in the shadows',
  'slightly over-compressed, the way a photo looks once a messaging app has had it',
  'a touch of motion blur on the hand holding the phone',
  'the frame tilted a few degrees, the way a one-handed selfie comes out',
];

export interface ShootingConditions {
  light: string;
  flaw: string;
  lived_in: string;
}

/**
 * One drawn condition per shot, weighted by what the shot actually is.
 *
 * A profile picture deliberately gets no harsh light and no capture defect: she picked that
 * photo precisely because it came out well, and forcing a green fluorescent cast and a
 * crooked horizon onto her own lead image would be the wrong correction entirely. What it
 * does get is the room - even her best photo was taken somewhere real.
 */
function shootingConditions(kind: 'profile' | 'moment' | 'spicy' | 'date'): ShootingConditions {
  if (kind === 'profile') return { light: '', flaw: '', lived_in: pickOne(LIVED_IN_DETAILS) };
  if (kind === 'spicy') return { light: pickOne(SPICY_LIGHT), flaw: pickOne(SPICY_FLAWS), lived_in: pickOne(LIVED_IN_DETAILS) };
  if (kind === 'date') return { light: pickOne(LIGHT_CONDITIONS), flaw: '', lived_in: pickOne(VENUE_TRUTH) };
  return { light: pickOne(LIGHT_CONDITIONS), flaw: pickOne(CAPTURE_FLAWS), lived_in: pickOne(LIVED_IN_DETAILS) };
}

/**
 * Sent only when a reference image actually rides along.
 *
 * Seedream reads a reference as "make this the same person", and left at that it brings the
 * whole photo with the face: the same expression, the same head angle, the same crop as the
 * profile picture it was handed. That is most of why a character's shots came back looking
 * like small edits of her profile picture rather than different photos of her. There is no
 * API knob for "identity only" - saying so in the prompt is the only lever there is.
 */
const REF_NOTE =
  'The attached reference photo fixes WHO she is - same face, same bone structure, same hair ' +
  'and colouring. It does not fix this photo: her expression, head angle, pose, framing and ' +
  'surroundings all come from the description above, not from the reference.';

/**
 * Her profile picture is the identity anchor - same character, same seed, so the face every
 * later reference image locks onto is the one she was generated with. Every shot after it
 * gets a fresh seed instead.
 *
 * One fixed seed used to be reused for every single image of a character, which stacked with
 * the reference image and a demeanour line that never changes to leave the prompt doing
 * almost all of the differing on its own - so her photos came back with the same expression
 * and the same head angle over and over. Nothing reads this value back (it is persisted for
 * the image log and nothing else), so a fresh seed per run also gives "regenerate" something
 * real to change: re-running the same job used to hand back a near-identical picture.
 */
function seedFor(characterSeed: CharacterSeed, isProfile: boolean): number {
  return isProfile ? characterSeed.image_seed : randInt(1, 2_000_000_000);
}

/**
 * The provider this goes through hard-rejects a Z Image Turbo prompt over this length -
 * confirmed from actual request errors, not from the model's own published guidance (which
 * says the opposite: that it prefers long, detailed prompts). Whatever the model itself
 * would rather have, this specific deployment enforces the cap, so the prompt this app
 * builds has to stay under it. Seedream has no equivalent limit here.
 */
const Z_IMAGE_MAX_CHARS = 1200;

/** Cuts at the last whole word at or before `max`, so a trim never lands mid-word. */
function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Resolution per shot. A profile picture is always square - it is the one photo she leads
 * with, and a dating app's main photo slot is square everywhere. Anything after that is
 * her call between a tall phone-style frame and a wide one, made from what she is actually
 * showing (see photo_aspect on ActorHidden) - a portrait for a selfie or an outfit shot, a
 * landscape for a view or a wider scene.
 *
 * Exported because locations.ts's backdrop reuses `portrait` directly: the provider silently
 * squared off a "1152x2048" request that was never actually on its supported list, and the
 * one resolution already confirmed working for a tall shot is this one.
 */
export const IMAGE_SIZE: Record<'profile' | 'portrait' | 'landscape', string> = {
  profile: '2048x2048',
  portrait: '2048x3072',
  landscape: '3072x2048',
};

/**
 * How she holds herself in a photo, from who she is rather than what she looks like.
 *
 * Appearance alone produced twelve women with the same blank catalogue expression. The
 * archetype carries a written demeanour (see personality.json), and social energy and humour
 * bend it - the same face is a different photo on someone who hates being photographed.
 *
 * Emitted as labelled lines rather than one comma-joined string. Joined flat, the three
 * sources read as one description of a single face and routinely contradicted each other -
 * a real case was "wide social smile, clearly mid-conversation, lively energy, relaxed,
 * unbothered by the camera, deliberately undersold expression", which asks for a beaming
 * grin and an underplayed one at once. Separated and named, they read as three true things
 * about a person that the assembler can weigh, which is what they actually are.
 *
 * The archetype's line is written as the picture she would choose of herself - it names a
 * crop and a camera distance as well as a manner. That is exactly right for her profile
 * picture and wrong for everything after it, so a non-profile shot is told to take the
 * manner out of it and leave the framing behind.
 */
function demeanourFor(seed: CharacterSeed, isProfile: boolean): string {
  const lines: string[] = [];
  const arch = find('archetype', seed.archetype);
  if (arch?.extra?.photo) {
    const photo = String(arch.extra.photo);
    lines.push(
      isProfile
        ? `Left to choose her own photo, she picks one like this: ${photo}.`
        : `Left to choose her own photo she picks one like this: ${photo}. That is a photo she ` +
          `composed; this one she did not. Take the manner in it - what her face and her ` +
          `posture default to - and leave the crop, the camera distance and the specific ` +
          `expression behind.`,
    );
  }

  // Off the attribute row, not a literal id switch. This used to check `seed.social_energy`
  // against a fixed { low, medium, high } map and `seed.humor_type` against two hardcoded id
  // lists - lists that named ids ("deadpan", "silly", "goofy", "playful") which do not
  // actually exist in personality.json, so neither humour branch had ever fired.
  const energy = find('social_energy', seed.social_energy)?.extra?.demeanour;
  if (energy) lines.push(`Being looked at, or photographed, she is ${String(energy)}.`);

  const humourDemeanour = find('humor_type', seed.humor_type)?.extra?.demeanour;
  if (humourDemeanour === 'undersold') {
    lines.push('When something amuses her it barely surfaces - she underplays rather than beams.');
  }
  if (humourDemeanour === 'playful') {
    lines.push('When something amuses her it shows immediately and visibly, halfway into an expression rather than settled in one.');
  }

  return lines.join('\n');
}

export interface ImageJob {
  id: string;
  character_id: string | null;
  kind: string;
  prompt: string;
  seed: number | null;
  ref_image: string | null;
  status: 'queued' | 'running' | 'done' | 'failed';
  path: string | null;
  error: string | null;
  aspect: 'portrait' | 'landscape' | null;
  /** Stored as 0/1 by sqlite. Use showsFace() rather than reading this raw. */
  shows_face: number;
  /** The idea the photo is of, resolved (never the blank the Actor may have offered with). */
  situation: string | null;
  /** Set only for a 'date' kind job: which date's transcript this posts into. */
  date_id: string | null;
  created_at: string;
  updated_at: string;
}

/** better-sqlite3 hands back 0/1 for an INTEGER column, not a real boolean. */
function showsFace(job: Pick<ImageJob, 'shows_face'>): boolean {
  return job.shows_face !== 0;
}

export function listImageJobs(limit = 50): ImageJob[] {
  return db.prepare('SELECT * FROM images ORDER BY rowid DESC LIMIT ?').all(limit) as ImageJob[];
}

/** Every finished picture of one character, newest first. */
export function characterGallery(characterId: string): ImageJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM images
       WHERE character_id = ? AND status = 'done' AND path IS NOT NULL
       ORDER BY rowid DESC`,
    )
    .all(characterId) as ImageJob[];
  return rows;
}

export function getImageJob(id: string): ImageJob | null {
  return (db.prepare('SELECT * FROM images WHERE id = ?').get(id) as ImageJob) ?? null;
}

function setStatus(id: string, status: ImageJob['status'], fields: Partial<ImageJob> = {}): void {
  db.prepare(
    `UPDATE images SET status = @status, path = COALESCE(@path, path), error = @error, updated_at = @updated_at WHERE id = @id`,
  ).run({
    id,
    status,
    path: fields.path ?? null,
    error: fields.error ?? null,
    updated_at: nowIso(),
  });
}

/**
 * Piercing positions that sit on the face itself - the one set that a "face not shown" shot
 * also has to drop, on top of whatever visibility() already hides. Ear piercings are left
 * out of this list on purpose: a from-behind or angled shot that hides her face can still
 * show an ear.
 */
const FACIAL_PIERCING_POSITIONS = new Set([
  'nose', 'septum', 'eyebrow', 'lip', 'tongue', 'medusa', 'monroe', 'smiley', 'bridge',
  'vertical_labret', 'dahlia', 'anti_eyebrow', 'nasallang',
]);

/** What is actually visible on her in this kind of shot. */
function visibleMarks(character: Character, kind: string, showsFaceInShot: boolean): string {
  const showLater = kind !== 'profile';
  const showPrivate = kind === 'spicy';
  const vis = (position: string, category: string) => {
    const v = find(category, position)?.extra?.visibility ?? 'profile';
    if (v === 'profile') return true;
    if (v === 'later') return showLater;
    return showPrivate;
  };
  const parts: string[] = [];
  for (const t of character.seed.tattoos) {
    if (vis(t.position, 'tattoo_position')) {
      parts.push(`${find('tattoo_motif', t.motif)?.image_prompt ?? t.motif} ${find('tattoo_position', t.position)?.image_prompt ?? ''}`.trim());
    }
  }
  for (const p of character.seed.piercings) {
    if (!showsFaceInShot && FACIAL_PIERCING_POSITIONS.has(p.position)) continue;
    if (vis(p.position, 'piercing_position')) {
      parts.push(`${find('piercing_type', p.type)?.image_prompt ?? p.type} ${find('piercing_position', p.position)?.image_prompt ?? ''}`.trim());
    }
  }
  // A 'profile'-visibility species is already baked into buildAppearancePrompt()'s fixed
  // block, so it is not repeated here. 'chat_only' has no image tell at all. Only
  // 'later'/'private' species need adding per shot, exactly like a tattoo at that tier -
  // species has no "position" to run through vis() above, so this checks the tier directly.
  if (character.seed.species && character.seed.species !== 'human') {
    const species = find('species', character.seed.species);
    const speciesVis = species?.extra?.visibility;
    const show = speciesVis === 'private' ? showPrivate : speciesVis === 'later' ? showLater : false;
    if (show && species?.image_prompt) parts.push(species.image_prompt);
  }
  return parts.join(', ');
}

/** The character's profile picture doubles as the reference image for everything after it. */
function referenceImage(characterId: string): string | null {
  const row = db
    .prepare("SELECT path FROM images WHERE character_id = ? AND kind = 'profile' AND status = 'done' ORDER BY rowid ASC LIMIT 1")
    .get(characterId) as { path: string } | undefined;
  if (!row?.path) return null;
  const abs = join(DATA_DIR, row.path);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'base64');
}

/**
 * How bold her lead photo is, from her own seed. A hookup app's profile pictures run from a
 * look and a bit of skin to topless in bed, and which one a woman leads with is as much her as
 * her style is - so it is her confidence and how far she goes, not a house setting.
 *
 * Each level sets the whole photo, not just the outfit: what she shows, what the picture is
 * about, how she positions herself and the look she gives the lens. Clothing alone left every
 * level free to fall back on the same standing mirror selfie with a different amount of fabric.
 */
const PROFILE_LEVELS: Record<'bold' | 'flirty' | 'teasing', { name: string; shows: string; about: string; pose: string; look: string }> = {
  bold: {
    name: 'Bold',
    shows: 'Topless is fine - bare breasts, or lingerie, a thong, a bikini, wet or see-through fabric.',
    about: 'Openly about your body and sex: lying across your bed, the bathroom mirror, the shower doorway, a hotel bed, your usual photo spot with the lights set up for it.',
    pose: 'Posed to show it off: back arched, ass to the camera over your shoulder, stretched across the sheets, leaning into the mirror, a hand on your own body.',
    look: 'Straight into the lens - a bitten or parted lip, heavy-lidded eyes. You know exactly what this photo does.',
  },
  flirty: {
    name: 'Flirty',
    shows: 'Your figure in something tight, short or low-cut, a bikini or a sports set - no underwear on show.',
    about: 'You out in the world looking good: a night out, the gym mirror, a pool, the mirror before you leave, your car, a festival.',
    pose: 'Angled to show your shape: a hip popped, looking back over your shoulder, legs crossed on a bar stool, leaning in towards the camera.',
    look: 'A smirk or a knowing smile, and eye contact that holds a beat too long.',
  },
  teasing: {
    name: 'Teasing',
    shows: 'Mostly covered - the point is what peeks out: a bare shoulder, a slipping strap, an oversized shirt and bare legs, a glimpse of lace.',
    about: 'An everyday moment with an edge: in bed in the morning, curled up on the sofa, a close-up of your face, a mirror half fogged up.',
    pose: 'Half hidden: looking back over a shoulder, legs tucked up, a hand in your hair or partly over your face, the camera close.',
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
export function profileLevel(seed: CharacterSeed): 'bold' | 'flirty' | 'teasing' {
  const persona = boldnessOf('sexual_persona', seed.sexual_persona);
  const archetype = boldnessOf('archetype', seed.archetype);
  const score =
    ((seed.sexual_confidence ?? 3) - 3) * 0.8 + ((seed.freak ?? 3) - 3.5) * 0.6 +
    persona + archetype + boldnessOf('clothing_style', seed.clothing_style);
  let level: 'bold' | 'flirty' | 'teasing' = score >= BOLD_FROM ? 'bold' : score <= TEASING_UP_TO ? 'teasing' : 'flirty';
  // A woman who is in charge, or whose whole thing is being looked at, does not lead coy.
  const neverCoy = (seed.dom_sub_leaning ?? 0) >= 2 || persona >= 1.5 || archetype >= 1;
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
// Measured on the current cast: about half bold, a third flirty, an eighth teasing.
const BOLD_FROM = 2.5;
const TEASING_UP_TO = 0.3;

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
    lines.push('You are a little camera-shy even when you show a lot: a glance away, a half-hidden smile, a hand that almost covers.');
  } else if (boldnessOf('sexual_persona', seed.sexual_persona) >= 1.5 || boldnessOf('archetype', seed.archetype) >= 1) {
    lines.push('You like being looked at and it shows: nothing coy, you hold the lens.');
  }
  return lines.join(' ');
}

/**
 * Her body, her look and her photo habits, for every prompt where she decides what a photo of
 * her is. Those prompts used to get her dossier alone, so the one thing a photo on this app is
 * for - her body, shown the way she likes it shown - came out generic: no word of what she is
 * proudest of, what she wears underneath, or where a woman with her style takes her pictures
 * (see clothing_style extra.photo_scene).
 */
export function photoSelfBlock(seed: CharacterSeed): string {
  const label = (cat: string, id: string | undefined) => (id ? find(cat, id)?.label ?? id : '');
  const hintOf = (cat: string, id: string | undefined) => (id ? find(cat, id)?.prompt_hint ?? '' : '');
  const style = find('clothing_style', seed.clothing_style);
  const pride = find('body_pride', seed.body_pride);
  const ink = seed.tattoos.map((t) => `${label('tattoo_motif', t.motif)} (${label('tattoo_position', t.position)})`);
  const metal = seed.piercings.map((p) => `${label('piercing_type', p.type)} (${label('piercing_position', p.position)})`);
  return [
    `How you look: ${seed.appearance_prompt}`,
    `Your figure: ${[label('body_type', seed.body_type), label('breast_size', seed.breast_size) && `${label('breast_size', seed.breast_size).toLowerCase()} breasts`, label('butt_size', seed.butt_size) && `${label('butt_size', seed.butt_size).toLowerCase()} butt`].filter(Boolean).join(', ')}`,
    style ? `Your style: ${style.label} - ${style.prompt_hint}` : '',
    style?.extra?.photo_scene ? `Where your photos tend to happen: ${String(style.extra.photo_scene)}` : '',
    pride ? `What you are proudest of: ${pride.label} - ${pride.prompt_hint || 'and your photos tend to show it off'}` : '',
    seed.lingerie_style ? `What you wear underneath: ${label('lingerie_style', seed.lingerie_style)} - ${hintOf('lingerie_style', seed.lingerie_style)}` : '',
    ink.length ? `Tattoos: ${ink.join('; ')}` : '',
    metal.length ? `Piercings: ${metal.join('; ')}` : '',
    `In bed: ${label('sexual_persona', seed.sexual_persona)}`,
    `How you come across in photos: ${photoManner(seed)}`,
  ].filter(Boolean).join('\n');
}

/** Sized like BIO_TOKENS in generator.ts - one real paragraph, from a reasoning model. */
const PROFILE_PIC_TOKENS = 4800;

/**
 * What her profile picture actually is, in her own words - asked once, lazily, the first
 * time she needs one rather than for every character rolled (most never reach this point).
 *
 * Before this, every profile picture got the same brief nobody gave it: `situation: ''`,
 * so the assembler had nothing to work from but "profile" and invented the same amateur
 * phone-selfie default every time. A dating profile in reality has professional headshots,
 * recycled work photos, posed shots a friend took, full-body outfit pictures, alongside
 * the selfies - and which one a given woman leads with says something about her. Asking
 * her, rather than deciding for her, is what makes that variance real instead of a coin
 * flip in code.
 */
async function profilePicConcept(character: Character): Promise<string> {
  try {
    const out = await completeJson<{ profile_pic?: string }>({
      scope: 'image',
      label: `profile_pic_concept:${character.username}`,
      config: { ...getSettings().models.actor, max_tokens: PROFILE_PIC_TOKENS },
      require: ['profile_pic'],
      messages: [
        {
          role: 'user',
          content: render('actor_profile_pic', {
            real_name: character.real_name,
            dossier: character.seed.hints.dossier || describeSeed(character.seed),
            photo_self: photoSelfBlock(character.seed),
            profile_heat: profileHeat(character.seed),
          }),
        },
      ],
    });
    const concept = (out.profile_pic ?? '').trim();
    if (concept) return concept;
  } catch (err) {
    logger.warn('image', 'profile picture concept failed, using a generic default', {
      character: character.username,
      error: String(err),
    });
  }
  return DEFAULT_SITUATION.profile;
}

type ImageJobOptions = {
  characterId: string;
  kind: 'profile' | 'chat' | 'spicy' | 'date';
  /** Only for a 'date' kind job: which date's own transcript the result posts into. */
  dateId?: string | null;
  situation: string;
  /** Ignored for a profile picture, which is always square. Defaults to portrait. */
  aspect?: 'portrait' | 'landscape' | null;
  /** False only for a shot that deliberately does not put her face in frame. Defaults true. */
  showsFace?: boolean;
  postToChat?: boolean;
};

function insertImageJob(opts: ImageJobOptions): ImageJob {
  const id = randomUUID();
  const aspect = opts.kind === 'profile' ? null : opts.aspect ?? 'portrait';
  db.prepare(
    `INSERT INTO images (id, character_id, kind, prompt, seed, ref_image, status, path, error, aspect, shows_face, situation, date_id, created_at, updated_at)
     VALUES (?, ?, ?, '', NULL, NULL, 'queued', NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, opts.characterId, opts.kind, aspect, opts.showsFace === false ? 0 : 1, opts.situation,
    opts.dateId ?? null, nowIso(), nowIso(),
  );
  return getImageJob(id)!;
}

export function enqueueImage(opts: ImageJobOptions): ImageJob {
  const job = insertImageJob(opts);
  void runImageJob(job.id, opts.situation, opts.postToChat !== false);
  return job;
}

export async function runImageJob(id: string, situation: string, postToChat = true): Promise<void> {
  const job = getImageJob(id);
  if (!job) return;
  const settings = getSettings();
  if (!settings.images_enabled) {
    setStatus(id, 'failed', { error: 'image generation is disabled in settings' });
    return;
  }
  const character = job.character_id ? getCharacter(job.character_id) : null;
  if (!character) {
    setStatus(id, 'failed', { error: 'character not found' });
    return;
  }

  setStatus(id, 'running');
  try {
    // The one photo she leads with has no "right now" to describe, so nothing upstream
    // ever gave it a situation - it arrived here as ''. Asking her what it actually is
    // happens once, lazily, right where that gap used to go unfilled.
    const isProfile = job.kind === 'profile';
    const isDate = job.kind === 'date';
    const isSpicy = job.kind === 'spicy';
    if (isProfile && !situation.trim()) {
      situation = await profilePicConcept(character);
    }
    // Resolved once here - persisted so a later regenerate ("same idea") has the actual
    // idea to reassemble from, not the blank a profile job may have started with.
    db.prepare('UPDATE images SET situation = ? WHERE id = ?').run(situation, id);

    const facesCamera = isProfile || showsFace(job);
    const promptStyle: PromptStyle = settings.models.image.prompt_style === 'z_image_turbo' ? 'z_image_turbo' : 'seedream';

    // Candid phone-photo texture only applies to a moment inside the conversation. A
    // profile picture's style - polished headshot or grainy selfie - was already decided
    // by the assembler from her own account of the photo, so forcing the candid suffix on
    // top would fight a studio shot into looking like a bad phone photo. A date's arrival
    // photo is neither: nobody's phone took it, so it gets DATE_SUFFIX instead of the candid
    // one. Computed before the assembler call, not after, because Z Image Turbo needs to know
    // how much of its own character budget this suffix is going to eat - see zCharBudget below.
    // FLATTERING_SUFFIX rides with the profile picture only - see its own comment for why
    // asking every candid for a flattering angle was most of what made them read as shot
    // rather than taken.
    const styleSuffix = isProfile
      ? `${BASE_SUFFIX[promptStyle]} ${FLATTERING_SUFFIX}`
      : isDate
        ? `${BASE_SUFFIX[promptStyle]} ${DATE_SUFFIX[promptStyle]}`
        : isSpicy
          ? `${BASE_SUFFIX[promptStyle]} ${SPICY_SUFFIX[promptStyle]}`
          : `${BASE_SUFFIX[promptStyle]} ${CANDID_SUFFIX[promptStyle]}`;
    // Drawn per shot rather than left to the assembler's taste - see LIGHT_CONDITIONS.
    const conditions = shootingConditions(isProfile ? 'profile' : isDate ? 'date' : isSpicy ? 'spicy' : 'moment');
    // The provider this goes through hard-rejects a Z Image Turbo prompt over roughly 1200
    // characters - not a soft quality preference, an actual request error. That leaves the
    // assembler only whatever headroom styleSuffix does not already spend, plus a safety
    // margin for the joining space. Handed to it as a concrete number rather than a vague
    // "keep it short", because "this model likes long prompts" is the model's general
    // reputation and directly wrong for this specific limit.
    const zCharBudget = Z_IMAGE_MAX_CHARS - styleSuffix.length - 1;

    const assembled = await completeJson<{ prompt: string; negative_prompt?: string }>({
      scope: 'image',
      label: `assemble:${character.username}`,
      config: settings.models.director,
      require: ['prompt'],
      messages: [
        {
          role: 'user',
          content: render('image_prompt_assembler', {
            appearance_prompt: character.seed.appearance_prompt,
            image_kind: job.kind,
            situation,
            visible_marks: visibleMarks(character, job.kind, facesCamera),
            demeanour: demeanourFor(character.seed, isProfile),
            light_condition: conditions.light,
            capture_flaw: conditions.flaw,
            lived_in_detail: conditions.lived_in,
            // Only a profile picture gets to be a professional shot, a repurposed work
            // photo, a posed full-body - anything her own account above says it is. A
            // chat or spicy photo is always a moment inside the conversation, so it keeps
            // the candid, taken-right-now rules regardless of what image_kind spells out. A
            // date's arrival photo is neither of those - see is_date below.
            is_profile: isProfile ? '1' : '',
            // A spicy photo is posed on purpose and gets its own section (is_spicy); the
            // "unposed, caught in the moment" rules are for an ordinary chat photo only.
            is_moment: !isProfile && !isDate && !isSpicy ? '1' : '',
            // Not a photo either of them took: how he actually sees her, right now, in the
            // room - see image_prompt_assembler.md's is_date section for the framing this
            // maps to.
            is_date: isDate ? '1' : '',
            // A profile picture always shows her face by convention; a chat/spicy/date shot
            // only when she did not deliberately pick one that hides it.
            hides_face: facesCamera ? '' : '1',
            // The one tier that can plausibly reach nudity at all - see "HOW FAR THIS ONE
            // ACTUALLY GOES" in the template for what that does and does not mean.
            is_spicy: isSpicy ? '1' : '',
            // Only her own photos lean on her style's usual photo world (clothing_style
            // extra.photo_scene) - a date's arrival photo is in the venue, not her room.
            photo_scene: isDate ? '' : String(find('clothing_style', character.seed.clothing_style)?.extra?.photo_scene ?? ''),
            mode_seedream: promptStyle === 'seedream' ? '1' : '',
            mode_z_image: promptStyle === 'z_image_turbo' ? '1' : '',
            z_char_budget: zCharBudget,
          }),
        },
      ],
    });

    // Plain sentences joined as prose, not comma-glued tags - this model reasons over the
    // prompt as a written brief, and a tag-stack tail would undo the paragraph the assembler
    // just wrote.
    //
    // The instruction above is a request, not an enforcement - the model can still ignore
    // the budget, so this is the actual backstop against a rejected API call. Trims the
    // assembler's own text, never styleSuffix: styleSuffix is short and carries standing
    // quality/style instructions that matter on every single shot, where the assembler's
    // prose is the one part that is safe to lose the tail end of.
    let assembledPrompt = assembled.prompt;
    if (promptStyle === 'z_image_turbo' && assembledPrompt.length > zCharBudget) {
      logger.warn('image', 'z_image_turbo prompt over the character budget, trimming', {
        character: character.username,
        length: assembledPrompt.length,
        budget: zCharBudget,
      });
      assembledPrompt = truncateAtWord(assembledPrompt, zCharBudget);
    }
    const prompt = `${assembledPrompt} ${styleSuffix}`;
    // Z Image Turbo runs with no classifier-free guidance at all, so it never reads a
    // negative prompt - sending one is not wrong exactly, just pure dead weight, and the
    // constraints it would have carried are already folded into the prompt itself above
    // (see BASE_SUFFIX/CANDID_SUFFIX and the assembler's own negative_prompt, left blank in
    // this mode). Seedream gets the real thing: the assembler has always returned a negative
    // prompt and it used to be dropped on the floor here - never passed to the image call at
    // all. Its shot-specific negative now rides along with the standing ones. CANDID_NEGATIVE
    // (no studio lighting, no professional-model posing) only applies to a moment shot, for
    // the same reason. Kept short throughout: see BASE_NEGATIVE for why.
    const negative =
      promptStyle === 'z_image_turbo'
        ? ''
        : [assembled.negative_prompt, BASE_NEGATIVE, isProfile ? null : isSpicy ? SPICY_NEGATIVE : CANDID_NEGATIVE]
            .filter(Boolean)
            .join(' ');
    // Forcing her face to match a reference photo is exactly wrong for a shot that is not
    // supposed to show her face at all - it just makes one appear anyway. Skip the
    // reference whenever this shot does not put her face in frame.
    const ref = isProfile || !facesCamera ? null : referenceImage(character.id);
    // Only when one is actually attached - see REF_NOTE for why the reference needs telling
    // what it is for. Appended after styleSuffix so it is the last thing read, and left off
    // the Z Image Turbo budget maths above on purpose: that mode never sends a reference at
    // all unless a profile picture exists, and the same trim still protects the ceiling.
    const finalPrompt = ref ? `${prompt} ${REF_NOTE}` : prompt;
    const size = isProfile ? IMAGE_SIZE.profile : IMAGE_SIZE[job.aspect === 'landscape' ? 'landscape' : 'portrait'];
    const imageSeed = seedFor(character.seed, isProfile);
    const b64 = await generateImage({
      prompt: finalPrompt,
      negativePrompt: negative,
      seed: imageSeed,
      refImage: ref ?? undefined,
      size,
    });

    const relPath = join('images', `${id}.png`);
    writeFileSync(join(DATA_DIR, relPath), Buffer.from(b64, 'base64'));
    // The log records what was actually sent, reference note and per-shot seed included -
    // otherwise two shots that came out identical would show identical log rows for no
    // visible reason.
    db.prepare('UPDATE images SET prompt = ?, seed = ?, ref_image = ? WHERE id = ?').run(
      finalPrompt,
      imageSeed,
      ref ? 'profile' : null,
      id,
    );
    setStatus(id, 'done', { path: relPath });

    if (postToChat) {
      const stored = addMessage({
        character_id: character.id,
        // A date's arrival photo is not something she chose to send - it is the scene
        // itself, the same way the "you took her to X" line at the top of a date is. Every
        // other kind is genuinely her sending a picture, so it keeps 'character'.
        sender: isDate ? 'system' : 'character',
        text: '',
        kind: 'image',
        // What the photo shows, so later prompts know what she actually sent.
        meta: { image_id: id, path: relPath, description: situation },
        read_at: null,
        date_id: job.date_id,
      });
      bus.emitEvent({ type: 'message', character_id: character.id, message: stored });
    }
    if (job.kind === 'profile') {
      const rel = getRelationship(character.id);
      if (rel) {
        rel.flags.state.profile_picture_sent = true;
        db.prepare('UPDATE relationships SET flags = ? WHERE character_id = ?').run(
          JSON.stringify(rel.flags),
          character.id,
        );
      }
    }
  } catch (err) {
    logger.error('image', `image job ${id} failed`, { error: String(err) });
    setStatus(id, 'failed', { error: String(err) });
  }
}

export async function retryImageJob(id: string): Promise<void> {
  const job = getImageJob(id);
  if (!job) throw new Error('image job not found');
  setStatus(id, 'queued', { error: null });
  // Retry means "try the same thing again", so it reuses the situation actually resolved
  // last time - not job.prompt, which is the FINAL assembled tag/prose string with the
  // style suffix already baked in, not something fit to feed back into the assembler as a
  // fresh situation. A job that never got that far (failed before resolving one at all)
  // falls back to blank, which is what lets a profile job's lazy profilePicConcept() run.
  await runImageJob(id, job.situation ?? '', true);
}

/** Sized like PROFILE_PIC_TOKENS - one real paragraph, from a reasoning model. */
const PHOTO_IDEA_TOKENS = 2400;

/**
 * A fresh idea for a chat/spicy photo, in her own words - used only by regenerateImage()'s
 * "new idea" mode. Mirrors profilePicConcept() but for the two tiers that come after the
 * profile picture, where the "idea" is normally just whatever she offered in the moment
 * rather than something asked for in isolation like this.
 */
async function freshPhotoIdea(
  character: Character,
  kind: 'chat' | 'spicy',
): Promise<{ situation: string; aspect: 'portrait' | 'landscape' }> {
  try {
    const out = await completeJson<{ situation?: string; aspect?: string }>({
      scope: 'image',
      label: `photo_idea:${character.username}`,
      config: { ...getSettings().models.actor, max_tokens: PHOTO_IDEA_TOKENS },
      require: ['situation'],
      messages: [
        {
          role: 'user',
          content: render('actor_photo_idea', {
            real_name: character.real_name,
            dossier: character.seed.hints.dossier || describeSeed(character.seed),
            photo_self: photoSelfBlock(character.seed),
            is_spicy: kind === 'spicy' ? '1' : '',
            is_chat: kind === 'chat' ? '1' : '',
          }),
        },
      ],
    });
    const situation = (out.situation ?? '').trim();
    if (situation) return { situation, aspect: out.aspect === 'landscape' ? 'landscape' : 'portrait' };
  } catch (err) {
    logger.warn('image', 'fresh photo idea failed, using a generic default', {
      character: character.username,
      kind,
      error: String(err),
    });
  }
  return { situation: DEFAULT_SITUATION[kind], aspect: 'portrait' };
}

/**
 * Regenerates an already-finished photo in place - same job id, same file path, so the chat
 * bubble and gallery entry that already point at it pick up the new one automatically.
 *
 * "same_idea" reassembles from the situation actually resolved last time: a fresh run
 * through the assembler and the image model, same content, different pixels. "new_idea"
 * asks her to think of a different photo altogether first - profilePicConcept() again for a
 * profile picture, freshPhotoIdea() for a chat/spicy one - before doing the same.
 */
export async function regenerateImage(id: string, mode: 'same_idea' | 'new_idea'): Promise<void> {
  const job = getImageJob(id);
  if (!job) throw new Error('image job not found');
  const character = job.character_id ? getCharacter(job.character_id) : null;
  if (!character) throw new Error('character not found');
  const kind = job.kind as 'profile' | 'chat' | 'spicy' | 'date';

  let situation: string;
  let aspect = job.aspect;
  if (mode === 'new_idea') {
    if (kind === 'profile') {
      situation = await profilePicConcept(character);
    } else if (kind === 'chat' || kind === 'spicy') {
      const idea = await freshPhotoIdea(character, kind);
      situation = idea.situation;
      aspect = idea.aspect;
    } else {
      // A date's arrival photo has no separate "fresh idea" - what she is wearing is
      // decided once for the whole evening (dates.ts's decideDateOutfit), not per photo, so
      // "new idea" here just reassembles the same one rather than inventing an unrelated shot.
      situation = job.situation || DEFAULT_SITUATION.date;
    }
  } else {
    situation = job.situation || DEFAULT_SITUATION[kind];
  }

  if (aspect !== job.aspect) {
    db.prepare('UPDATE images SET aspect = ? WHERE id = ?').run(aspect, id);
  }
  setStatus(id, 'queued', { error: null });
  // No new chat message - this job already delivered one (or this is a gallery-only shot),
  // and it keeps the same id and file path, so that bubble just shows the new bytes once
  // they land. See the cache-bust bump below for why it actually does.
  await runImageJob(id, situation, false);

  const done = getImageJob(id);
  if (done?.status !== 'done') return;
  const msg = findMessageByImageId(id);
  if (!msg) return;
  // The path on disk did not change, so without this the browser would just keep showing
  // the image it already cached under that exact URL. Bumping a version marker into the
  // message's own meta - rather than touching the images.path column - is what makes the
  // URL change without needing a second file on disk per regeneration.
  const updated = updateMessageMeta(msg.id, { image_v: Date.now() });
  if (updated) bus.emitEvent({ type: 'message_updated', character_id: character.id, message: updated });
}

/** Used only when the Actor left no concrete detail to work from. */
const DEFAULT_SITUATION: Record<'profile' | 'chat' | 'spicy' | 'date', string> = {
  profile: 'a flirty mirror selfie in something tight that shows off her figure',
  chat: 'a casual photo of whatever she is doing right now',
  spicy: 'a mirror selfie in just her underwear, one arm across her chest, taken for him',
  date: 'how she looks as he arrives, whatever she decided to wear tonight',
};

/**
 * The Director has vision: it looks at what he sent so she can react to what is actually in
 * it. The description is stored on his message so every later prompt can see it too.
 */
export async function evaluateUserImage(
  characterId: string,
  messageId: number,
  base64: string,
  mimeType: string,
): Promise<void> {
  const character = getCharacter(characterId);
  const rel = getRelationship(characterId);
  if (!character || !rel) throw new Error('character not found');
  const settings = getSettings();
  const { historyBlock, seedBlock } = await import('./blocks.js');
  const { recentMessages, getUserProfile } = await import('../repo.js');

  const text = render('director_evaluate_image', {
    char_real_name: character.real_name,
    seed_block: seedBlock(character),
    arousal: rel.arousal,
    history_block: historyBlock(recentMessages(characterId, 12), character, getUserProfile()),
  });

  const result = await completeJson<{
    description?: string; arousal_delta?: number; ledger_fact?: string | null; reaction_hint?: string;
  }>({
    scope: 'director',
    label: `evaluate_image:${character.username}`,
    config: settings.models.director,
    require: ['description'],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });
  logger.info('director', 'image evaluated', result);

  const description = String(result.description ?? '').trim();
  if (description) updateMessageMeta(messageId, { description, reaction_hint: result.reaction_hint ?? null });
  const fresh = getRelationship(characterId);
  if (!fresh) return;
  const delta = Math.max(-20, Math.min(30, Number(result.arousal_delta ?? 0) || 0));
  fresh.arousal = Math.max(0, Math.min(100, fresh.arousal + delta));
  if (result.ledger_fact) {
    fresh.ledger.facts.about_user = [...new Set([...(fresh.ledger.facts.about_user ?? []), String(result.ledger_fact)])].slice(-60);
  }
  saveRelationship(fresh);
}
