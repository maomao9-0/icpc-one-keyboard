const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  attachMemberAuth,
  normalizeName,
  parseClientId,
  parseClientKey,
  parseName,
  publicSession,
  sameOrigin,
} = require("./security.js");

let sessions = globalThis.__oneKeyboardSessions || new Map();
globalThis.__oneKeyboardSessions = sessions;

const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const storePath = process.env.ONE_KEYBOARD_STORE || path.join(os.tmpdir(), "one-keyboard-sessions.json");
const memoryStore = storePath === ":memory:";
const staleSessionMs = Number(process.env.ONE_KEYBOARD_STALE_SESSION_MS) || 8 * 60 * 60 * 1000;
const noteLimit = 140;
const actions = ["join", "claim", "release", "leave", "kick", "request", "requestAccept", "requestReject", "settings", "timer"];

module.exports = function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "POST" && !sameOrigin(req)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    loadSessions();
    const prunedStale = pruneStaleSessions();
    if (prunedStale) saveSessions();
    if (req.method === "GET") return getSession(req, res);
    if (req.method === "POST") return postSession(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(400).json({ error: error.message || "Bad request" });
  }
};

function getSession(req, res) {
  const code = cleanCode(req.query.code);
  const session = sessions.get(code);
  if (!session) return res.status(404).json({ error: "Session not found" });
  ensureSession(session);
  authorizeMember(session, req.query, { allowMissingMembership: false, allowRemoved: false });
  if (canRefreshMember(session, req.query.clientId)) touch(session, req.query);
  expireRequest(session);
  pruneSession(code, session);
  saveSessions();
  return res.json({ session: publicSession(session) });
}

function remaining(session, now = Date.now()) {
  const base = Number(session.remainingMs ?? session.durationMs);
  if (!session.timerRunning || !session.runningSince) return Math.max(0, base);
  return Math.max(0, base - (now - session.runningSince));
}

function contestElapsed(session, now = Date.now()) {
  return Math.max(0, session.durationMs - remaining(session, now));
}

function timer(session, body) {
  const command = String(body.command || "");
  const now = Date.now();
  session.timerEnabled = true;
  if (command === "start") {
    session.remainingMs = remaining(session, now);
    session.clockMode = "relative";
    session.runningSince = now;
    session.timerRunning = session.remainingMs > 0;
    event(session, body, "started the timer", `${memberName(session, body)} started the timer`);
    return;
  }
  if (command === "stop") {
    session.remainingMs = remaining(session, now);
    session.runningSince = null;
    session.timerRunning = false;
    event(session, body, "stopped the timer", `${memberName(session, body)} stopped the timer`);
    return;
  }
  if (command === "reset") {
    const hadRelativeClock = session.clockMode === "relative";
    session.remainingMs = session.durationMs;
    session.runningSince = null;
    session.timerRunning = false;
    event(session, body, "reset the timer", `${memberName(session, body)} reset the timer`);
    if (hadRelativeClock) session.clockMode = "local";
    return;
  }
  throw new Error("Unknown timer command");
}

function ensureSession(session) {
  session.durationMs = clampDuration(session.durationMs);
  session.remainingMs = Number.isFinite(Number(session.remainingMs)) ? Number(session.remainingMs) : session.durationMs;
  session.timerRunning = Boolean(session.timerRunning);
  session.runningSince = session.timerRunning ? Number(session.runningSince || Date.now()) : null;
  session.clockMode ||= session.timerStartedAt ? "relative" : "local";
  session.members ||= {};
  for (const member of Object.values(session.members)) {
    if (!member.authKey) member.authKey = "";
  }
  session.events ||= [];
  session.removedClients ||= {};
  session.lastActivityAt = Number(session.lastActivityAt || sessionActivityAt(session));
  backfillEventTiming(session);
  if (session.pendingRequest?.expiresAt <= Date.now()) expireRequest(session);
}

