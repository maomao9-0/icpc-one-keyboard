const {
  attachMemberAuth,
  normalizeName,
  parseClientId,
  parseClientKey,
  parseName,
  publicSession,
  sameOrigin,
} = require("./security.js");
const store = require("./session-store.js");

const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const noteLimit = 140;
const actions = [
  "join",
  "claim",
  "release",
  "leave",
  "kick",
  "request",
  "requestAccept",
  "requestReject",
  "settings",
  "timer",
];
const maxWriteRetries = 4;

module.exports = async function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method === "POST" && !sameOrigin(req)) {
      return res.status(403).json({ error: "Origin not allowed" });
    }
    if (req.method === "GET") return await getSession(req, res);
    if (req.method === "POST") return await postSession(req, res);
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res
      .status(error.statusCode || 400)
      .json({ error: error.message || "Bad request" });
  }
};

async function getSession(req, res) {
  const code = cleanCode(req.query.code);
  const session = await mutateSession(code, (current) => {
    authorizeMember(current, req.query, {
      allowMissingMembership: false,
      allowRemoved: false,
    });
    if (canRefreshMember(current, req.query.clientId))
      touch(current, req.query);
    expireRequest(current);
  });
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
    event(
      session,
      body,
      "started the timer",
      `${memberName(session, body)} started the timer`,
    );
    return;
  }
  if (command === "stop") {
    session.remainingMs = remaining(session, now);
    session.runningSince = null;
    session.timerRunning = false;
    event(
      session,
      body,
      "stopped the timer",
      `${memberName(session, body)} stopped the timer`,
    );
    return;
  }
  if (command === "reset") {
    const hadRelativeClock = session.clockMode === "relative";
    session.remainingMs = session.durationMs;
    session.runningSince = null;
    session.timerRunning = false;
    event(
      session,
      body,
      "reset the timer",
      `${memberName(session, body)} reset the timer`,
    );
    if (hadRelativeClock) session.clockMode = "local";
    return;
  }
  throw new Error("Unknown timer command");
}

function ensureSession(session) {
  session.durationMs = clampDuration(session.durationMs);
  session.remainingMs = Number.isFinite(Number(session.remainingMs))
    ? Number(session.remainingMs)
    : session.durationMs;
  session.timerRunning = Boolean(session.timerRunning);
  session.runningSince = session.timerRunning
    ? Number(session.runningSince || Date.now())
    : null;
  session.clockMode ||= session.timerStartedAt ? "relative" : "local";
  session.members ||= {};
  for (const member of Object.values(session.members)) {
    if (!member.authKey) member.authKey = "";
  }
  session.events ||= [];
  session.removedClients ||= {};
  session.lastActivityAt = Number(session.lastActivityAt || Date.now());
  backfillEventTiming(session);
  if (session.pendingRequest?.expiresAt <= Date.now()) expireRequest(session);
}

async function postSession(req, res) {
  const body = req.body || {};
  const action = String(body.action || "");
  if (action === "create") {
    const session = await createSession(body);
    const code = session.code;
    return res.json({ code, session: publicSession(session) });
  }
  if (!actions.includes(action)) {
    throw new Error("Unknown action");
  }
  const session = await mutateSession(cleanCode(body.code), (current) => {
    if (action === "join") ensureJoinAllowed(current, body);
    else authorizeMember(current, body);
    if (action !== "join" && isRemovedClient(current, body.clientId)) {
      const error = new Error(
        "You were removed from this session. Join again to continue.",
      );
      error.statusCode = 403;
      throw error;
    }
    if (action !== "leave") touch(current, body);
    if (action === "join") join(current, body);
    if (action === "claim") claim(current, body);
    if (action === "release") release(current, body);
    if (action === "leave") leave(current, body);
    if (action === "kick") kick(current, body);
    if (action === "request") requestKeyboard(current, body);
    if (action === "requestAccept") acceptRequest(current, body);
    if (action === "requestReject") rejectRequest(current, body);
    if (action === "settings") settings(current, body);
    if (action === "timer") timer(current, body);
  });
  const deleted = !session;
  return res.json(
    deleted
      ? { session: null, deleted: true }
      : { session: publicSession(session) },
  );
}

