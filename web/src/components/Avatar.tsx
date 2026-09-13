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
}: {
  match: AvatarSubject | null;
  small?: boolean;
  presence?: boolean;
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
      {presence && match?.online && <span className="dot-online" />}
    </div>
  );
}
