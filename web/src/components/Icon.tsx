/**
 * The icon set, as inline SVG.
 *
 * These were emoji and stray unicode glyphs (🔥, ⋯, ＋, ↻, ◔). Emoji render as a different
 * typeface on every platform, sit on their own baseline, cannot take the accent colour and
 * are the fastest way to make an interface look unfinished. Stroke icons inherit
 * currentColor and line up with the text around them.
 */

import type { ReactNode } from 'react';

export type IconName =
  | 'spark'
  | 'chat'
  | 'settings'
  | 'back'
  | 'more'
  | 'send'
  | 'plus'
  | 'refresh'
  | 'close'
  | 'heart'
  | 'cross'
  | 'eye'
  | 'play'
  | 'alert'
  | 'check'
  | 'camera';

/** 24x24 grid, 1.75 stroke, round caps - one consistent drawing style for all of them. */
const PATHS: Record<IconName, ReactNode> = {
  spark: (
    <path d="M12 3c.6 3.2 2.2 5 4.6 6.2C14 10.6 12.7 12.6 12 16c-.7-3.4-2-5.4-4.6-6.8C9.8 8 11.4 6.2 12 3Zm5.8 9.4c.3 1.6 1.1 2.5 2.2 3.1-1.2.7-1.9 1.7-2.2 3.4-.4-1.7-1-2.7-2.3-3.4 1.2-.6 1.9-1.5 2.3-3.1ZM6 13.6c.3 1.4.9 2.2 1.9 2.7-1 .6-1.6 1.4-1.9 2.9-.3-1.5-.9-2.3-2-2.9 1.1-.5 1.7-1.3 2-2.7Z" />
  ),
  chat: (
    <path d="M20 11.5c0 3.6-3.6 6.5-8 6.5-.9 0-1.8-.1-2.6-.35L4.5 19.5l1.2-3.1C4.6 15.1 4 13.4 4 11.5 4 7.9 7.6 5 12 5s8 2.9 8 6.5Z" />
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2.4" />
      <circle cx="8" cy="17" r="2.4" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18.5" r="1.4" />
    </>
  ),
  send: <path d="M5 12.5 19.5 5.5 13.5 19.5l-2.3-5.6-6.2-1.4Z" />,
  plus: <path d="M12 6v12M6 12h12" />,
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.3-5.2" />
      <path d="M19.5 5v4h-4" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  heart: (
    <path d="M12 19.5S4.5 15 4.5 9.8A3.8 3.8 0 0 1 12 8.2a3.8 3.8 0 0 1 7.5 1.6C19.5 15 12 19.5 12 19.5Z" />
  ),
  cross: <path d="M7 7l10 10M17 7L7 17" />,
  eye: (
    <>
      <path d="M3 12s3.4-5.5 9-5.5S21 12 21 12s-3.4 5.5-9 5.5S3 12 3 12Z" />
      <circle cx="12" cy="12" r="2.4" />
    </>
  ),
  play: <path d="M9 6.5l8 5.5-8 5.5v-11Z" />,
  alert: (
    <>
      <path d="M12 4.5 21 19H3l9-14.5Z" />
      <path d="M12 10v4M12 16.6v.1" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  camera: (
    <>
      <path d="M4 8.5h3.2l1.4-2h6.8l1.4 2H20a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.3" r="3.3" />
    </>
  ),
};

/** Icons that read better filled than stroked. */
const FILLED = new Set<IconName>(['spark', 'send', 'play', 'more']);

export default function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
