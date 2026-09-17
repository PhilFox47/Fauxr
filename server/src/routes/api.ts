import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, db, nowIso } from '../db/index.js';
import { allCategories, byCategory, find, invalidateAttributeCache } from '../db/attributes.js';
import { getSettings, saveSettings } from '../config.js';
import { usageToday } from '../llm/client.js';
import { logger } from '../log.js';
import { exportLogs } from '../logexport.js';
import {
  activeDate, addMessage, dateMessages, deleteLocation, getCharacter, getDate, getLocation,
  getRelationship, getUserProfile, getWakeup, lastMessage, listLocations,
  markCharacterMessagesRead, queryLogs, recentMessages, saveLocation, saveRelationship,
  saveUserProfile, unreadCount,
} from '../repo.js';
import { bus } from '../events.js';
import { blockCharacterByUser, handleUserMessage, isAway, isRunning, regenerateLastTurn, takeTurn } from '../engine/chat.js';
import { ensureStack, generatingCount, stack, swipeLeft, swipeRight, visibleMatches } from '../engine/matching.js';
import { isOnline, serverWindowOpen } from '../engine/presence.js';
import {
  characterGallery, evaluateUserImage, listImageJobs, regenerateImage, respondToPhotoOffer, retryImageJob,
} from '../engine/images.js';
import { rollSeed, describeSeed, avatarEmojiFor, sanitizeEmoji } from '../engine/generator.js';
import { CARD_SECTIONS, sanitizeCard } from '../engine/usercard.js';
import { catchUp } from '../engine/scheduler.js';
import { resetParts } from '../engine/reset.js';
import { profileView, spendTraitCredit } from '../engine/discovery.js';
import { generateLocationImage } from '../engine/locations.js';
import { dateHistory, endDate, handleUserDateMessage, startDate } from '../engine/dates.js';
import type { Character, KinkStance, Location } from '../types.js';

/**
 * The backdrop is cache-busted on updated_at: regenerating writes a new file, but an edit
 * that keeps the old picture must not make the client refetch it, and neither case should
 * ever show a stale image at a reused path.
 */
function publicLocation(l: Location) {
  return {
    ...l,
    image_url: l.image_path ? `/media/${l.image_path}?v=${encodeURIComponent(l.updated_at)}` : null,
  };
}

function publicCharacter(c: Character) {
  const rel = getRelationship(c.id);
  const knowsName = !!rel?.flags.state.real_name_known;
  const picture = db
    .prepare("SELECT path FROM images WHERE character_id = ? AND kind = 'profile' AND status = 'done' ORDER BY rowid ASC LIMIT 1")
    .get(c.id) as { path: string } | undefined;
  return {
    id: c.id,
    username: c.username,
    display_name: knowsName ? c.real_name : c.username,
    real_name_known: knowsName,
    bio: c.bio,
    state: c.state,
    matched_at: c.matched_at,
    online: isOnline(c) && !(rel && isAway(rel)),
    // Stands in for her photo until one is actually unlocked, so a list of matches is
    // distinguishable at a glance rather than a column of identical grey initials.
    avatar_emoji: avatarEmojiFor(c),
    // Both halves: her image has to exist AND the two of them have to have swapped. A
    // picture that arrived without an exchange is not one he gets to look at.
    profile_picture:
      rel?.flags.state.profile_picture_sent && rel?.flags.state.photos_exchanged && picture
        ? `/media/${picture.path}`
        : null,
    // Exposed separately from profile_picture: she can have agreed to swap while her image
    // is still generating, or with images turned off entirely, and the button should know.
    photos_exchanged: !!rel?.flags.state.photos_exchanged,
    ghosting: !!rel?.ghosted_at,
  };
}

