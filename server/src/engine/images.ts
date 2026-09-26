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
  messagesInChoiceGroup,
  getCharacter,
  getRelationship,
  saveRelationship,
  updateMessageMeta,
} from '../repo.js';
import { render } from '../prompts/render.js';
import { find } from '../db/attributes.js';
import { pickOne, randInt } from './dice.js';
import { describeSeed } from './generator.js';
import { chatPhotoLine, photoManner, profileHeat } from './photolevel.js';
export { profileHeat, profileLevel, chatPhotoLevel, photoManner } from './photolevel.js';
import type { Character, CharacterSeed, Relationship } from '../types.js';
import { IMAGE_PROMPT, IMAGE_REVIEW, PHOTO_IDEA, PROFILE_PIC } from '../llm/schemas.js';
import { speciesRow, speciesVisibility } from './species.js';

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
/**
 * Where her profile picture stands. 'failed' means every attempt so far failed and none is
 * running: the one state where he needs a button to ask again, because the button that started
 * it is gone once pressed - a 503 from the provider used to leave her an emoji for good.
 */
export function profilePictureState(characterId: string): 'none' | 'working' | 'done' | 'failed' {
  const live = db
    .prepare("SELECT status FROM images WHERE character_id = ? AND kind = 'profile' AND status != 'failed' ORDER BY rowid ASC LIMIT 1")
    .get(characterId) as { status: string } | undefined;
  if (live) return live.status === 'done' ? 'done' : 'working';
  const failed = db.prepare("SELECT 1 FROM images WHERE character_id = ? AND kind = 'profile' LIMIT 1").get(characterId);
  return failed ? 'failed' : 'none';
}

/**
 * A photo that failed before it had a bubble - preparing a chat photo, or a date's arrival
 * photo - still gets one, marked as failed, so "Show photo" can try it again. Without it the
 * failure was invisible: her message said a photo was coming and nothing ever arrived.
 */
function postFailedPlaceholder(job: ImageJob, characterId: string, caption: string, extraMeta: Record<string, unknown> = {}): void {
  if (findMessageByImageId(job.id)) return;
  const stored = addMessage({
    character_id: characterId,
    sender: job.kind === 'date' ? 'system' : 'character',
    text: '',
    kind: 'image',
    meta: {
      image_id: job.id, pending: true, caption, description: job.situation ?? caption, aspect: job.aspect,
      render_error: 'That one did not come through. Try again.', ...extraMeta,
    },
    read_at: null,
    date_id: job.date_id ?? null,
  });
  bus.emitEvent({ type: 'message', character_id: characterId, message: stored });
}

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
 * She sends him a photo. No consent card, no unlock: she decided to, so it is sent - but only
 * prepared, not rendered. Her idea, the full prompt and a one-line caption are built now and a
 * placeholder bubble goes into the chat; the image model, the part that costs real money, only
 * runs when he taps "show photo" (showPhoto below). She can send as many as she likes, and he
 * decides which ones are worth paying for.
 */
export async function sendPhoto(opts: {
  characterId: string;
  kind: 'chat' | 'spicy';
  situation: string;
  aspect: PhotoAspect | null;
  showsFace: boolean;
}): Promise<void> {
  if (!photosEnabled()) return;
  await preparePhoto(opts, {});
}

/**
 * "Red set or black?" - she offers two photos and he picks which one he sees. Both are
 * prepared (prompt and caption, no image), posted as two placeholders in one choice group;
 * picking one renders it and sets the other aside (showPhoto below). Still one image to pay for.
 */
export async function sendPhotoChoice(opts: {
  characterId: string;
  kind: 'chat' | 'spicy';
  options: string[];
  aspect: PhotoAspect | null;
  showsFace: boolean;
}): Promise<void> {
  if (!photosEnabled()) return;
  const group = randomUUID();
  // In order, so the two bubbles land in the order she named them.
  for (const [i, situation] of opts.options.slice(0, 2).entries()) {
    await preparePhoto({ ...opts, situation }, { choice_group: group, choice_index: i });
  }
}

