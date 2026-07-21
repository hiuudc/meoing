import { useCallback, useEffect, useRef, useState } from "react";

interface ExitPresenceOptions {
  exitDuration?: number;
  onExited?: () => void;
}

export function useExitPresence(
  open: boolean,
  { exitDuration = 220, onExited }: ExitPresenceOptions = {},
) {
  const [isMounted, setIsMounted] = useState(open);
  const exitCompleted = useRef(!open);
  const exitTimer = useRef<number | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  const completeExit = useCallback(() => {
    if (exitCompleted.current) return;
    exitCompleted.current = true;
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = null;
    setIsMounted(false);
    onExitedRef.current?.();
  }, []);

  useEffect(() => {
    if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
    exitTimer.current = null;

    if (open) {
      exitCompleted.current = false;
      setIsMounted(true);
      return;
    }

    if (!isMounted || exitCompleted.current) return;

    exitTimer.current = window.setTimeout(completeExit, exitDuration + 50);
    return () => {
      if (exitTimer.current !== null) window.clearTimeout(exitTimer.current);
      exitTimer.current = null;
    };
  }, [completeExit, exitDuration, isMounted, open]);

  function onAnimationEnd(event: React.AnimationEvent<HTMLElement>) {
    if (open || event.target !== event.currentTarget) return;
    completeExit();
  }

  return {
    isMounted,
    presenceState: open ? "open" : "closed",
    onAnimationEnd,
  };
}