async function createSession(body) {
  for (let tries = 0; tries < 20; tries += 1) {
    const now = Date.now();
    const durationMs = clampDuration(body.durationMs);
    const session = {
      code: randomCode(),
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
    touch(session, body);
    event(
      session,
      body,
      "created the session",
      `${memberName(session, body)} created the session`,
    );
    if (await store.create(session)) return session;
  }
  throw new Error("Could not allocate session code");
}

async function mutateSession(code, mutate) {
  for (let attempt = 0; attempt < maxWriteRetries; attempt += 1) {
    const session = await store.get(code);
    if (!session) {
      const error = new Error("Session not found");
      error.statusCode = 404;
      throw error;
    }
    ensureSession(session);
    const expectedRevision = Number(session.revision || 0);
    mutate(session);
    const outcome = isSessionEmpty(session)
      ? await store.compareAndDelete(code, expectedRevision)
      : await store.compareAndSet(session, expectedRevision);
    if (outcome === 1) return isSessionEmpty(session) ? null : session;
    if (outcome === 0) {
      const error = new Error("Session not found");
      error.statusCode = 404;
      throw error;
    }
  }
  const error = new Error("Session changed concurrently. Please try again.");
  error.statusCode = 409;
  throw error;
}

function join(session, body) {
  const memberName = parseName(body.name);
  const normalizedMemberName = normalizeName(memberName).toLowerCase();
  const duplicate = Object.entries(session.members || {}).find(
    ([clientId, member]) => {
      return (
        clientId !== body.clientId &&
        normalizeName(member.name).toLowerCase() === normalizedMemberName
      );
    },
  );
  if (duplicate) {
    throw new Error(
      `A teammate named "${memberName}" is already in this session`,
    );
  }
  delete session.removedClients[body.clientId];
  touch(session, body);
  event(session, body, "joined", `${memberName} joined`);
}

function claim(session, body) {
  if (session.holder && session.holder.clientId !== body.clientId) {
    throw new Error(`${session.holder.name} is already using the keyboard`);
  }
  session.holder = {
    clientId: body.clientId,
    name: memberName(session, body),
    since: Date.now(),
  };
  session.pendingRequest = null;
  const actionNote = note(body);
  event(
    session,
    body,
    withNote("claimed the keyboard", actionNote),
    withNote(`${memberName(session, body)} claimed the keyboard`, actionNote),
  );
}

function release(session, body) {
  if (!session.holder) throw new Error("Keyboard is already unused");
  if (session.holder.clientId !== body.clientId)
    throw new Error("Only the holder can release the keyboard");
  clearPendingRequest(session);
  const heldFor = clearHolder(session);
  const actionNote = note(body);
  event(
    session,
    body,
    withNote("released the keyboard", actionNote),
    withNote(`${memberName(session, body)} released the keyboard`, actionNote),
    heldFor,
  );
}

function requestKeyboard(session, body) {
  if (!session.holder) throw new Error("Keyboard is unused");
  if (session.holder.clientId === body.clientId)
    throw new Error("You already hold the keyboard");
  const actionNote = note(body);
  session.pendingRequest = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    clientId: String(body.clientId),
    name: memberName(session, body),
    note: actionNote,
    requestedAt: Date.now(),
    expiresAt: Date.now() + 10000,
  };
  event(
    session,
    body,
    withNote("requested the keyboard", actionNote),
    withNote(`${memberName(session, body)} requested the keyboard`, actionNote),
  );
}

function leave(session, body, context = {}) {
  const currentName =
    session.members[body.clientId]?.name || memberName(session, body);
  const wasHolder = session.holder?.clientId === body.clientId;
  if (wasHolder) clearPendingRequest(session);
  const heldFor = wasHolder ? clearHolder(session) : 0;
  clearPendingRequest(session, body.clientId);
  delete session.members[body.clientId];
  const kickedBy = context.kickedByName;
  if (wasHolder) {
    const text = kickedBy
      ? `was kicked by ${kickedBy} and released the keyboard`
      : "left and released the keyboard";
    const message = kickedBy
      ? `${currentName} was kicked by ${kickedBy} and released the keyboard`
      : `${currentName} left and released the keyboard`;
    event(session, { ...body, name: currentName }, text, message, heldFor);
    return;
  }
  if (kickedBy) {
    event(
      session,
      { ...body, name: currentName },
      `was kicked by ${kickedBy}`,
      `${currentName} was kicked by ${kickedBy}`,
    );
    return;
  }
  event(
    session,
    { ...body, name: currentName },
    "left the session",
    `${currentName} left the session`,
  );
}