function postSession(req, res) {
  const body = req.body || {};
  const action = String(body.action || "");
  if (action === "create") {
    const code = uniqueCode();
    const now = Date.now();
    const durationMs = clampDuration(body.durationMs);
    const session = {
      code,
      createdAt: now,
      durationMs,
      timerEnabled: Boolean(body.timerEnabled),
      timerRunning: false,
      runningSince: null,
      remainingMs: durationMs,
      clockMode: "local",
      members: {},
      pendingRequest: null,
      holder: null,
      events: [],
      removedClients: {},
      lastActivityAt: now,
    };
    sessions.set(code, session);
    touch(session, body);
    event(session, body, "created the session", `${memberName(session, body)} created the session`);
    saveSessions();
    return res.json({ code, session: publicSession(session) });
  }

  const session = sessions.get(cleanCode(body.code));
  if (!session) return res.status(404).json({ error: "Session not found" });
  ensureSession(session);
  if (action === "join") {
    ensureJoinAllowed(session, body);
  } else {
    authorizeMember(session, body);
  }
  if (action !== "join" && isRemovedClient(session, body.clientId)) {
    return res.status(403).json({ error: "You were removed from this session. Join again to continue." });
  }
  if (action !== "leave") touch(session, body);

  if (action === "join") join(session, body);
  if (action === "claim") claim(session, body);
  if (action === "release") release(session, body);
  if (action === "leave") leave(session, body);
  if (action === "kick") kick(session, body);
  if (action === "request") requestKeyboard(session, body);
  if (action === "requestAccept") acceptRequest(session, body);
  if (action === "requestReject") rejectRequest(session, body);
  if (action === "settings") settings(session, body);
  if (action === "timer") timer(session, body);
  if (!actions.includes(action)) {
    return res.status(400).json({ error: "Unknown action" });
  }

  const deleted = pruneSession(cleanCode(body.code), session);
  saveSessions();
  return res.json(deleted ? { session: null, deleted: true } : { session: publicSession(session) });
}

function join(session, body) {
  const memberName = parseName(body.name);
  const normalizedMemberName = normalizeName(memberName).toLowerCase();
  const duplicate = Object.entries(session.members || {}).find(([clientId, member]) => {
    return clientId !== body.clientId && normalizeName(member.name).toLowerCase() === normalizedMemberName;
  });
  if (duplicate) {
    throw new Error(`A teammate named "${memberName}" is already in this session`);
  }
  delete session.removedClients[body.clientId];
  touch(session, body);
  event(session, body, "joined", `${memberName} joined`);
}

function claim(session, body) {
  if (session.holder && session.holder.clientId !== body.clientId) {
    throw new Error(`${session.holder.name} is already using the keyboard`);
  }
  session.holder = { clientId: body.clientId, name: memberName(session, body), since: Date.now() };
  session.pendingRequest = null;
  const actionNote = note(body);
  event(session, body, withNote("claimed the keyboard", actionNote), withNote(`${memberName(session, body)} claimed the keyboard`, actionNote));
}

function release(session, body) {
  if (!session.holder) throw new Error("Keyboard is already unused");
  if (session.holder.clientId !== body.clientId) throw new Error("Only the holder can release the keyboard");
  clearPendingRequest(session);
  const heldFor = clearHolder(session);
  const actionNote = note(body);
  event(session, body, withNote("released the keyboard", actionNote), withNote(`${memberName(session, body)} released the keyboard`, actionNote), heldFor);
}

function requestKeyboard(session, body) {
  if (!session.holder) throw new Error("Keyboard is unused");
  if (session.holder.clientId === body.clientId) throw new Error("You already hold the keyboard");
  const actionNote = note(body);
  session.pendingRequest = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientId: String(body.clientId),
    name: memberName(session, body),
    note: actionNote,
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10000,
  };
  event(session, body, withNote("requested the keyboard", actionNote), withNote(`${memberName(session, body)} requested the keyboard`, actionNote));
}

function leave(session, body, context = {}) {
  const currentName = session.members[body.clientId]?.name || memberName(session, body);
  const wasHolder = session.holder?.clientId === body.clientId;
  if (wasHolder) clearPendingRequest(session);
  const heldFor = wasHolder ? clearHolder(session) : 0;
  clearPendingRequest(session, body.clientId);
  delete session.members[body.clientId];
  const kickedBy = context.kickedByName;
  if (wasHolder) {
    const text = kickedBy ? `was kicked by ${kickedBy} and released the keyboard` : "left and released the keyboard";
    const message = kickedBy ? `${currentName} was kicked by ${kickedBy} and released the keyboard` : `${currentName} left and released the keyboard`;
    event(session, { ...body, name: currentName }, text, message, heldFor);
    return;
  }
  if (kickedBy) {
    event(session, { ...body, name: currentName }, `was kicked by ${kickedBy}`, `${currentName} was kicked by ${kickedBy}`);
    return;
  }
  event(session, { ...body, name: currentName }, "left the session", `${currentName} left the session`);
}