async function preparePhoto(
  opts: { characterId: string; kind: 'chat' | 'spicy'; situation: string; aspect: PhotoAspect | null; showsFace: boolean },
  extraMeta: Record<string, unknown>,
): Promise<void> {
  const job = insertImageJob({
    characterId: opts.characterId,
    kind: opts.kind,
    situation: opts.situation || DEFAULT_SITUATION[opts.kind],
    aspect: opts.aspect,
    showsFace: opts.showsFace,
  });
  const loaded = loadJob(job.id);
  if (!loaded) return;
  setStatus(job.id, 'running');
  try {
    const shot = await assembleImageJob(loaded.job, loaded.character, job.situation ?? '');
    setStatus(job.id, 'pending');
    const stored = addMessage({
      character_id: loaded.character.id,
      sender: 'character',
      text: '',
      kind: 'image',
      // description is what later prompts read to know what she sent; caption is all he sees
      // until he chooses to look.
      meta: { image_id: job.id, pending: true, caption: shot.caption, description: shot.situation, aspect: job.aspect, ...extraMeta },
      read_at: null,
      date_id: null,
    });
    bus.emitEvent({ type: 'message', character_id: loaded.character.id, message: stored });
  } catch (err) {
    logger.error('image', `preparing photo ${job.id} failed`, { error: String(err) });
    setStatus(job.id, 'failed', { error: String(err) });
    postFailedPlaceholder(loaded.job, loaded.character.id, cleanCaption('', job.situation ?? ''), extraMeta);
  }
}

/**
 * He tapped "show photo": render the prompt prepared when she sent it. Returns as soon as the
 * bubble is marked as developing; the finished image arrives as a message_updated event. Her
 * profile picture is made first if it somehow does not exist yet, so this one can match her
 * face.
 */
