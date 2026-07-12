import { useCallback, useEffect, useRef, useState } from "react";
import { API, createClientKey, sessionNow } from "../lib/session.js";
import { readStored, writeStored } from "../lib/storage.js";

function initialIdentity() {
  const clientId = readStored("clientId", crypto.randomUUID());
  const clientKey = readStored("clientKey", createClientKey());
  writeStored("clientId", clientId);
  writeStored("clientKey", clientKey);
  return {
    clientId,
    clientKey,
    name: readStored("name"),
    code: new URLSearchParams(location.search).get("code")?.toUpperCase() || "",
  };
}

async function responseData(response) {
  const body = await response.text();
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new Error("The server returned an invalid response.");
  }
}

export function useSessionController() {
  const [identity, setIdentity] = useState(initialIdentity);
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncIssue, setSyncIssue] = useState("");
  const [toast, setToast] = useState("");
  const identityRef = useRef(identity);
  const sessionRef = useRef(session);
  const writesRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const mutationVersionRef = useRef(0);
  const pollRef = useRef(() => {});
  const toastTimer = useRef();
  const seenEvent = useRef("");

  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message, error = false) => {
    setToast(error ? `Error: ${message}` : message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2600);
  }, []);

  const resetHome = useCallback(
    (message = "") => {
      setSession(null);
      setSyncIssue("");
      seenEvent.current = "";
      setIdentity((current) => ({ ...current, code: "" }));
      history.replaceState(null, "", "/");
      if (message) showToast(message, true);
    },
    [showToast],
  );

  const receiveSession = useCallback(
    (nextSession, code, serverNow = Date.now()) => {
      if (!nextSession) return;
      setSession({
        ...nextSession,
        // Map the server epoch to a monotonic client clock. The mapping remains
        // stable if the device clock is adjusted while the contest is running.
        clock: {
          serverNow: Number(serverNow) || Date.now(),
          receivedAt: performance.now(),
        },
      });
      if (code) {
        setIdentity((current) =>
          current.code === code ? current : { ...current, code },
        );
        history.replaceState(null, "", `/?code=${code}`);
      }
      const latest = nextSession.events?.at(-1);
      if (latest && latest.id !== seenEvent.current) {
        if (
          seenEvent.current &&
          latest.clientId !== identityRef.current.clientId &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          new Notification("One Keyboard", { body: latest.message });
        }
        seenEvent.current = latest.id;
      }
    },
    [],
  );

  const payload = useCallback(
    (action, extra = {}) => ({
      action,
      code: identityRef.current.code,
      clientId: identityRef.current.clientId,
      clientKey: identityRef.current.clientKey,
      ...extra,
    }),
    [],
  );

  const call = useCallback(
    async (action, extra = {}) => {
      mutationVersionRef.current += 1;
      const mutationVersion = mutationVersionRef.current;
      const optimisticTimerSession =
        action === "timer" ? sessionRef.current : null;
      writesRef.current += 1;
      setBusy(true);
      if (action === "timer" && sessionRef.current) {
        const now = sessionNow(sessionRef.current);
        setSession((current) => {
          if (!current) return current;
          const remaining =
            current.timerRunning && current.runningSince
              ? Math.max(
                  0,
                  Number(current.remainingMs) -
                    (now - Number(current.runningSince)),
                )
              : Number(current.remainingMs);
          if (extra.command === "stop")
            return {
              ...current,
              remainingMs: remaining,
              timerRunning: false,
              runningSince: null,
            };
          if (extra.command === "start")
            return {
              ...current,
              remainingMs: remaining,
              timerRunning: remaining > 0,
              runningSince: now,
            };
          if (extra.command === "reset")
            return {
              ...current,
              remainingMs: current.durationMs,
              timerRunning: false,
              runningSince: null,
            };
          return current;
        });
      }
      try {
        const response = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload(action, extra)),
        });
        const data = await responseData(response);
        if (!response.ok) throw new Error(data.error || "Request failed");
        if (mutationVersion !== mutationVersionRef.current) return data;
        setSyncIssue("");
        if (action === "leave") resetHome();
        else receiveSession(data.session, data.code, data.serverNow);
        return data;
      } catch (error) {
        const message = error.message || "Request failed";
        if (
          message.includes("removed from this session") ||
          message === "Session access denied"
        )
          resetHome(message);
        else {
          if (
            optimisticTimerSession &&
            mutationVersion === mutationVersionRef.current
          )
            setSession(optimisticTimerSession);
          showToast(message, true);
        }
        return null;
      } finally {
        writesRef.current -= 1;
        setBusy(writesRef.current > 0);
      }
    },
    [payload, receiveSession, resetHome, showToast],
  );

  const poll = useCallback(async () => {
    const current = identityRef.current;
    if (
      !current.code ||
      !sessionRef.current ||
      writesRef.current ||
      pollInFlightRef.current
    )
      return;
    pollInFlightRef.current = true;
    const pollVersion = mutationVersionRef.current;
    try {
      const query = new URLSearchParams({
        code: current.code,
        clientId: current.clientId,
        clientKey: current.clientKey,
      });
      const response = await fetch(`${API}?${query}`);
      const data = await responseData(response);
      if (!response.ok) throw new Error(data.error || "Could not sync session");
      if (writesRef.current || pollVersion !== mutationVersionRef.current)
        return;
      if (!data.session.members?.[current.clientId])
        return resetHome(
          "You were removed from the session. Join again if needed.",
        );
      setSyncIssue("");
      receiveSession(data.session, undefined, data.serverNow);
    } catch (error) {
      const message = error.message || "Could not sync session";
      if (
        message.includes("removed from this session") ||
        message === "Session access denied"
      )
        resetHome(message);
      else setSyncIssue(message);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [receiveSession, resetHome]);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      void pollRef.current();
    }, 1500);
    return () => window.clearInterval(interval);
  }, []);

  const updateIdentity = useCallback(
    (updates) =>
      setIdentity((current) => {
        const next = { ...current, ...updates };
        if (updates.name !== undefined) writeStored("name", next.name);
        return next;
      }),
    [],
  );

  const requestNotifications = useCallback(() => {
    if ("Notification" in window && Notification.permission === "default")
      void Notification.requestPermission();
  }, []);

  return {
    identity,
    session,
    busy,
    syncIssue,
    toast,
    call,
    poll,
    resetHome,
    showToast,
    updateIdentity,
    requestNotifications,
  };
}