function kick(session, body) {
  const targetClientId = String(body.targetClientId || "").trim();
  if (!targetClientId) throw new Error("Missing teammate to kick");
  const target = session.members[targetClientId];
  if (!target) throw new Error("Teammate is no longer in this session");
  session.removedClients[targetClientId] = Date.now();
  leave(session, { ...body, clientId: targetClientId, name: target.name }, { kickedByName: memberName(session, body) });
}

function isSessionEmpty(session) {
  return !session.holder && !session.pendingRequest && Object.keys(session.members || {}).length === 0;
}

function pruneSession(code, session) {
  if (!isSessionEmpty(session)) return false;
  sessions.delete(code);
  return true;
}

function acceptRequest(session, body) {
  expireRequest(session);
  if (!session.pendingRequest) throw new Error("No active request");
  if (!session.holder || session.holder.clientId !== body.clientId) throw new Error("Only the holder can accept requests");
  const requester = session.pendingRequest;
  const heldFor = Date.now() - session.holder.since;
  event(session, body, `gave the keyboard to ${requester.name}`, `${memberName(session, body)} gave the keyboard to ${requester.name}`, heldFor);
  session.holder = { clientId: requester.clientId, name: requester.name, since: Date.now() };
  session.pendingRequest = null;
}

function rejectRequest(session, body) {
  expireRequest(session);
  if (!session.pendingRequest) throw new Error("No active request");
  if (!session.holder || session.holder.clientId !== body.clientId) throw new Error("Only the holder can reject requests");
  const requester = session.pendingRequest;
  session.pendingRequest = null;
  event(session, body, `rejected ${requester.name}'s request`, `${memberName(session, body)} rejected ${requester.name}'s request`);
}

function expireRequest(session) {
  if (!session.pendingRequest || session.pendingRequest.expiresAt > Date.now()) return;
  const requester = session.pendingRequest;
  session.pendingRequest = null;
  session.events.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: Date.now(),
    clientId: requester.clientId,
    name: requester.name,
    text: "request timed out",
    message: `${requester.name}'s request timed out`,
    durationMs: 0,
    timestampMode: session.clockMode === "relative" ? "relative" : "local",
    clockMs: session.clockMode === "relative" ? contestElapsed(session) : Date.now(),
  });
  session.events = session.events.slice(-80);
}

function settings(session, body) {
  const hadRelativeClock = session.clockMode === "relative";
  session.timerEnabled = Boolean(body.timerEnabled);
  const durationMs = clampDuration(body.durationMs);
  const durationChanged = durationMs !== session.durationMs;
  if (durationMs !== session.durationMs) {
    session.durationMs = durationMs;
    session.remainingMs = durationMs;
    session.runningSince = null;
    session.timerRunning = false;
  }
  event(session, body, "updated settings", `${memberName(session, body)} updated settings`);
  if (durationChanged && hadRelativeClock) session.clockMode = "local";
}

function touch(session, body) {
  const clientId = parseClientId(body.clientId);
  const existing = session.members[clientId];
  const authKey = parseClientKey(body.clientKey);
  const nextName = existing?.name || parseName(body.name);
  session.members[clientId] = attachMemberAuth({ name: nextName, seenAt: Date.now() }, authKey);
  session.lastActivityAt = Date.now();
}

function event(session, body, text, message, durationMs = 0) {
  const now = Date.now();
  session.lastActivityAt = now;
  session.events.push({
    id: `${now}-${Math.random().toString(16).slice(2)}`,
    time: now,
    clientId: String(body.clientId || ""),
    name: memberName(session, body),
    text,
    message,
    durationMs,
    timestampMode: session.clockMode === "relative" ? "relative" : "local",
    clockMs: session.clockMode === "relative" ? contestElapsed(session, now) : now,
  });
  session.events = session.events.slice(-80);
}