export async function registerApi(app: FastifyInstance): Promise<void> {
  app.get('/api/state', async () => {
    const profile = getUserProfile();
    return {
      onboarded: !!profile,
      profile,
      server_open: serverWindowOpen(),
      server_window: getSettings().server_window,
      generating: generatingCount(),
      api_configured: !!getSettings().api.api_key,
    };
  });

  /** Keep only real domain ids and real stances. */
  const sanitizeKinkMap = (raw: unknown): Record<string, KinkStance> => {
    const valid = new Set(byCategory('kink_domain').map((d) => d.id));
    const stances = new Set<KinkStance>(['into', 'curious', 'soft_no', 'hard_no']);
    const out: Record<string, KinkStance> = {};
    for (const [k, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
      if (valid.has(k) && stances.has(v as KinkStance)) out[k] = v as KinkStance;
    }
    return out;
  };

  // ------------------------------------------------------------- profile
  app.put<{ Body: any }>('/api/profile', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    if (!b.display_name || !b.age) return reply.code(400).send({ error: 'display_name and age are required' });
    const age = Number(b.age);
    if (!Number.isFinite(age) || age < 18) return reply.code(400).send({ error: 'age must be at least 18' });
    const saved = saveUserProfile({
      display_name: String(b.display_name).slice(0, 60),
      age,
      bio: String(b.bio ?? '').slice(0, 600),
      photos: Array.isArray(b.photos) ? b.photos.slice(0, 9) : [],
      gender: String(b.gender ?? ''),
      seeking: String(b.seeking ?? ''),
      // saveUserProfile clamps these to the 18 floor and sorts them if they arrive
      // back to front, so a bad pair from the client cannot produce an empty stack.
      age_min: Number(b.age_min ?? 18),
      age_max: Number(b.age_max ?? 42),
      // Only the four known stances survive, keyed by a real domain id, so nothing the
      // client sends can put junk in front of a model later.
      kink_map: sanitizeKinkMap(b.kink_map),
      // Same validation the generated characters get, so his emoji cannot be ":)" either.
      avatar_emoji: sanitizeEmoji(b.avatar_emoji) ?? '',
      card: sanitizeCard(b.card),
    });
    void ensureStack();
    return saved;
  });

  // ------------------------------------------------------------- swipe stack
  app.get('/api/stack', async () => {
    void ensureStack();
    return {
      generating: generatingCount(),
      // Handle, bio, age, languages and the emoji she picked for herself. Age and
      // languages are on the card because they are what a dating app actually shows before
      // you swipe, and making someone extract them in conversation was never a game. Still
      // no photo and no interests: the emoji exists so the stack is not a run of identical
      // cards, not to give away what she looks like.
      profiles: stack().map((c) => ({
        id: c.id,
        username: c.username,
        bio: c.bio,
        avatar_emoji: avatarEmojiFor(c),
        age: c.seed.age,
        // English is not listed: everyone speaks it, so it says nothing about her. It is
        // also the one language with no row in the table, hence the capitalising fallback.
        languages: c.seed.languages
          .filter((l) => l !== 'english')
          .map((l) => find('language', l)?.label ?? l.charAt(0).toUpperCase() + l.slice(1)),
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: { direction: string } }>('/api/swipe/:id', async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    if (req.body?.direction === 'right') return swipeRight(character.id);
    return swipeLeft(character.id);
  });

  // ------------------------------------------------------------- matches & chat
  app.get('/api/matches', async () => {
    // visibleMatches() itself is ordered by matched_at - the right order for a fresh cast,
    // wrong for a chat list. Re-sorted here by last_activity (a real message if there is
    // one, else when they matched) so whoever most recently said something floats to the
    // top, the same way every other chat app on earth works.
    return visibleMatches()
      .map((c) => {
        const last = lastMessage(c.id);
        return {
          ...publicCharacter(c),
          unread: unreadCount(c.id),
          last_message: last
            ? { text: last.kind === 'image' ? 'Photo' : last.kind === 'voice' ? 'Voice message' : last.text, sender: last.sender, sent_at: last.sent_at }
            : null,
          last_activity: last?.sent_at ?? c.matched_at,
        };
      })
      .sort((a, b) => Date.parse(b.last_activity ?? '') - Date.parse(a.last_activity ?? ''));
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/api/chats/:id', async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    return {
      character: publicCharacter(character),
      // Poll fallback for the typing indicator - see isRunning()'s comment. The WebSocket
      // event is still what makes it appear instantly when the connection actually works.
      typing: isRunning(character.id),
      // Non-null while she is out with him: the composer locks and the screen offers the
      // date instead. The text chat itself stays fully readable.
      active_date: activeDate(character.id),
      messages: recentMessages(character.id, limit).map((m) => ({
        ...m,
        // image_v is bumped on regenerate - same file path, so without a cache-bust query
        // param the browser would just keep showing what it already cached for that URL.
        image_url:
          m.kind === 'image' && m.meta?.path
            ? `/media/${m.meta.path}${m.meta.image_v ? `?v=${m.meta.image_v}` : ''}`
            : null,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>('/api/chats/:id/messages', async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    try {
      return await handleUserMessage({ characterId: req.params.id, text: text.slice(0, 4000) });
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  /** What he has actually found out about her. Locked rows carry a hint, never the value. */
  app.get<{ Params: { id: string } }>('/api/chats/:id/profile', async (req, reply) => {
    const character = getCharacter(req.params.id);
    const rel = getRelationship(req.params.id);
    if (!character || !rel) return reply.code(404).send({ error: 'not found' });
    return {
      username: character.username,
      display_name: rel.flags.state.real_name_known ? character.real_name : character.username,
      bio: character.bio,
      trait_credits: rel.flags.state.trait_credits ?? 0,
      ...profileView(character, rel),
    };
  });

  /**
   * Spends one earned credit (see trackMessageForCredit in discovery.ts) to reveal a random
   * still-locked trait - a small, guaranteed payoff for showing up that does not depend on
   * her choosing to say something herself.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/uncover-trait', async (req, reply) => {
    const character = getCharacter(req.params.id);
    const rel = getRelationship(req.params.id);
    if (!character || !rel) return reply.code(404).send({ error: 'not found' });
    const result = spendTraitCredit(character, rel);
    if (!result.ok) {
      const error = result.reason === 'no_credits' ? 'no trait credits available' : 'nothing left to uncover';
      return reply.code(400).send({ error });
    }
    saveRelationship(rel);
    logger.debug('app', `${character.username}: uncovered ${result.revealed!.key}`, { character_id: character.id });
    return {
      revealed_key: result.revealed!.key,
      username: character.username,
      display_name: rel.flags.state.real_name_known ? character.real_name : character.username,
      bio: character.bio,
      trait_credits: rel.flags.state.trait_credits ?? 0,
      ...profileView(character, rel),
    };
  });

  app.post<{ Params: { id: string } }>('/api/chats/:id/read', async (req) => {
    const marked = markCharacterMessagesRead(req.params.id);
    if (marked) logger.debug('app', `marked ${marked} message(s) read`, { character_id: req.params.id });
    return { ok: true, marked, unread: unreadCount(req.params.id) };
  });

  /**
   * Reroll her most recent reply. Only the trailing turn can be regenerated - the client
   * sends the id of the bubble it wants replaced, which doubles as a guard against a stale
   * UI (a second tab, a message that already got superseded by a new exchange).
   */
  app.post<{ Params: { id: string }; Body: { message_id?: number } }>(
    '/api/chats/:id/regenerate',
    async (req, reply) => {
      const messageId = Number(req.body?.message_id);
      if (!Number.isFinite(messageId)) return reply.code(400).send({ error: 'message_id is required' });
      try {
        return await regenerateLastTurn(req.params.id, messageId);
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  app.post<{ Params: { id: string } }>('/api/chats/:id/block', async (req) => {
    await blockCharacterByUser(req.params.id);
    return { ok: true };
  });

  // ------------------------------------------------------------- images
  app.post<{ Params: { id: string } }>('/api/chats/:id/image', async (req, reply) => {
    const file = await (req as any).file?.();
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buffer = await file.toBuffer();
    const name = `${randomUUID()}-${file.filename.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const relPath = join('uploads', name);
    writeFileSync(join(DATA_DIR, relPath), buffer);

    const stored = await handleUserMessage({
      characterId: req.params.id,
      text: '',
      kind: 'image',
      meta: { path: relPath },
    });

    // Vision pass runs in the background; the chat is never blocked by it.
    void evaluateUserImage(req.params.id, buffer.toString('base64'), file.mimetype)
      .then((result) => logger.info('director', 'image evaluated', result))
      .catch((err) => logger.error('director', 'image evaluation failed', { error: String(err) }));

    return { ...stored, image_url: `/media/${relPath}` };
  });

  /** Everything she has actually sent him, for the gallery on her profile sheet. */
  app.get<{ Params: { id: string } }>('/api/chats/:id/gallery', async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    const rel = getRelationship(character.id);
    const images = characterGallery(character.id, !!rel?.flags.state.photos_exchanged);
    return images.map((i) => ({
      id: i.id,
      kind: i.kind,
      // Cache-busted on updated_at so a regenerated shot - same file path, new bytes -
      // actually reloads instead of showing what the browser cached for that URL.
      url: `/media/${i.path}?v=${encodeURIComponent(i.updated_at)}`,
      created_at: i.created_at,
    }));
  });

  // ------------------------------------------------------------- locations
  /**
   * The places he can take someone. Written by hand in Settings; the backdrop is the only
   * part that involves the image model, and it is a separate, explicit button.
   */
  app.get('/api/locations', async () => listLocations().map(publicLocation));

  app.post<{ Body: { id?: string; name?: string; description?: string } }>(
    '/api/locations',
    async (req, reply) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'a name is required' });
      const saved = saveLocation({
        id: String(req.body?.id ?? '').trim() || randomUUID(),
        name: name.slice(0, 80),
        description: String(req.body?.description ?? '').trim().slice(0, 2000),
      });
      return publicLocation(saved);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/locations/:id', async (req) => {
    deleteLocation(req.params.id);
    return { ok: true };
  });

  /** Renders the backdrop. Slow (a full image generation), so the client shows a spinner. */
  app.post<{ Params: { id: string } }>('/api/locations/:id/image', async (req, reply) => {
    try {
      return publicLocation(await generateLocationImage(req.params.id));
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  // ------------------------------------------------------------- dates
  /** The invite menu and the list of evenings already spent, for her chat screen. */
  app.get<{ Params: { id: string } }>('/api/chats/:id/dates', async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    return { ...dateHistory(character.id), locations: listLocations().map(publicLocation) };
  });

  app.post<{ Params: { id: string }; Body: { location_id?: string; when?: string } }>(
    '/api/chats/:id/dates',
    async (req, reply) => {
      try {
        return await startDate({
          characterId: req.params.id,
          locationId: String(req.body?.location_id ?? ''),
          when: String(req.body?.when ?? '').slice(0, 120),
        });
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  /** One date's own transcript - never mixed into the texting history, by design. */
  app.get<{ Params: { dateId: string } }>('/api/dates/:dateId', async (req, reply) => {
    const date = getDate(req.params.dateId);
    if (!date) return reply.code(404).send({ error: 'not found' });
    const character = getCharacter(date.character_id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    const location = date.location_id ? getLocation(date.location_id) : null;
    return {
      date,
      character: publicCharacter(character),
      location: location ? publicLocation(location) : null,
      typing: isRunning(character.id),
      messages: dateMessages(date.id),
    };
  });

  app.post<{ Params: { dateId: string }; Body: { text?: string } }>(
    '/api/dates/:dateId/messages',
    async (req, reply) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'text is required' });
      try {
        return await handleUserDateMessage({ dateId: req.params.dateId, text: text.slice(0, 4000) });
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  /** Ends the evening and writes the summary she will remember it by. */
  app.post<{ Params: { dateId: string } }>('/api/dates/:dateId/end', async (req, reply) => {
    try {
      return await endDate(req.params.dateId);
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get('/api/images', async () => listImageJobs(100));

  app.post<{ Params: { id: string } }>('/api/images/:id/retry', async (req, reply) => {
    try {
      await retryImageJob(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // Two different asks: "same idea" reassembles the same situation into a fresh prompt and
  // a fresh image; "new idea" asks her to think of a different photo first. Either way this
  // overwrites the existing job/file in place - see regenerateImage().
  app.post<{ Params: { id: string }; Body: { mode?: string } }>(
    '/api/images/:id/regenerate',
    async (req, reply) => {
      const mode = req.body?.mode === 'new_idea' ? 'new_idea' : 'same_idea';
      try {
        await regenerateImage(req.params.id, mode);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  // Generation only ever starts from an accepted consent card, never on request - see
  // respondToPhotoOffer(). This used to be a direct-trigger endpoint with no caller; kept
  // that way would have been an unguarded bypass of the consent it now exists to enforce.
  app.post<{ Params: { id: string; offerId: string }; Body: { accept?: boolean } }>(
    '/api/chats/:id/photo-offer/:offerId',
    async (req, reply) => {
      try {
        return await respondToPhotoOffer(req.params.id, req.params.offerId, !!req.body?.accept);
      } catch (err) {
        return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
      }
    },
  );

  // ------------------------------------------------------------- settings & tuning
  app.get('/api/settings', async () => ({ settings: getSettings(), usage: usageToday() }));

  app.put<{ Body: unknown }>('/api/settings', async (req) => {
    const next = saveSettings(req.body);
    logger.info('app', 'settings updated');
    return next;
  });

  app.get<{ Querystring: { scope?: string; level?: string; q?: string; limit?: string; before?: string } }>(
    '/api/logs',
    async (req) =>
      queryLogs({
        scope: req.query.scope,
        level: req.query.level,
        q: req.query.q,
        limit: Number(req.query.limit) || 50,
        before: req.query.before ? Number(req.query.before) : undefined,
      }),
  );

  /**
   * The same logs, rendered for pasting into a chat window rather than for scrolling. Sent
   * as plain text with a filename attached, so the browser can either drop it on the
   * clipboard or save it without the client re-implementing the formatting.
   */
  app.get<{
    Querystring: { scope?: string; level?: string; q?: string; limit?: string; prompts?: string; id?: string };
  }>('/api/logs/export', async (req, reply) => {
    const prompts = req.query.prompts;
    const text = exportLogs({
      id: req.query.id ? Number(req.query.id) : undefined,
      scope: req.query.scope,
      level: req.query.level,
      q: req.query.q,
      limit: Number(req.query.limit) || 200,
      prompts: prompts === 'trim' || prompts === 'none' ? prompts : 'full',
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="fauxr-logs-${stamp}.md"`)
      .send(text);
  });

  app.get('/api/usage', async () => usageToday());

  /**
   * The card's shape and every option in it, so the editor is rendered from the same spec
   * the validator uses and a new field needs no frontend change.
   */
  app.get('/api/card-spec', async () => ({
    sections: CARD_SECTIONS,
    options: Object.fromEntries(
      [...new Set(CARD_SECTIONS.flatMap((s) => s.fields.map((f) => f.category)))].map((cat) => [
        cat,
        byCategory(cat).map((a) => ({ id: a.id, label: a.label })),
      ]),
    ),
  }));

  /** Just the domains and their descriptions, for the profile editor. */
  app.get('/api/kink-domains', async () =>
    byCategory('kink_domain').map((d) => ({ id: d.id, label: d.label, hint: d.prompt_hint })));

  /**
   * He offers to swap profile pictures. This only raises the request - she answers it on
   * her next turn and is allowed to say no, which is the point of asking rather than a
   * button that simply reveals things.
   */
  app.post<{ Params: { id: string } }>('/api/chats/:id/profile-exchange', async (req, reply) => {
    const character = getCharacter(req.params.id);
    if (!character) return reply.code(404).send({ error: 'not found' });
    const rel = getRelationship(character.id);
    if (!rel) return reply.code(404).send({ error: 'not found' });
    if (rel.flags.state.photos_exchanged) {
      return reply.code(400).send({ error: 'you have already swapped pictures' });
    }
    if ((rel.mood as any)?.pending_exchange) {
      return reply.code(400).send({ error: 'she has not answered the last one yet' });
    }

    const requestId = randomUUID();
    const msg = addMessage({
      character_id: character.id,
      sender: 'system',
      text: `You offered to swap profile pictures with ${character.real_name}.`,
      kind: 'text',
      meta: { type: 'exchange_request', request_id: requestId, status: 'pending' },
      read_at: null,
    });
    bus.emitEvent({ type: 'message', character_id: character.id, message: msg });

    rel.mood = {
      ...rel.mood,
      pending_exchange: { request_id: requestId, message_id: msg.id, requested_at: nowIso() },
    };
    saveRelationship(rel);

    // Her answer comes back through the normal turn machinery. Only if she is around -
    // offline, the request just sits there like any other unread message.
    if (isOnline(character) && !isAway(rel)) {
      void takeTurn(character.id, { trigger: 'user_message' }).catch(() => {});
    }
    return { ok: true, request_id: requestId };
  });

  app.get('/api/attributes', async () => {
    return allCategories().map((category) => ({ category, entries: byCategory(category) }));
  });

  app.post('/api/attributes/reload', async () => {
    invalidateAttributeCache();
    return { ok: true };
  });

  /** Test roll: ten raw seeds, no LLM calls, so weights can be eyeballed. */
  app.get('/api/attributes/testroll', async () => {
    return Array.from({ length: 10 }, () => {
      const { seed } = rollSeed();
      return { archetype: seed.archetype, summary: describeSeed(seed) };
    });
  });

  /**
   * Wipe everything and come back up at onboarding. Settings are kept unless the caller
   * asks otherwise, so a reset does not cost you your API key.
   */
  app.post<{
    Body: { confirm?: string; world?: boolean; profile?: boolean; settings?: boolean; logs?: boolean };
  }>('/api/reset', async (req, reply) => {
    const b = req.body ?? {};
    if (b.confirm !== 'RESET') {
      return reply.code(400).send({ error: 'confirmation required' });
    }
    if (!b.world && !b.profile && !b.settings && !b.logs) {
      return reply.code(400).send({ error: 'nothing selected to reset' });
    }
    return resetParts({
      world: !!b.world,
      profile: !!b.profile,
      settings: !!b.settings,
      logs: !!b.logs,
    });
  });

  app.post('/api/catchup', async () => {
    await catchUp();
    return { ok: true };
  });

  /** Internal view of one relationship. Never surfaced in the chat UI. */
  app.get<{ Params: { id: string } }>('/api/debug/character/:id', async (req, reply) => {
    const character = getCharacter(req.params.id);
    const rel = getRelationship(req.params.id);
    if (!character || !rel) return reply.code(404).send({ error: 'not found' });
    return {
      character: { ...character, seed_summary: describeSeed(character.seed) },
      relationship: rel,
      wakeup: getWakeup(character.id),
      online: isOnline(character),
      now: nowIso(),
    };
  });

  app.post('/api/uploads', async (req, reply) => {
    const file = await (req as any).file?.();
    if (!file) return reply.code(400).send({ error: 'no file uploaded' });
    const buffer = await file.toBuffer();
    const name = `${randomUUID()}-${file.filename.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const relPath = join('uploads', name);
    writeFileSync(join(DATA_DIR, relPath), buffer);
    return { path: relPath, url: `/media/${relPath}` };
  });
}
