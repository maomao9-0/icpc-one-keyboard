import { actionNoteLimit, defaults, liveTickSafetyMs, memberPresenceMs } from "./state.js";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export function fmtClock(ms) {
  const safe = Math.max(0, ms);
  const h = Math.floor(safe / 3600000);
  const m = Math.floor((safe % 3600000) / 60000);
  const s = Math.floor((safe % 60000) / 1000);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function durationParts(ms) {
  const safe = Math.max(0, Number(ms) || defaults.durationMs);
  return {
    hours: Math.floor(safe / 3600000),
    minutes: Math.floor((safe % 3600000) / 60000),
    seconds: Math.floor((safe % 60000) / 1000),
  };
}

export function durationFromFields(data) {
  return ((Number(data.hours) || 0) * 3600 + (Number(data.minutes) || 0) * 60 + (Number(data.seconds) || 0)) * 1000;
}

export function at(event) {
  if (event?.timestampMode === "relative") {
    return `T+${fmtClock(event.clockMs)}`;
  }
  return timeFormatter.format(new Date(event?.clockMs || event?.time || Date.now()));
}

export function remainingMsAt(session, now = Date.now()) {
  const base = Number(session?.remainingMs ?? session?.durationMs ?? defaults.durationMs);
  if (!session?.timerRunning || !session.runningSince) return Math.max(0, base);
  return Math.max(0, base - (now - session.runningSince));
}

export function remainingMs(session) {
  return remainingMsAt(session);
}

export function requestCountdownSeconds(req, now = Date.now()) {
  return Math.max(0, Math.ceil(Math.max(0, Number(req?.expiresAt || 0) - now) / 1000));
}

export function nextClockBoundary(ms, now = Date.now()) {
  const safe = Math.max(0, Number(ms) || 0);
  if (!safe) return Infinity;
  const until = safe % 1000 || 1000;
  return now + until + liveTickSafetyMs;
}

export function memberPresenceDeadline(seenAt, now = Date.now()) {
  const until = Number(seenAt || 0) + memberPresenceMs - now;
  if (until <= 0) return Infinity;
  return now + until + liveTickSafetyMs;
}

export function sessionMemberEntries(session) {
  return Object.entries(session?.members || {}).map(([clientId, member]) => ({
    clientId,
    name: member.name,
    seenAt: Number(member.seenAt || 0),
  }));
}

export function teammateSort(left, right) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.clientId.localeCompare(right.clientId);
}

export function teammateEntries(session) {
  return sessionMemberEntries(session).sort(teammateSort);
}

export function memberPresence(member, now = Date.now()) {
  const online = now - member.seenAt < memberPresenceMs;
  return {
    online,
    text: online ? "online" : "idle",
    deadline: online ? memberPresenceDeadline(member.seenAt, now) : Infinity,
  };
}

export function duration(ms = 0) {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }
  return `${Math.round(ms / 60000)}m`;
}

export function esc(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

export function primaryActionFor(clientId, session) {
  const holder = session?.holder;
  if (!holder) return "claim";
  return holder.clientId === clientId ? "release" : "request";
}

export function primaryActionLabel(action) {
  return {
    claim: "Claim keyboard",
    release: "Release keyboard",
    request: "Request keyboard",
  }[action];
}

export function actionNoteLabel(action) {
  return {
    claim: "Optional claim note",
    release: "Optional release note",
    request: "Optional request note",
  }[action];
}

export function actionNotePlaceholder(action) {
  return {
    claim: "Optional note… Taking over to debug input parsing",
    release: "Optional note… Handing off with the timer paused",
    request: "Optional note… Need the keyboard for problem C",
  }[action];
}

export function actionNoteHint(action) {
  return {
    claim: "Shown in team activity if you claim the keyboard.",
    release: "Shown in team activity if you release the keyboard.",
    request: "Shown in team activity and in the holder’s request popup.",
  }[action];
}

export function trimmedActionNote(value) {
  return String(value || "").trim().slice(0, actionNoteLimit);
}

export function sessionFingerprint(session) {
  if (!session) return "";
  const members = sessionMemberEntries(session)
    .sort((left, right) => left.clientId.localeCompare(right.clientId))
    .map(({ clientId, name }) => ({ clientId, name }));
  const events = (session.events || []).map(({ id, time, clientId, name, text, message, durationMs, timestampMode, clockMs }) => ({
    id,
    time,
    clientId,
    name,
    text,
    message,
    durationMs,
    timestampMode,
    clockMs,
  }));
  return JSON.stringify({
    code: session.code,
    clockMode: session.clockMode || "local",
    durationMs: session.durationMs,
    remainingMs: session.remainingMs,
    timerEnabled: Boolean(session.timerEnabled),
    timerRunning: Boolean(session.timerRunning),
    runningSince: session.runningSince || null,
    holder: session.holder ? { ...session.holder } : null,
    pendingRequest: session.pendingRequest
      ? {
          id: session.pendingRequest.id,
          clientId: session.pendingRequest.clientId,
          name: session.pendingRequest.name,
          note: session.pendingRequest.note || "",
          requestedAt: session.pendingRequest.requestedAt,
        }
      : null,
    members,
    events,
  });
}
