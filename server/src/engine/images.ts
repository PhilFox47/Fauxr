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
import type { Character, CharacterSeed, PendingPhoto } from '../types.js';

/**
 * The look every generated photo lands in.
 *
 * Two failure modes to stay between. Push "amateur phone photo" alone and the model reads it
 * as permission to make her unflattering - bad angles, sickly light, a face nobody would
 * swipe on. Push "beautiful" alone and it returns a retouched studio render with plastic
 * skin, which is the thing that most obviously is not a real person. So both are said
 * explicitly: a real candid photo, of someone who happens to be attractive, unretouched.
 */
const STYLE_SUFFIX = [
  'candid amateur phone photo',
  'natural available light',
  'real unretouched skin with visible texture and pores',
  'naturally attractive, healthy, flattering angle',
  'softly imperfect handheld framing',
  'slight sensor grain',
  'shallow phone-lens depth of field',
].join(', ');

/**
 * Sent with every image. The first half fights the airbrushed-render look, the second half
 * fights the opposite over-correction, and the rest is the usual anatomy rubbish.
 */
const BASE_NEGATIVE = [
  'airbrushed, heavy retouching, beauty filter, smoothed plastic skin, waxy skin, doll-like',
  'glamour shot, studio lighting, professional model, magazine cover, stock photo',
  'ugly, unflattering angle, harsh direct flash, sickly skin tone, sunken eyes, grotesque',
  'cgi, 3d render, illustration, painting, anime, cartoon, airbrush art',
  'deformed, disfigured, bad anatomy, extra fingers, extra limbs, mutated hands, asymmetric eyes',
  'oversaturated, heavy hdr, watermark, text, logo, lowres, out-of-focus face',
].join(', ');

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

  const energy = {
    low: 'low-key and a bit reluctant about being photographed',
    medium: 'relaxed, unbothered by the camera',
    high: 'lively, clearly enjoying taking it',
  }[seed.social_energy];
  if (energy) parts.push(energy);

  if (['dry', 'deadpan', 'dark'].includes(seed.humor_type)) parts.push('deliberately undersold expression');
  if (['silly', 'goofy', 'playful'].includes(seed.humor_type)) parts.push('playful, mid-expression rather than posed');

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
          }),
        },
      ],
    });

    const prompt = `${assembled.prompt}, ${STYLE_SUFFIX}`;
    // The assembler has always returned a negative prompt and it was being dropped on the
    // floor here - never passed to the image call at all. Its shot-specific negatives now
    // ride along with the standing ones.
    const negative = [assembled.negative_prompt, BASE_NEGATIVE].filter(Boolean).join(', ');
    const ref = job.kind === 'profile' ? null : referenceImage(character.id);
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
    situation: pending.situation || DEFAULT_SITUATION[pending.kind],
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
