import { useEffect, useRef, useState } from "react";
import {
  PRESENCE_MS,
  remainingMs,
  requestSeconds,
  sessionNow,
} from "../lib/session.js";

export function useLiveNow(session, onRequestExpiry) {
  const [now, setNow] = useState(() => sessionNow(session));
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  const onRequestExpiryRef = useRef(onRequestExpiry);
  const expiredRequestId = useRef("");
  const sessionRef = useRef(session);

  useEffect(() => {
    onRequestExpiryRef.current = onRequestExpiry;
  }, [onRequestExpiry]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    if (!session || !visible) return undefined;
    let timeoutId;
    const update = () => {
      // Never add one second to the previous tick.  Timers can run late (and
      // are throttled in background tabs), so each tick is recalculated from
      // the authoritative deadline instead.
      const current = sessionNow(session);
      setNow(current);
      const delays = [];
      if (session.timerRunning) {
        const remaining = remainingMs(session, current);
        if (remaining > 0) delays.push(remaining % 1_000 || 1_000);
      }
      if (session.pendingRequest) {
        const seconds = requestSeconds(session.pendingRequest, current);
        if (seconds === 0) {
          if (expiredRequestId.current !== session.pendingRequest.id) {
            expiredRequestId.current = session.pendingRequest.id;
            onRequestExpiryRef.current?.(session.pendingRequest.id);
          }
        } else {
          const remaining = Number(session.pendingRequest.expiresAt) - current;
          delays.push(remaining % 1_000 || 1_000);
        }
      }
      for (const member of Object.values(session.members || {})) {
        const untilIdle = Number(member.seenAt || 0) + PRESENCE_MS - current;
        if (untilIdle > 0) delays.push(untilIdle);
      }
      const nextDelay = Math.min(...delays);
      if (Number.isFinite(nextDelay))
        timeoutId = window.setTimeout(update, Math.max(20, nextDelay + 8));
    };
    update();
    return () => window.clearTimeout(timeoutId);
  }, [
    visible,
    session?.timerRunning,
    session?.runningSince,
    session?.remainingMs,
    session?.pendingRequest?.id,
    session?.pendingRequest?.expiresAt,
    session?.members,
    session?.clock?.serverNow,
    session?.clock?.receivedAt,
  ]);

  useEffect(() => {
    const onVisibility = () => {
      const isVisible = !document.hidden;
      setVisible(isVisible);
      if (!isVisible) return;

      const currentSession = sessionRef.current;
      const current = sessionNow(currentSession);
      setNow(current);
      const request = currentSession?.pendingRequest;
      if (
        request &&
        requestSeconds(request, current) === 0 &&
        expiredRequestId.current !== request.id
      ) {
        expiredRequestId.current = request.id;
        onRequestExpiryRef.current?.(request.id);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return now;
}