function kick(session, body) {
  const targetClientId = String(body.targetClientId || "").trim();
  if (!targetClientId) throw new Error("Missing teammate to kick");
  const target = session.members[targetClientId];
  if (!target) throw new Error("Teammate is no longer in this session");
  session.removedClients[targetClientId] = Date.now();
  leave(
    session,
    { ...body, clientId: targetClientId, name: target.name },
    { kickedByName: memberName(session, body) },
  );
}

function isSessionEmpty(session) {
  return (
    !session.holder &&
    !session.pendingRequest &&
    Object.keys(session.members || {}).length === 0
  );
}

function acceptRequest(session, body) {
  expireRequest(session);
  if (!session.pendingRequest) throw new Error("No active request");
  if (!session.holder || session.holder.clientId !== body.clientId)
    throw new Error("Only the holder can accept requests");
  const requester = session.pendingRequest;
  const heldFor = Date.now() - session.holder.since;
  event(
    session,
    body,
    `gave the keyboard to ${requester.name}`,
    `${memberName(session, body)} gave the keyboard to ${requester.name}`,
    heldFor,
  );
  session.holder = {
    clientId: requester.clientId,
    name: requester.name,
    since: Date.now(),
  };
  session.pendingRequest = null;
}

function rejectRequest(session, body) {
  expireRequest(session);
  if (!session.pendingRequest) throw new Error("No active request");
  if (!session.holder || session.holder.clientId !== body.clientId)
    throw new Error("Only the holder can reject requests");
  const requester = session.pendingRequest;
  session.pendingRequest = null;
  event(
    session,
    body,
    `rejected ${requester.name}'s request`,
    `${memberName(session, body)} rejected ${requester.name}'s request`,
  );
}

function expireRequest(session) {
  if (!session.pendingRequest || session.pendingRequest.expiresAt > Date.now())
    return;
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
    clockMs:
      session.clockMode === "relative" ? contestElapsed(session) : Date.now(),
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
  event(
    session,
    body,
    "updated settings",
    `${memberName(session, body)} updated settings`,
  );
  if (durationChanged && hadRelativeClock) session.clockMode = "local";
}

function touch(session, body) {
  const clientId = parseClientId(body.clientId);
  const existing = session.members[clientId];
  const authKey = parseClientKey(body.clientKey);
  const nextName = existing?.name || parseName(body.name);
  session.members[clientId] = attachMemberAuth(
    { name: nextName, seenAt: Date.now() },
    authKey,
  );
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
    clockMs:
      session.clockMode === "relative" ? contestElapsed(session, now) : now,
  });
  session.events = session.events.slice(-80);
}

function canRefreshMember(session, clientId) {
  return Boolean(
    session.members[String(clientId)] && !isRemovedClient(session, clientId),
  );
}

function isRemovedClient(session, clientId) {
  return Boolean(session.removedClients?.[String(clientId)]);
}

function backfillEventTiming(session) {
  for (const entry of session.events) {
    if (entry.timestampMode === "relative" || entry.timestampMode === "local")
      continue;
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
  if (
    !clientId ||
    session.pendingRequest.clientId === clientId ||
    session.holder?.clientId === clientId
  ) {
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
  const value = String(code || "")
    .trim()
    .toUpperCase();
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
    throw new Error(
      "You were removed from this session. Join again if needed.",
    );
  }
  const member = session.members[clientId];
  if (!member) {
    if (options.allowMissingMembership)
      return { clientId, authKey, member: null };
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

function randomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1)
    code += codeChars[Math.floor(Math.random() * codeChars.length)];
  return code;
}
