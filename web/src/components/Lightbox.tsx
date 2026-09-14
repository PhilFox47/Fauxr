import { useCallback, useEffect } from 'react';
import Icon from './Icon';

/**
 * Full-screen image viewer, shared by the chat bubbles and the gallery so both behave the
 * same way. It is handed the whole set rather than one URL, which is what makes paging
 * through her photos from a chat bubble work without the caller tracking anything.
 */
export default function Lightbox({
  images,
  index,
  onIndex,
  onClose,
}: {
  images: string[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const count = images.length;
  const go = useCallback(
    (delta: number) => {
      if (count < 2) return;
      onIndex((index + delta + count) % count);
    },
    [count, index, onIndex],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    // The page behind must not scroll while this is up, or a swipe drags the chat around
    // underneath the image.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [go, onClose]);

  const src = images[index];
  if (!src) return null;

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label="Photo">
      <button className="lightbox-close iconbtn" onClick={onClose} aria-label="Close">
        <Icon name="close" size={22} />
      </button>

      {count > 1 && (
        <span className="lightbox-count tiny">
          {index + 1} / {count}
        </span>
      )}

      {count > 1 && (
        <button
          className="lightbox-nav prev"
          aria-label="Previous photo"
          onClick={(e) => {
            e.stopPropagation();
            go(-1);
          }}
        >
          <Icon name="back" size={24} />
        </button>
      )}

      {/* Stops a tap on the photo itself from closing, so it can be studied rather than
          dismissed by accident. */}
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />

      {count > 1 && (
        <button
          className="lightbox-nav next"
          aria-label="Next photo"
          onClick={(e) => {
            e.stopPropagation();
            go(1);
          }}
        >
          <Icon name="back" size={24} />
        </button>
      )}
    </div>
  );
}
