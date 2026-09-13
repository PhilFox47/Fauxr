import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import { DATA_DIR, migrate } from './db/index.js';
import { seedAttributes } from './db/attributes.js';
import { bus } from './events.js';
import { logger } from './log.js';
import { registerApi } from './routes/api.js';
import { startScheduler, stopScheduler } from './engine/scheduler.js';
import { ensureStack } from './engine/matching.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

async function main(): Promise<void> {
  migrate();
  const inserted = seedAttributes();
  logger.info('app', `database ready (${inserted} new attribute rows)`);

  const app = Fastify({ logger: false, bodyLimit: 25 * 1024 * 1024 });
  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  await registerApi(app);

  // Uploaded and generated media.
  await app.register(fastifyStatic, { root: DATA_DIR, prefix: '/media/', decorateReply: false });

  // Built frontend, when present (the Docker image builds it in).
  const publicDir = join(here, '..', 'public');
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir, prefix: '/', decorateReply: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/media')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  app.get('/ws', { websocket: true }, (socket) => {
    const unsubscribe = bus.onEvent((event) => {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        /* client went away mid-write */
      }
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    socket.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
  });

  app.get('/healthz', async () => ({ ok: true }));

  await app.listen({ port: PORT, host: HOST });
  logger.info('app', `Fauxr listening on http://${HOST}:${PORT}`);

  startScheduler();
  void ensureStack();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      logger.info('app', `received ${signal}, shutting down`);
      stopScheduler();
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
