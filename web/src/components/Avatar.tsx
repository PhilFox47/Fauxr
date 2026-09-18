import type { MatchSummary } from '../api';

type AvatarSubject = Pick<
  MatchSummary,
  'display_name' | 'avatar_emoji' | 'profile_picture' | 'online'
>;

/**
 * Her face in a list: the real photo once it has been unlocked, otherwise the emoji she
 * picked for herself, otherwise her initial. The emoji step exists because a column of
 * identical grey initials is impossible to tell apart at a glance.
 */
export default function Avatar({
  match,
  small = false,
  presence = true,
  onDate = false,
}: {
  match: AvatarSubject | null;
  small?: boolean;
  presence?: boolean;
  /**
   * She is out with him right now. Takes the same corner the online dot uses, and takes
   * priority over it - "online" is a meaningless distinction for someone mid-date, so the
   * two are never shown at once. A separate prop rather than a field read off `match`
   * because not every screen that renders an Avatar has fetched date state for it, and a
   * caller that has not is a caller that means false, not one lying by omission.
   */
  onDate?: boolean;
}) {
  return (
    <div className={`avatar${small ? ' sm' : ''}`} aria-hidden="true">
      {match?.profile_picture ? (
        <img src={match.profile_picture} alt="" />
      ) : match?.avatar_emoji ? (
        <span className="emoji">{match.avatar_emoji}</span>
      ) : (
        (match?.display_name ?? '?').slice(0, 1).toUpperCase()
      )}
      {onDate ? (
        <span className="dot-date" title="On a date right now">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 19.5S4.5 15 4.5 9.8A3.8 3.8 0 0 1 12 8.2a3.8 3.8 0 0 1 7.5 1.6C19.5 15 12 19.5 12 19.5Z" />
          </svg>
        </span>
      ) : (
        presence && match?.online && <span className="dot-online" />
      )}
    </div>
  );
}
