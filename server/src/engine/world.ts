import { listActiveMatches, getRelationship, saveRelationship } from '../repo.js';
import { gameClockMs, gameNowIso } from './clock.js';
import { decayArousal } from './stage.js';

/** Apply elapsed fictional time to durable relationship state once, regardless of how time moved. */
export function syncWorldEffects(): void {
  const now = gameClockMs();
  for (const character of listActiveMatches()) {
    const rel = getRelationship(character.id);
    if (!rel) continue;
    const before = Date.parse(rel.last_decay_at ?? rel.last_contact_at ?? new Date(now).toISOString());
    if (!Number.isFinite(before) || before > now) {
      // A save migrated from independent chat clocks can have a wall-time decay anchor ahead
      // of the selected shared clock. Rebase once instead of freezing decay until it catches up.
      rel.last_decay_at = gameNowIso();
      saveRelationship(rel);
      continue;
    }
    const hours = Math.max(0, (now - before) / 3_600_000);
    if (hours < 1 / 60) continue;
    rel.arousal = decayArousal(rel.arousal, hours);
    rel.last_decay_at = gameNowIso();
    // A direction written for an earlier part of her schedule is stale after a meaningful gap.
    if (hours >= 1) { rel.active_direction = null; rel.direction_set_at = null; }
    saveRelationship(rel);
  }
}
