import { useCallback, useRef } from 'react';

/**
 * Serializes a refresh function and folds any number of triggers received while it is running
 * into one final pass. WebSocket events and fallback polls often arrive together; launching a
 * request for every one wastes work and lets responses race each other back into state.
 */
export function useCoalescedRefresh(task: () => Promise<void>): () => Promise<void> {
  const taskRef = useRef(task);
  taskRef.current = task;
  const running = useRef(false);
  const pending = useRef(false);

  return useCallback(async () => {
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        pending.current = false;
        await taskRef.current();
      } while (pending.current);
    } finally {
      running.current = false;
    }
  }, []);
}
