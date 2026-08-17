import { remainingMs } from "./session.js";

const paletteSize = 6;

function paletteIndex(clientId) {
  let hash = 0;
  for (const character of String(clientId))
    hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % paletteSize;
}

export function formatAnalysisDuration(ms = 0) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60)
    return `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "0%";
  const percent = Math.max(0, Math.min(100, value * 100));
  return `${percent < 10 && percent % 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function analysisSnapshot(session, now) {
  const source = session?.analysis;
  const durationMs = Math.max(1, Number(session?.durationMs || 0));
  if (!source) return emptySnapshot(durationMs);

  const elapsedMs = source.started
    ? Math.min(durationMs, durationMs - remainingMs(session, now))
    : 0;
  const liveDelta = Math.max(0, elapsedMs - Number(source.elapsedMs || 0));
  const members = [];
  const memberById = new Map();

  for (const [clientId, rawMember] of Object.entries(source.members || {})) {
    const member = {
      clientId,
      name: rawMember.name || "Former teammate",
      heldMs: Number(rawMember.heldMs || 0),
      turns: Number(rawMember.turns || 0),
      longestMs: Number(rawMember.longestMs || 0),
      requests: Number(rawMember.requests || 0),
      fulfilledRequests: Number(rawMember.fulfilledRequests || 0),
      palette: paletteIndex(clientId),
    };
    members.push(member);
    memberById.set(clientId, member);
  }

  const currentHolderId = source.currentHolderId;
  let currentStintMs = Number(source.currentStintMs || 0);
  let freeMs = Number(source.freeMs || 0);
  if (liveDelta > 0 && currentHolderId) {
    let current = memberById.get(currentHolderId);
    if (!current) {
      current = {
        clientId: currentHolderId,
        name: session.holder?.name || "Former teammate",
        heldMs: 0,
        turns: 1,
        longestMs: 0,
        requests: 0,
        fulfilledRequests: 0,
        palette: paletteIndex(currentHolderId),
      };
      members.push(current);
      memberById.set(currentHolderId, current);
    }
    current.heldMs += liveDelta;
    currentStintMs += liveDelta;
  } else if (liveDelta > 0) {
    freeMs += liveDelta;
  }

  if (currentHolderId) {
    const current = memberById.get(currentHolderId);
    if (current)
      current.longestMs = Math.max(current.longestMs, currentStintMs);
  }

  let heldMs = 0;
  let turns = 0;
  let longest = null;
  for (const member of members) {
    heldMs += member.heldMs;
    turns += member.turns;
    member.averageMs = member.turns ? member.heldMs / member.turns : 0;
    member.share = elapsedMs ? member.heldMs / elapsedMs : 0;
    if (!longest || member.longestMs > longest.durationMs)
      longest = { name: member.name, durationMs: member.longestMs };
  }
  members.sort(
    (left, right) =>
      right.heldMs - left.heldMs || left.name.localeCompare(right.name),
  );

  const untrackedMs = Number(source.untrackedMs || 0);
  const knownMs = Math.max(0, elapsedMs - untrackedMs);
  const timeline = buildTimeline(source.timeline || [], memberById, elapsedMs);
  const requests = {
    total: Number(source.requests?.total || 0),
    accepted: Number(source.requests?.accepted || 0),
    rejected: Number(source.requests?.rejected || 0),
    expired: Number(source.requests?.expired || 0),
  };

  return {
    cycleId: source.cycleId,
    started: Boolean(source.started),
    complete: Boolean(source.started && elapsedMs >= durationMs),
    durationMs,
    elapsedMs,
    heldMs,
    freeMs,
    untrackedMs,
    utilization: knownMs ? heldMs / knownMs : 0,
    transitions: Number(source.transitions || 0),
    handoffs: Number(source.handoffs || 0),
    averageHoldMs: turns ? heldMs / turns : 0,
    turns,
    requests,
    members,
    longest,
    timeline,
  };
}

function buildTimeline(points, memberById, elapsedMs) {
  const intervals = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const startMs = Math.max(0, Math.min(elapsedMs, Number(point.atMs || 0)));
    const endMs = Math.max(
      startMs,
      Math.min(elapsedMs, Number(points[index + 1]?.atMs ?? elapsedMs)),
    );
    if (endMs <= startMs) continue;
    const member = point.clientId ? memberById.get(point.clientId) : null;
    intervals.push({
      clientId: point.clientId,
      name: point.name || member?.name || "Free",
      startMs,
      endMs,
      palette:
        point.clientId === "__untracked__"
          ? "untracked"
          : (member?.palette ?? "free"),
    });
  }
  return intervals;
}

function emptySnapshot(durationMs) {
  return {
    cycleId: "",
    started: false,
    complete: false,
    durationMs,
    elapsedMs: 0,
    heldMs: 0,
    freeMs: 0,
    untrackedMs: 0,
    utilization: 0,
    transitions: 0,
    handoffs: 0,
    averageHoldMs: 0,
    turns: 0,
    requests: { total: 0, accepted: 0, rejected: 0, expired: 0 },
    members: [],
    longest: null,
    timeline: [],
  };
}
