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
import { describeSeed } from './generator.js';
import type { Character, CharacterSeed, PendingPhoto } from '../types.js';

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
    'unretouched skin texture and a naturally attractive, flattering angle.',
  z_image_turbo:
    'Rendered as a photorealistic photograph, not an illustration, cgi render or anime ' +
    'style - real, unretouched skin with natural texture and pores, anatomically correct ' +
    'hands and limbs, and a naturally attractive, flattering angle.',
};

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
const CANDID_NEGATIVE = 'No studio lighting or posed professional-model styling.';

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
 */
const IMAGE_SIZE: Record<'profile' | 'portrait' | 'landscape', string> = {
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
 */
function demeanourFor(seed: CharacterSeed): string {
  const parts: string[] = [];
  const arch = find('archetype', seed.archetype);
  if (arch?.extra?.photo) parts.push(String(arch.extra.photo));

  // Off the attribute row, not a literal id switch. This used to check `seed.social_energy`
  // against a fixed { low, medium, high } map and `seed.humor_type` against two hardcoded id
  // lists - lists that named ids ("deadpan", "silly", "goofy", "playful") which do not
  // actually exist in personality.json, so neither humour branch had ever fired.
  const energy = find('social_energy', seed.social_energy)?.extra?.demeanour;
  if (energy) parts.push(String(energy));

  const humourDemeanour = find('humor_type', seed.humor_type)?.extra?.demeanour;
  if (humourDemeanour === 'undersold') parts.push('deliberately undersold expression');
  if (humourDemeanour === 'playful') parts.push('playful, mid-expression rather than posed');

  return parts.join(', ');
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

/**
 * Every finished picture of one character, newest first.
 *
 * Her profile shot is held back until the two of them have actually swapped, for the same
 * reason her avatar is: an image existing on disk is not the same as him being allowed to
 * look at it. In practice generation only starts from an accepted swap anyway, so this is
 * a guard for saves made before that existed rather than a live gate.
 */
export function characterGallery(characterId: string, swapped: boolean): ImageJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM images
       WHERE character_id = ? AND status = 'done' AND path IS NOT NULL
       ORDER BY rowid DESC`,
    )
    .all(characterId) as ImageJob[];
  return swapped ? rows : rows.filter((r) => r.kind !== 'profile');
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

export function enqueueImage(opts: {
  characterId: string;
  kind: 'profile' | 'chat' | 'spicy';
  situation: string;
  /** Ignored for a profile picture, which is always square. Defaults to portrait. */
  aspect?: 'portrait' | 'landscape' | null;
  /** False only for a shot that deliberately does not put her face in frame. Defaults true. */
  showsFace?: boolean;
  postToChat?: boolean;
}): ImageJob {
  const id = randomUUID();
  const aspect = opts.kind === 'profile' ? null : opts.aspect ?? 'portrait';
  db.prepare(
    `INSERT INTO images (id, character_id, kind, prompt, seed, ref_image, status, path, error, aspect, shows_face, situation, created_at, updated_at)
     VALUES (?, ?, ?, '', NULL, NULL, 'queued', NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, opts.characterId, opts.kind, aspect, opts.showsFace === false ? 0 : 1, opts.situation, nowIso(), nowIso());
  const job = getImageJob(id)!;
  void runImageJob(id, opts.situation, opts.postToChat !== false);
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
    // top would fight a studio shot into looking like a bad phone photo. Computed before the
    // assembler call, not after, because Z Image Turbo needs to know how much of its own
    // character budget this suffix is going to eat - see zCharBudget below.
    const styleSuffix = isProfile
      ? BASE_SUFFIX[promptStyle]
      : `${BASE_SUFFIX[promptStyle]} ${CANDID_SUFFIX[promptStyle]}`;
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
            demeanour: demeanourFor(character.seed),
            // Only a profile picture gets to be a professional shot, a repurposed work
            // photo, a posed full-body - anything her own account above says it is. A
            // chat or spicy photo is always a moment inside the conversation, so it keeps
            // the candid, taken-right-now rules regardless of what image_kind spells out.
            is_profile: isProfile ? '1' : '',
            is_moment: isProfile ? '' : '1',
            // A profile picture always shows her face by convention; a chat/spicy shot
            // only when she did not deliberately pick one that hides it.
            hides_face: facesCamera ? '' : '1',
            // The one tier that can plausibly reach nudity at all - see "HOW FAR THIS ONE
            // ACTUALLY GOES" in the template for what that does and does not mean.
            is_spicy: job.kind === 'spicy' ? '1' : '',
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
        : [assembled.negative_prompt, BASE_NEGATIVE, isProfile ? null : CANDID_NEGATIVE].filter(Boolean).join(' ');
    // Forcing her face to match a reference photo is exactly wrong for a shot that is not
    // supposed to show her face at all - it just makes one appear anyway. Skip the
    // reference whenever this shot does not put her face in frame.
    const ref = isProfile || !facesCamera ? null : referenceImage(character.id);
    const size = isProfile ? IMAGE_SIZE.profile : IMAGE_SIZE[job.aspect === 'landscape' ? 'landscape' : 'portrait'];
    const b64 = await generateImage({
      prompt,
      negativePrompt: negative,
      seed: character.seed.image_seed,
      refImage: ref ?? undefined,
      size,
    });

    const relPath = join('images', `${id}.png`);
    writeFileSync(join(DATA_DIR, relPath), Buffer.from(b64, 'base64'));
    db.prepare('UPDATE images SET prompt = ?, seed = ?, ref_image = ? WHERE id = ?').run(
      prompt,
      character.seed.image_seed,
      ref ? 'profile' : null,
      id,
    );
    setStatus(id, 'done', { path: relPath });

    if (postToChat) {
      const stored = addMessage({
        character_id: character.id,
        sender: 'character',
        text: '',
        kind: 'image',
        meta: { image_id: id, path: relPath },
        read_at: null,
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
  const kind = job.kind as 'profile' | 'chat' | 'spicy';

  let situation: string;
  let aspect = job.aspect;
  if (mode === 'new_idea') {
    if (kind === 'profile') {
      situation = await profilePicConcept(character);
    } else {
      const idea = await freshPhotoIdea(character, kind);
      situation = idea.situation;
      aspect = idea.aspect;
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
const DEFAULT_SITUATION: Record<'profile' | 'chat' | 'spicy', string> = {
  profile: 'a plain, friendly selfie for her profile',
  chat: 'a casual photo of whatever she is doing right now',
  spicy: 'a suggestive, revealing photo, framed and cropped the way she is comfortable sharing',
};

/**
 * His answer to a pending photo offer, from the consent card in the chat. Accepting is the
 * only thing that ever starts real generation - offering one, on the Actor's side, only
 * ever raises the card. See ActorHidden.photo_offer for why the two are kept apart.
 */
export async function respondToPhotoOffer(
  characterId: string,
  offerId: string,
  accept: boolean,
): Promise<{ ok: true; enqueued: boolean }> {
  const rel = getRelationship(characterId);
  if (!rel) throw new Error('character not found');
  const pending = (rel.mood as any)?.pending_photo as PendingPhoto | undefined;
  if (!pending || pending.offer_id !== offerId) {
    throw new Error('that offer is no longer open');
  }

  rel.mood = { ...rel.mood, pending_photo: null };
  saveRelationship(rel);

  // The card itself resolves in place - accepted or declined - rather than vanishing, so
  // scrolling back through history still makes sense.
  const updated = updateMessageMeta(pending.message_id, { status: accept ? 'accepted' : 'declined' });
  if (updated) {
    bus.emitEvent({ type: 'message_updated', character_id: characterId, message: updated });
  }

  if (!accept) return { ok: true, enqueued: false };

  // Seeing a real picture goes both ways: saying yes to hers shows her his at the same
  // time, which is the whole reason a character has any reason to offer one.
  if (pending.kind === 'profile') {
    rel.flags.state.photos_exchanged = true;
    saveRelationship(rel);
  }

  enqueueImage({
    characterId,
    kind: pending.kind,
    // A blank profile situation is generated lazily inside runImageJob, from the character
    // herself, rather than papered over with the same generic default every time.
    situation: pending.kind === 'profile' ? pending.situation ?? '' : pending.situation || DEFAULT_SITUATION[pending.kind],
    aspect: pending.aspect,
    showsFace: pending.showsFace,
  });
  return { ok: true, enqueued: true };
}

/** The Director has vision: it judges what the user sent and what that does to her. */
export async function evaluateUserImage(
  characterId: string,
  base64: string,
  mimeType: string,
): Promise<any> {
  const character = getCharacter(characterId);
  const rel = getRelationship(characterId);
  if (!character || !rel) throw new Error('character not found');
  const settings = getSettings();
  const { flagsBlock, historyBlock, seedBlock, touchstoneHint } = await import('./blocks.js');
  const { recentMessages, getUserProfile } = await import('../repo.js');

  const text = render('director_evaluate_image', {
    char_real_name: character.real_name,
    seed_block: seedBlock(character),
    trust: rel.trust,
    spark: rel.spark,
    investment: rel.investment,
    pressure: rel.pressure.toFixed(2),
    flags_block: flagsBlock(rel.flags),
    history_block: historyBlock(recentMessages(characterId, 12), character, getUserProfile()),
    touchstone_hint: touchstoneHint(character.seed),
  });

  return completeJson({
    scope: 'director',
    label: `evaluate_image:${character.username}`,
    config: settings.models.director,
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
}