export async function showPhoto(imageId: string): Promise<void> {
  const job = getImageJob(imageId);
  if (!job) throw new Error('photo not found');
  if (job.status === 'done' || job.status === 'running') return;
  if (findMessageByImageId(imageId)?.meta?.declined) throw new Error('he already picked the other one');
  const loaded = loadJob(imageId);
  if (!loaded) throw new Error(getImageJob(imageId)?.error ?? 'image generation is unavailable');
  const message = findMessageByImageId(imageId);
  const mark = (patch: Record<string, unknown>) => {
    if (!message) return;
    const updated = updateMessageMeta(message.id, patch);
    if (updated) bus.emitEvent({ type: 'message_updated', character_id: loaded.character.id, message: updated });
  };
  // One of two she offered: he picked this one, so the other is set aside - it stays in the
  // chat as "not picked", and later prompts know which one he chose.
  if (message?.meta?.choice_group) {
    for (const other of messagesInChoiceGroup(String(message.meta.choice_group))) {
      if (other.id === message.id || other.meta?.declined) continue;
      const updated = updateMessageMeta(other.id, {
        declined: true,
        description: `${other.meta?.description ?? 'a photo'} (she offered it, he picked the other one)`,
      });
      if (updated) bus.emitEvent({ type: 'message_updated', character_id: loaded.character.id, message: updated });
    }
  }
  setStatus(imageId, 'running');
  mark({ rendering: true, render_error: null });
  void (async () => {
    try {
      await ensureProfilePicture(loaded.character.id);
      // A photo whose preparation failed has no prompt yet: prepare it now, from what she
      // said she was sending.
      const shot = job.prompt
        ? { prompt: job.prompt, negative: job.negative_prompt ?? '', caption: job.caption ?? '', situation: job.situation ?? '' }
        : await assembleImageJob(loaded.job, loaded.character, job.situation ?? '');
      await renderImageJob(loaded.job, loaded.character, shot, true);
    } catch (err) {
      logger.error('image', `showing photo ${imageId} failed`, { error: String(err) });
      setStatus(imageId, 'failed', { error: String(err) });
      mark({ rendering: false, render_error: 'That one did not come through. Try again.' });
    }
  })();
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
const FLATTERING_SUFFIX = 'Framed from the waist up or closer, her face sharp, clearly lit and fully visible, from a flattering angle.';

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
  'Her phone flash straight on at arm\'s length, her skin lit bright and flat, the room behind her falling into dark.',
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

/** The frames a photo in the chat can come in - her call, from what the shot actually is. */
export type PhotoAspect = 'square' | 'portrait' | 'landscape';
export const PHOTO_ASPECTS = new Set<PhotoAspect>(['square', 'portrait', 'landscape']);

/**
 * Resolution per shot, fixed by kind where the kind decides it:
 * - a profile picture is always square: the main photo slot is square everywhere, and it is
 *   the identity reference every later photo is matched to;
 * - a date's arrival photo is always 2:3 portrait: it shows her whole outfit, head to shoes;
 * - a photo she sends in the chat is her call (see photo_aspect on ActorHidden): square for a
 *   close selfie or a detail, 2:3 portrait for a mirror or outfit shot, 3:2 landscape for a
 *   view or a wider scene.
 *
 * Exported because locations.ts's backdrop reuses `portrait` directly: the provider silently
 * squared off a "1152x2048" request that was never actually on its supported list, and the
 * one resolution already confirmed working for a tall shot is this one.
 */
export const IMAGE_SIZE: Record<'profile' | PhotoAspect, string> = {
  profile: '2048x2048',
  square: '2048x2048',
  portrait: '2048x3072',
  landscape: '3072x2048',
};

function sizeFor(job: Pick<ImageJob, 'kind' | 'aspect'>): string {
  if (job.kind === 'profile') return IMAGE_SIZE.profile;
  if (job.kind === 'date') return IMAGE_SIZE.portrait;
  return IMAGE_SIZE[job.aspect && PHOTO_ASPECTS.has(job.aspect) ? job.aspect : 'portrait'];
}

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
        ? `Left to choose her own photo, she picks one like this: ${photo}. Keep the manner; the ` +
          `crop is fixed for this one (waist up or closer, her whole face clear), so a distance or ` +
          `an averted body in that line means an angle, not a smaller or hidden face.`
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
  /** 'pending': prepared (prompt built) and waiting for him to choose to see it. */
  status: 'queued' | 'running' | 'pending' | 'done' | 'failed';
  path: string | null;
  error: string | null;
  aspect: PhotoAspect | null;
  /** Stored as 0/1 by sqlite. Use showsFace() rather than reading this raw. */
  shows_face: number;
  /** The idea the photo is of, resolved (never the blank the Actor may have offered with). */
  situation: string | null;
  /** Set only for a 'date' kind job: which date's transcript this posts into. */
  date_id: string | null;
  /** Stored with the prompt, so a prepared photo renders later with exactly what was built. */
  negative_prompt: string | null;
  /** One short sentence for the placeholder bubble. */
  caption: string | null;
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
  const species = speciesRow(character.seed);
  if (species) {
    // For a superpower the hero role decides the tier (species.ts).
    const speciesVis = speciesVisibility(character.seed);
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
 * Her body, her look and her photo habits, for every prompt where she decides what a photo of
 * her is. Those prompts used to get her dossier alone, so the one thing a photo on this app is
 * for - her body, shown the way she likes it shown - came out generic: no word of what she is
 * proudest of, what she wears underneath, or where a woman with her style takes her pictures
 * (see clothing_style extra.photo_scene).
 */
export function photoSelfBlock(seed: CharacterSeed, opts: { profile?: boolean } = {}): string {
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
    // Her chat level only - her profile picture has its own, tamer one (profileHeat).
    opts.profile ? '' : `How far your photos to him usually go: ${chatPhotoLine(seed)}`,
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
      schema: PROFILE_PIC,
      config: { ...getSettings().models.actor, max_tokens: PROFILE_PIC_TOKENS },
      require: ['profile_pic'],
      messages: [
        {
          role: 'user',
          content: render('actor_profile_pic', {
            real_name: character.real_name,
            dossier: character.seed.hints.dossier || describeSeed(character.seed),
            photo_self: photoSelfBlock(character.seed, { profile: true }),
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
  aspect?: PhotoAspect | null;
  /** False only for a shot that deliberately does not put her face in frame. Defaults true. */
  showsFace?: boolean;
  postToChat?: boolean;
};

function insertImageJob(opts: ImageJobOptions): ImageJob {
  const id = randomUUID();
  // Fixed by kind where the kind decides it - see IMAGE_SIZE.
  const aspect = opts.kind === 'profile' ? 'square' : opts.kind === 'date' ? 'portrait' : opts.aspect ?? 'portrait';
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

interface AssembledShot {
  prompt: string;
  negative: string;
  caption: string;
  situation: string;
}

function loadJob(id: string): { job: ImageJob; character: Character } | null {
  const job = getImageJob(id);
  if (!job) return null;
  if (!getSettings().images_enabled) {
    setStatus(id, 'failed', { error: 'image generation is disabled in settings' });
    return null;
  }
  const character = job.character_id ? getCharacter(job.character_id) : null;
  if (!character) {
    setStatus(id, 'failed', { error: 'character not found' });
    return null;
  }
  return { job, character };
}

/** Assemble and render in one go: her profile picture, a date's arrival photo, retries and regenerations. */
export async function runImageJob(id: string, situation: string, postToChat = true): Promise<void> {
  const loaded = loadJob(id);
  if (!loaded) return;
  setStatus(id, 'running');
  try {
    const shot = await assembleImageJob(loaded.job, loaded.character, situation);
    await renderImageJob(loaded.job, loaded.character, shot, postToChat);
  } catch (err) {
    logger.error('image', `image job ${id} failed`, { error: String(err) });
    setStatus(id, 'failed', { error: String(err) });
    // Her profile picture is never a chat bubble; its retry is the camera button (see
    // profilePictureState). Anything else that was meant to land in a chat gets a bubble.
    if (postToChat && loaded.job.kind !== 'profile') {
      postFailedPlaceholder(loaded.job, loaded.character.id, loaded.job.kind === 'date' ? 'Her photo as you arrive' : cleanCaption('', situation));
    }
  }
}

/** One short sentence for the placeholder bubble - never the prompt itself. */
function cleanCaption(raw: unknown, situation: string): string {
  const pick = (t: string) => (t.replace(/\s+/g, ' ').trim().match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim();
  const text = pick(String(raw ?? '')) || pick(situation);
  return text.length > 140 ? `${truncateAtWord(text, 137)}...` : text;
}

/**
 * Everything up to the image model: her idea resolved, the assembler's prompt, the suffixes and
 * negatives, and a one-line caption. Stored on the job, so a photo can be prepared now and
 * rendered later, from exactly the prompt that was built for the moment she sent it.
 */
async function assembleImageJob(job: ImageJob, character: Character, situation: string): Promise<AssembledShot> {
  const settings = getSettings();
  const id = job.id;
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

  const assembled = await completeJson<{ prompt: string; negative_prompt?: string; caption?: string }>({
    scope: 'image',
    label: `assemble:${character.username}`,
    schema: IMAGE_PROMPT,
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
  const caption = cleanCaption(assembled.caption, situation);
  db.prepare('UPDATE images SET prompt = ?, negative_prompt = ?, caption = ? WHERE id = ?').run(prompt, negative, caption, id);
  return { prompt, negative, caption, situation };
}

/** The paid part: the image model call, the file, and the chat bubble. */
async function renderImageJob(job: ImageJob, character: Character, shot: AssembledShot, postToChat: boolean): Promise<void> {
  const id = job.id;
  const isProfile = job.kind === 'profile';
  const isDate = job.kind === 'date';
  const facesCamera = isProfile || showsFace(job);
  const { prompt, negative, situation } = shot;
  // Forcing her face to match a reference photo is exactly wrong for a shot that is not
  // supposed to show her face at all - it just makes one appear anyway. Skip the
  // reference whenever this shot does not put her face in frame.
  const ref = isProfile || !facesCamera ? null : referenceImage(character.id);
  // Only when one is actually attached - see REF_NOTE for why the reference needs telling
  // what it is for. Appended after styleSuffix so it is the last thing read, and left off
  // the Z Image Turbo budget maths above on purpose: that mode never sends a reference at
  // all unless a profile picture exists, and the same trim still protects the ceiling.
  const finalPrompt = ref ? `${prompt} ${REF_NOTE}` : prompt;
  const size = sizeFor(job);
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

  // A photo she sent into the chat already has its message - the placeholder he tapped "show
  // photo" on - so that bubble is filled in rather than a second one posted under it.
  const placeholder = postToChat ? findMessageByImageId(id) : null;
  if (placeholder) {
    const updated = updateMessageMeta(placeholder.id, {
      path: relPath, pending: false, rendering: false, render_error: null, image_v: Date.now(),
    });
    if (updated) bus.emitEvent({ type: 'message_updated', character_id: character.id, message: updated });
  } else if (postToChat) {
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
  // Her profile picture was never a chat message; retrying it from the Settings list used to
  // post it into her chat as a photo she sent.
  await runImageJob(id, job.situation ?? '', job.kind !== 'profile');
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
): Promise<{ situation: string; aspect: PhotoAspect }> {
  try {
    const out = await completeJson<{ situation?: string; aspect?: string }>({
      scope: 'image',
      label: `photo_idea:${character.username}`,
      schema: PHOTO_IDEA,
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
    if (situation) return { situation, aspect: PHOTO_ASPECTS.has(out.aspect as PhotoAspect) ? (out.aspect as PhotoAspect) : 'portrait' };
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
  profile: 'a flirty close selfie held high in something low-cut, looking up into the lens',
  chat: 'a casual photo of whatever she is doing right now',
  spicy: 'a selfie from above, lying on her bed in just her underwear, one arm across her chest, taken for him',
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
    schema: IMAGE_REVIEW,
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
