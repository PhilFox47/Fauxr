import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE_NAME = 'fauxr_session';
const REMEMBER_SECONDS = 14 * 24 * 3600;
/** No "remember me": still a real login, just one the browser is free to forget on its own. */
const SESSION_SECONDS = 24 * 3600;

/** Auth is entirely opt-in: set nothing, and the app behaves exactly as it always has. */
export function authEnabled(): boolean {
  return !!process.env.FAUXR_PASSWORD;
}

function secretKey(): Buffer {
  return createHash('sha256').update(process.env.FAUXR_PASSWORD ?? '').digest();
}

/** Constant-time regardless of where the candidate first differs from the real password. */
export function checkPassword(candidate: string): boolean {
  const expected = createHash('sha256').update(process.env.FAUXR_PASSWORD ?? '').digest();
  const actual = createHash('sha256').update(candidate).digest();
  return timingSafeEqual(expected, actual);
}

function sign(payload: string): string {
  return createHmac('sha256', secretKey()).update(payload).digest('hex');
}

function issueToken(expiresAt: number): string {
  const payload = String(expiresAt);
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  const expectedHex = sign(payload);
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(sigHex, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * `Max-Age` omitted entirely means "session cookie" - gone the moment the browser actually
 * closes, which is the whole difference between checking "remember me" and not. The token's
 * own embedded expiry (SESSION_SECONDS) is the backstop for a browser that keeps it around
 * longer than that anyway (tab restore, a browser that never really closes).
 */
function cookieHeader(token: string, maxAgeSeconds?: number): string {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function isAuthedRequest(req: FastifyRequest): boolean {
  return verifyToken(parseCookies(req.headers.cookie as string | undefined)[COOKIE_NAME]);
}

export function logIn(reply: FastifyReply, remember: boolean): void {
  const seconds = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  const token = issueToken(Date.now() + seconds * 1000);
  reply.header('set-cookie', cookieHeader(token, remember ? seconds : undefined));
}

export function logOut(reply: FastifyReply): void {
  reply.header('set-cookie', cookieHeader('', 0));
}

/** Paths reachable with no session at all - the login call itself, and the health check. */
const PUBLIC_PATHS = new Set(['/api/login', '/healthz']);

/**
 * Gates everything that actually holds or shows her - the API, generated/uploaded media, and
 * the live event socket - behind a session. The built frontend shell (its HTML, JS and CSS)
 * stays reachable with no session, or there would be nothing left to render the login screen
 * with in the first place; it carries no data of its own until the API answers something.
 */
export function requiresAuth(url: string): boolean {
  const path = url.split('?')[0];
  if (PUBLIC_PATHS.has(path)) return false;
  return path.startsWith('/api') || path.startsWith('/media') || path === '/ws';
}