function canRefreshMember(session, clientId) {
  return Boolean(session.members[String(clientId)] && !isRemovedClient(session, clientId));
}

function isRemovedClient(session, clientId) {
  return Boolean(session.removedClients?.[String(clientId)]);
}

function backfillEventTiming(session) {
  for (const entry of session.events) {
    if (entry.timestampMode === "relative" || entry.timestampMode === "local") continue;
    entry.timestampMode = "local";
    entry.clockMs = Number(entry.time) || Date.now();
  }
}

function ensureJoinAllowed(session, body) {
  const clientId = parseClientId(body.clientId);
  const authKey = parseClientKey(body.clientKey);
  const existing = session.members[clientId];
  if (existing && existing.authKey && existing.authKey !== authKey) {
    throw new Error("Session access denied");
  }
  return { clientId, authKey };
}

function clearHolder(session) {
  if (!session.holder) return 0;
  const heldFor = Date.now() - session.holder.since;
  session.holder = null;
  return heldFor;
}

function clearPendingRequest(session, clientId = "") {
  if (!session.pendingRequest) return;
  if (!clientId || session.pendingRequest.clientId === clientId || session.holder?.clientId === clientId) {
    session.pendingRequest = null;
  }
}

function note(body) {
  return String(body.note || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, noteLimit);
}

function withNote(base, actionNote) {
  return actionNote ? `${base}: "${actionNote}"` : base;
}

function cleanCode(code) {
  const value = String(code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(value)) throw new Error("Invalid session code");
  return value;
}

function clampDuration(value) {
  const ms = Number(value) || 5 * 60 * 60 * 1000;
  return Math.min(Math.max(ms, 15 * 60 * 1000), 24 * 60 * 60 * 1000);
}

function authorizeMember(session, body, options = {}) {
  const clientId = parseClientId(body.clientId);
  const authKey = parseClientKey(body.clientKey);
  if (options.allowRemoved !== true && isRemovedClient(session, clientId)) {
    throw new Error("You were removed from this session. Join again if needed.");
  }
  const member = session.members[clientId];
  if (!member) {
    if (options.allowMissingMembership) return { clientId, authKey, member: null };
    throw new Error("Session access denied");
  }
  if (!member.authKey) {
    member.authKey = authKey;
  } else if (member.authKey !== authKey) {
    throw new Error("Session access denied");
  }
  return { clientId, authKey, member };
}

function memberName(session, body) {
  const clientId = String(body.clientId || "");
  const stored = session.members?.[clientId]?.name;
  if (stored) return stored;
  return parseName(body.name);
}

function uniqueCode() {
  for (let tries = 0; tries < 20; tries += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) code += codeChars[Math.floor(Math.random() * codeChars.length)];
    if (!sessions.has(code)) return code;
  }
  throw new Error("Could not allocate session code");
}

function loadSessions() {
  if (memoryStore) return;
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    sessions = new Map(JSON.parse(raw));
    globalThis.__oneKeyboardSessions = sessions;
  } catch (error) {
    if (error.code !== "ENOENT") sessions = globalThis.__oneKeyboardSessions || new Map();
  }
}

function saveSessions() {
  if (memoryStore) return;
  const tmp = `${storePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify([...sessions]), "utf8");
  fs.renameSync(tmp, storePath);
}

function pruneStaleSessions(now = Date.now()) {
  let pruned = false;
  for (const [code, session] of sessions) {
    if (now - sessionActivityAt(session) <= staleSessionMs) continue;
    sessions.delete(code);
    pruned = true;
  }
  return pruned;
}

function sessionActivityAt(session) {
  const eventTimes = (session.events || []).map((entry) => Number(entry.time || entry.clockMs || 0));
  const memberTimes = Object.values(session.members || {}).map((member) => Number(member.seenAt || 0));
  return Math.max(
    Number(session.lastActivityAt || 0),
    Number(session.createdAt || 0),
    Number(session.holder?.since || 0),
    Number(session.pendingRequest?.requestedAt || 0),
    ...eventTimes,
    ...memberTimes,
    0,
  );
}
