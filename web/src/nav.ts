/**
 * Makes the phone's back button/gesture step out of a drilled-down view - a chat, a date
 * room, a full-screen sheet - instead of leaving the whole app. Nothing here is a router:
 * the app has no URLs to speak of, this just keeps a JS-side stack of "what to close" in
 * lockstep with a same-sized stack of real history entries, so popstate (back) always knows
 * exactly what it is closing.
 *
 * Every screen that should be back-able registers a close callback via openView() the
 * moment it opens; that callback is whatever the screen's own on-screen back/close button
 * already runs. Both the hardware back button and that on-screen button end up running the
 * exact same close logic, through closeView() -> history.back() -> popstate.
 */
type CloseFn = () => void;

const stack: CloseFn[] = [];
let installed = false;
/**
 * A back is in flight: history.back() is asynchronous, and until its popstate arrives the
 * stack still shows the view as open. A second closeView() in that window used to issue a
 * second back and close the view underneath too - the photo viewer's close button did exactly
 * that, taking the whole chat with it.
 */
let backPending = false;

function currentDepth(): number {
  const d = (window.history.state as { depth?: number } | null)?.depth;
  return typeof d === 'number' ? d : 0;
}

function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  if (!window.history.state || typeof (window.history.state as any).depth !== 'number') {
    window.history.replaceState({ depth: 0 }, '');
  }
  window.addEventListener('popstate', () => {
    backPending = false;
    const target = currentDepth();
    // Usually pops exactly one, but a fast multi-step swipe-back gesture can jump more than
    // one level at once - closing everything in between rather than getting stuck is correct.
    while (stack.length > target) stack.pop()?.();
  });
}

/** Open a back-able view. `onClose` is the same state change its own back/close button runs. */
export function openView(onClose: CloseFn): void {
  ensureInstalled();
  stack.push(onClose);
  window.history.pushState({ depth: stack.length }, '');
}

/**
 * Swap what back closes, without adding a level - for a view that replaces another one in
 * place (the profile sheet opening a date over itself). Back from the new view goes straight
 * to whatever was open before the one it replaced, matching what is actually on screen.
 */
export function replaceTopView(onClose: CloseFn): void {
  if (stack.length === 0) {
    openView(onClose);
    return;
  }
  stack[stack.length - 1] = onClose;
}

/** A view's own back/close button - triggers the real back navigation and its popstate. */
export function closeView(): void {
  if (stack.length === 0 || backPending) return;
  backPending = true;
  // Belt and braces: should a popstate ever not arrive, closing must not stay blocked.
  window.setTimeout(() => { backPending = false; }, 1000);
  window.history.back();
}

/**
 * A view closing itself for a reason that was not the user pressing back (the match it was
 * open on got deleted out from under it). Keeps the stack and real history in sync without
 * running the close callback a second time - the caller already changed the state itself.
 */
export function forceClose(): void {
  if (stack.length === 0) return;
  stack.pop();
  window.history.back();
}
