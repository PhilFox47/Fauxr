import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getSettings } from '../config.js';
import { db, nowIso, DATA_DIR } from '../db/index.js';
import { bus } from '../events.js';
import { completeJson, generateImage } from '../llm/client.js';
import { logger } from '../log.js';
import { addMessage, getCharacter, getRelationship, saveRelationship, updateMessageMeta } from '../repo.js';
import { render } from '../prompts/render.js';
import { find } from '../db/attributes.js';
import { describeSeed } from './generator.js';
import type { Character, CharacterSeed, PendingPhoto } from '../types.js';

/**
 * The floor every generated photo lands on, whatever kind of shot it is.
 *
 * Used to be one fixed "candid amateur phone photo" suffix forced onto every image,
 * profile pictures included - which is exactly why every profile picture came out the
 * same: an amateur selfie, because the style was decided before the shot's own situation
 * was. This is now only the part that has to hold regardless of format: a real texture,
 * not a plastic one, and an attractive but fairly represented woman rather than a bad
 * angle excused as "candid". Which kind of photo it actually is - candid or composed,
 * phone or studio - is CANDID_SUFFIX below plus whatever the assembler itself wrote from
 * her own account of the shot.
 */
const BASE_SUFFIX = [
  'photorealistic photograph',
  'real unretouched skin with visible texture and pores',
  'naturally attractive, healthy, flattering angle',
].join(', ');

/**
 * The "taken on her phone, right now" look - added on top of BASE_SUFFIX for a chat or
 * spicy photo, which is always a moment inside the conversation rather than a picture she
 * chose to lead with. A profile picture does not get this forced on: see is_moment in the
 * assembler template for the matching instructions, and runImageJob for where it applies.
 */
const CANDID_SUFFIX = [
  'candid amateur phone photo',
  'natural available light',
  'softly imperfect handheld framing',
  'slight sensor grain',
  'shallow phone-lens depth of field',
].join(', ');

/**
 * Sent with every image regardless of kind - the airbrushed-render look, the opposite
 * over-correction into unflattering, and the usual anatomy rubbish.
 */
const BASE_NEGATIVE = [
  'airbrushed, heavy retouching, beauty filter, smoothed plastic skin, waxy skin, doll-like',
  'ugly, unflattering angle, harsh direct flash, sickly skin tone, sunken eyes, grotesque',
  'cgi, 3d render, illustration, painting, anime, cartoon, airbrush art',
  'deformed, disfigured, bad anatomy, extra fingers, extra limbs, mutated hands, asymmetric eyes',
  'oversaturated, heavy hdr, watermark, text, logo, lowres, out-of-focus face',
].join(', ');

/**
 * Only for a chat/spicy moment: a profile picture is now allowed to genuinely be a studio
 * headshot or a posed professional-looking shot, so banning that look outright would
 * contradict the one case it is meant to happen.
 */
const CANDID_NEGATIVE = 'glamour shot, studio lighting, professional model, magazine cover, stock photo';

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
  created_at: string;
  updated_at: string;
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

/** What is actually visible on her in this kind of shot. */
function visibleMarks(character: Character, kind: string): string {
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
  postToChat?: boolean;
}): ImageJob {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO images (id, character_id, kind, prompt, seed, ref_image, status, path, error, created_at, updated_at)
     VALUES (?, ?, ?, '', NULL, NULL, 'queued', NULL, NULL, ?, ?)`,
  ).run(id, opts.characterId, opts.kind, nowIso(), nowIso());
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
            visible_marks: visibleMarks(character, job.kind),
            demeanour: demeanourFor(character.seed),
            // Only a profile picture gets to be a professional shot, a repurposed work
            // photo, a posed full-body - anything her own account above says it is. A
            // chat or spicy photo is always a moment inside the conversation, so it keeps
            // the candid, taken-right-now rules regardless of what image_kind spells out.
            is_profile: isProfile ? '1' : '',
            is_moment: isProfile ? '' : '1',
          }),
        },
      ],
    });

    // Candid phone-photo texture only applies to a moment inside the conversation. A
    // profile picture's style - polished headshot or grainy selfie - was already decided
    // by the assembler from her own account of the photo, so forcing the candid suffix on
    // top would fight a studio shot into looking like a bad phone photo.
    const styleSuffix = isProfile ? BASE_SUFFIX : `${BASE_SUFFIX}, ${CANDID_SUFFIX}`;
    const prompt = `${assembled.prompt}, ${styleSuffix}`;
    // The assembler has always returned a negative prompt and it was being dropped on the
    // floor here - never passed to the image call at all. Its shot-specific negatives now
    // ride along with the standing ones. CANDID_NEGATIVE (no studio lighting, no
    // professional-model posing) only applies to a moment shot, for the same reason.
    const negative = [assembled.negative_prompt, BASE_NEGATIVE, isProfile ? null : CANDID_NEGATIVE]
      .filter(Boolean)
      .join(', ');
    const ref = isProfile ? null : referenceImage(character.id);
    const b64 = await generateImage({
      prompt,
      negativePrompt: negative,
      seed: character.seed.image_seed,
      refImage: ref ?? undefined,
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
  await runImageJob(id, job.prompt || 'same as before', true);
}

/** Used only when the Actor left no concrete detail to work from. */
const DEFAULT_SITUATION: Record<'profile' | 'chat' | 'spicy', string> = {
  profile: 'a plain, friendly selfie for her profile',
  chat: 'a casual photo of whatever she is doing right now',
  spicy: 'an explicit photo, framed the way she is comfortable sharing',
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
