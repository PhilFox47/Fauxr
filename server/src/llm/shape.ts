/**
 * Small helpers for putting a model's JSON back into the shape we asked for.
 *
 * The models this app runs on keep the content right and bend the structure: they rename a
 * key, wrap everything in one more object, or flatten a nested block into the top level. A
 * strict reader throws all of that away - in one exported log it discarded every one of the
 * Actor's replies and most of the Director's, each perfectly usable. These helpers read
 * tolerantly instead; the callers decide which aliases mean what.
 */

export type Obj = Record<string, any>;

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The first defined, non-null value among these keys. */
export function pick(obj: Obj | undefined, keys: string[]): any {
  if (!obj) return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

/**
 * `{"character": {...}}` or `{"response": {...}}` - one wrapper object around what we wanted.
 * If none of the expected keys are at the top and exactly one value is an object that has
 * some of them, that object is the answer.
 */
export function unwrap(value: unknown, expected: string[]): Obj {
  if (!isObj(value)) return {};
  if (expected.some((k) => k in value)) return value;
  const inner = Object.values(value).filter((v) => isObj(v) && expected.some((k) => k in (v as Obj)));
  return inner.length === 1 ? { ...(inner[0] as Obj) } : value;
}
