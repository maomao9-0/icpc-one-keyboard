export const API = "/api/session";
export const DEFAULT_DURATION_MS = 5 * 60 * 60 * 1000;
export const ACTION_NOTE_LIMIT = 140;
export const PRESENCE_MS = 10 * 1000;

export function createClientKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function formatClock(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Countdown labels conventionally hold a value for its full second. This also
// avoids showing one second less immediately after pressing Start.
export function formatCountdown(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  return formatClock(safe ? Math.ceil(safe / 1_000) * 1_000 : 0);
}

export function sessionNow(session) {
  const clock = session?.clock;
  if (clock && typeof performance !== "undefined")
    return clock.serverNow + (performance.now() - clock.receivedAt);
  return Date.now();
}

export function remainingMs(session, now = sessionNow(session)) {
  const base = Number(
    session?.remainingMs ?? session?.durationMs ?? DEFAULT_DURATION_MS,
  );
  if (!session?.timerRunning || !session.runningSince) return Math.max(0, base);
  return Math.max(0, base - (now - Number(session.runningSince)));
}

export function requestSeconds(request, now = Date.now()) {
  return Math.max(
    0,
    Math.ceil((Number(request?.expiresAt || 0) - now) / 1_000),
  );
}

export function memberEntries(session) {
  return Object.entries(session?.members || {})
    .map(([clientId, member]) => ({
      clientId,
      name: member.name,
      seenAt: Number(member.seenAt || 0),
    }))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        }) || left.clientId.localeCompare(right.clientId),
    );
}

export function isOnline(member, now = Date.now()) {
  return now - member.seenAt < PRESENCE_MS;
}

export function primaryAction(clientId, session) {
  if (!session?.holder) return "claim";
  return session.holder.clientId === clientId ? "release" : "request";
}

export function actionLabel(action) {
  return {
    claim: "Claim keyboard",
    release: "Release keyboard",
    request: "Request keyboard",
  }[action];
}

export function durationParts(ms) {
  const safe = Math.max(0, Number(ms) || DEFAULT_DURATION_MS);
  return {
    hours: Math.floor(safe / 3_600_000),
    minutes: Math.floor((safe % 3_600_000) / 60_000),
    seconds: Math.floor((safe % 60_000) / 1_000),
  };
}

export function durationFromFields(values) {
  return (
    ((Number(values.hours) || 0) * 3600 +
      (Number(values.minutes) || 0) * 60 +
      (Number(values.seconds) || 0)) *
    1_000
  );
}

export function eventTime(event) {
  if (event?.timestampMode === "relative")
    return `T+${formatClock(event.clockMs)}`;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(event?.clockMs || event?.time || Date.now()));
}

export function formatDuration(ms = 0) {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  const minutes = Math.floor(ms / 60_000);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`
    : `${minutes}m`;
}
