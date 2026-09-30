import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { EMOJI, type EmojiEntry } from '../data/emoji';

interface Props extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (value: string) => void;
}

interface Match { start: number; end: number; results: EmojiEntry[] }

function findMatch(value: string, cursor: number): Match | null {
  const before = value.slice(0, cursor);
  const token = before.match(/(^|[\s([{])(:([a-z0-9_+-]{1,32}))$/i);
  if (!token) return null;
  const query = token[3].toLowerCase();
  const ranked = EMOJI.map((entry) => {
    const names = [entry.name, ...(entry.aliases ?? [])];
    const prefix = names.some((name) => name.startsWith(query));
    const contains = names.some((name) => name.includes(query));
    return { entry, score: prefix ? (entry.name.startsWith(query) ? 0 : 1) : contains ? 2 : 9 };
  }).filter((item) => item.score < 9)
    .sort((a, b) => a.score - b.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 8).map((item) => item.entry);
  if (!ranked.length) return null;
  return { start: cursor - token[2].length, end: cursor, results: ranked };
}

const EmojiTextarea = forwardRef<HTMLTextAreaElement, Props>(function EmojiTextarea(
  { value, onValueChange, onKeyDown, onSelect, onClick, onFocus, onBlur, ...props }, forwardedRef,
) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  useImperativeHandle(forwardedRef, () => input.current as HTMLTextAreaElement);

  const match = findMatch(value, cursor);
  const signature = match ? `${match.start}:${match.end}:${value.slice(match.start, match.end)}` : null;
  const open = focused && !!match && signature !== dismissedAt;

  const syncCursor = () => {
    const next = input.current?.selectionStart ?? value.length;
    setCursor(next);
    setActive(0);
    if (signature !== dismissedAt) setDismissedAt(null);
  };

  const choose = (entry: EmojiEntry) => {
    if (!match) return;
    const next = `${value.slice(0, match.start)}${entry.emoji} ${value.slice(match.end)}`;
    const nextCursor = match.start + entry.emoji.length + 1;
    onValueChange(next);
    setCursor(nextCursor);
    setActive(0);
    setDismissedAt(null);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  return (
    <div className="emoji-input-wrap">
      {open && match && (
        <div className="emoji-suggestions" role="listbox" aria-label="Emoji suggestions">
          {match.results.map((entry, index) => (
            <button
              type="button" key={entry.name} role="option" aria-selected={index === active}
              className={index === active ? 'active' : ''}
              onMouseDown={(event) => { event.preventDefault(); choose(entry); }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="emoji-glyph">{entry.emoji}</span><span>:{entry.name}:</span>
            </button>
          ))}
        </div>
      )}
      <textarea
        {...props}
        ref={input}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          setCursor(event.target.selectionStart);
          setActive(0);
          setDismissedAt(null);
        }}
        onSelect={(event) => { syncCursor(); onSelect?.(event); }}
        onClick={(event) => { syncCursor(); onClick?.(event); }}
        onFocus={(event) => { setFocused(true); syncCursor(); onFocus?.(event); }}
        onBlur={(event) => { setFocused(false); onBlur?.(event); }}
        onKeyDown={(event) => {
          if (open && match) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + match.results.length) % match.results.length);
              return;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault();
              choose(match.results[active] ?? match.results[0]);
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setDismissedAt(signature);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
    </div>
  );
});

export default EmojiTextarea;
