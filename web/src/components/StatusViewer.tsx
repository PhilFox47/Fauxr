import { useEffect, useRef, useState } from 'react';
import { api, type MatchSummary, type StatusPost } from '../api';
import Icon from './Icon';

export default function StatusViewer({
  character,
  onClose,
  onProfile,
  onLiked,
  onViewed,
}: {
  character: MatchSummary;
  onClose: () => void;
  onProfile: () => void;
  onLiked?: () => void;
  onViewed?: (hasUnseenRemaining: boolean) => void;
}) {
  const [posts, setPosts] = useState<StatusPost[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const post = posts[index];
  const viewing = useRef(new Set<string>());

  useEffect(() => {
    let alive = true;
    void api.statusPosts(character.id).then((rows) => {
      if (!alive) return;
      setPosts(rows);
      const firstUnseen = rows.findIndex((row) => !row.viewed);
      setIndex(firstUnseen >= 0 ? firstUnseen : 0);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [character.id]);

  useEffect(() => {
    if (!post || post.viewed || viewing.current.has(post.id)) return;
    viewing.current.add(post.id);
    void api.viewStatusPost(post.id).then(() => {
      setPosts((rows) => {
        const next = rows.map((row) => row.id === post.id ? { ...row, viewed: true } : row);
        onViewed?.(next.some((row) => !row.viewed));
        return next;
      });
    }).catch(() => { viewing.current.delete(post.id); });
  }, [post?.id, post?.viewed, onViewed]);

  useEffect(() => {
    if (!post) return;
    const timer = window.setTimeout(() => {
      if (index < posts.length - 1) setIndex(index + 1);
      else onClose();
    }, 7000);
    return () => window.clearTimeout(timer);
  }, [index, post, posts.length]);

  const like = async () => {
    if (!post || post.liked) return;
    await api.likeStatusPost(post.id);
    setPosts((rows) => rows.map((row) => row.id === post.id ? { ...row, liked: true } : row));
    onLiked?.();
  };

  return (
    <div className="status-viewer" role="dialog" aria-modal="true" aria-label={`${character.display_name}'s Status`}>
      <div className="status-story">
        <div className="status-progress" aria-hidden="true">
          {posts.map((row, i) => <span key={row.id} className={i < index ? 'done' : i === index ? 'active' : ''} />)}
        </div>
        <div className="status-story-head">
          <button className="status-story-person" onClick={onProfile}>
            <span className="status-story-thumb">
              {character.profile_picture ? <img src={character.profile_picture} alt="" /> : character.avatar_emoji}
            </span>
            <span><strong>{character.display_name}</strong>{post && <small>{new Date(post.created_at_ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</small>}</span>
          </button>
          <button className="iconbtn" onClick={onClose} aria-label="Close Status"><Icon name="close" size={22} /></button>
        </div>
        {loading ? <div className="status-story-empty">Loading Status…</div> : post ? (
          <>
            <img className="status-story-image" src={post.image_url} alt={post.caption || `${character.display_name}'s Status`} />
            <button className="status-story-side prev" disabled={index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))} aria-label="Previous Status" />
            <button className="status-story-side next" disabled={index >= posts.length - 1} onClick={() => setIndex((i) => Math.min(posts.length - 1, i + 1))} aria-label="Next Status" />
            <div className="status-story-foot">
              <span>{post.caption}</span>
              <button className={`status-like${post.liked ? ' liked' : ''}`} onClick={() => void like()} aria-label={post.liked ? 'Saved to gallery' : 'Like and save to gallery'}>
                <Icon name="heart" size={24} />
              </button>
            </div>
          </>
        ) : <div className="status-story-empty">This Status has expired.</div>}
      </div>
    </div>
  );
}
