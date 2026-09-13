import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DATA_DIR, db, nowIso } from '../db/index.js';
import { allCategories, byCategory, invalidateAttributeCache } from '../db/attributes.js';
import { getSettings, saveSettings } from '../config.js';
import { usageToday } from '../llm/client.js';
import { logger } from '../log.js';
import {
  getCharacter, getRelationship, getUserProfile, getWakeup, lastMessage, markCharacterMessagesRead,
  queryLogs, recentMessages, saveUserProfile, unreadCount,
} from '../repo.js';
import { blockCharacterByUser, handleUserMessage, isAway, isRunning, regenerateLastTurn } from '../engine/chat.js';
import { ensureStack, generatingCount, stack, swipeLeft, swipeRight, visibleMatches } from '../engine/matching.js';
import { isOnline, serverWindowOpen } from '../engine/presence.js';
import { enqueueImage, evaluateUserImage, listImageJobs, retryImageJob } from '../engine/images.js';
import { rollSeed, describeSeed, avatarEmojiFor } from '../engine/generator.js';
import { catchUp } from '../engine/scheduler.js';
import { resetParts } from '../engine/reset.js';
import { profileView } from '../engine/discovery.js';
import type { Character } from '../types.js';

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
    profile_picture: rel?.flags.state.profile_picture_sent && picture ? `/media/${picture.path}` : null,
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
    });
    void ensureStack();
    return saved;
  });

  // ------------------------------------------------------------- swipe stack
  app.get('/api/stack', async () => {
    void ensureStack();
    return {
      generating: generatingCount(),
      // Only the handle and the bio. No picture, no age, no interests.
      profiles: stack().map((c) => ({ id: c.id, username: c.username, bio: c.bio })),
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
    return visibleMatches().map((c) => {
      const last = lastMessage(c.id);
      return {
        ...publicCharacter(c),
        unread: unreadCount(c.id),
        last_message: last
          ? { text: last.kind === 'image' ? 'Photo' : last.kind === 'voice' ? 'Voice message' : last.text, sender: last.sender, sent_at: last.sent_at }
          : null,
        last_activity: last?.sent_at ?? c.matched_at,
      };
    });
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
      messages: recentMessages(character.id, limit).map((m) => ({
        ...m,
        image_url: m.kind === 'image' && m.meta?.path ? `/media/${m.meta.path}` : null,
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

  app.get('/api/images', async () => listImageJobs(100));

  app.post<{ Params: { id: string } }>('/api/images/:id/retry', async (req, reply) => {
    try {
      await retryImageJob(req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { kind?: string; situation?: string } }>(
    '/api/chats/:id/request-image',
    async (req, reply) => {
      const character = getCharacter(req.params.id);
      if (!character) return reply.code(404).send({ error: 'not found' });
      const kind = (req.body?.kind ?? 'profile') as 'profile' | 'chat' | 'spicy';
      return enqueueImage({
        characterId: character.id,
        kind,
        situation: req.body?.situation ?? 'a plain selfie she would put on a dating profile',
      });
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

  app.get('/api/usage', async () => usageToday());

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
