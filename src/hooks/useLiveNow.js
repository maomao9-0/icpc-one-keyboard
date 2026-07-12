import { useEffect, useState } from "react";
import { PRESENCE_MS, remainingMs, requestSeconds } from "../lib/session.js";

export function useLiveNow(session, onRequestExpiry) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!session || document.hidden) return undefined;
    let timeoutId;
    const update = () => {
      const current = Date.now();
      setNow(current);
      const deadlines = [];
      if (session.timerRunning && remainingMs(session, current) > 0)
        deadlines.push(current + 1_000 - (current % 1_000) + 20);
      if (session.pendingRequest) {
        const seconds = requestSeconds(session.pendingRequest, current);
        if (seconds === 0) {
          onRequestExpiry?.(session.pendingRequest.id);
        } else {
          deadlines.push(current + 1_000 - (current % 1_000) + 20);
        }
      }
      for (const member of Object.values(session.members || {})) {
        const deadline = Number(member.seenAt || 0) + PRESENCE_MS + 20;
        if (deadline > current) deadlines.push(deadline);
      }
      const next = Math.min(...deadlines);
      if (Number.isFinite(next))
        timeoutId = window.setTimeout(update, Math.max(20, next - Date.now()));
    };
    update();
    return () => window.clearTimeout(timeoutId);
  }, [
    session?.timerRunning,
    session?.runningSince,
    session?.remainingMs,
    session?.pendingRequest?.id,
    session?.pendingRequest?.expiresAt,
    session?.members,
    onRequestExpiry,
  ]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return now;
}
