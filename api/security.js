const crypto = require("node:crypto");

const allowedNamePattern = /^[\p{L}\p{N} .,'()\-_/]+$/u;

function randomSecret() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseName(value) {
  const name = normalizeName(value).slice(0, 32);
  if (!name) throw new Error("Missing name");
  if (!allowedNamePattern.test(name)) throw new Error("Name contains unsupported characters");
  return name;
}

function parseClientId(value) {
  const clientId = String(value || "").trim().slice(0, 80);
  if (!clientId) throw new Error("Missing client id");
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(clientId)) throw new Error("Invalid client id");
  return clientId;
}

function parseClientKey(value) {
  const clientKey = String(value || "").trim().toLowerCase();
  if (!clientKey) throw new Error("Missing client key");
  if (!/^[a-f0-9]{32,64}$/.test(clientKey)) throw new Error("Invalid client key");
  return clientKey;
}

function sameOrigin(req) {
  const origin = req.headers?.origin || "";
  const referer = req.headers?.referer || "";
  const host = req.headers?.host || "";
  if (!host || (!origin && !referer)) return true;
  const allowed = new Set([`http://${host}`, `https://${host}`]);
  try {
    if (origin) return allowed.has(new URL(origin).origin);
    return allowed.has(new URL(referer).origin);
  } catch {
    return false;
  }
}

function attachMemberAuth(member, authKey = randomSecret()) {
  return {
    ...member,
    authKey,
  };
}

function publicSession(session) {
  if (!session) return null;
  return {
    code: session.code,
    createdAt: session.createdAt,
    durationMs: session.durationMs,
    timerEnabled: Boolean(session.timerEnabled),
    timerRunning: Boolean(session.timerRunning),
    runningSince: session.runningSince,
    remainingMs: session.remainingMs,
    clockMode: session.clockMode || "local",
    holder: session.holder ? { ...session.holder } : null,
    pendingRequest: session.pendingRequest ? { ...session.pendingRequest } : null,
    members: Object.fromEntries(
      Object.entries(session.members || {}).map(([clientId, member]) => [
        clientId,
        { name: member.name, seenAt: member.seenAt },
      ]),
    ),
    events: (session.events || []).map((entry) => ({ ...entry })),
  };
}

module.exports = {
  attachMemberAuth,
  normalizeName,
  parseClientId,
  parseClientKey,
  parseName,
  publicSession,
  randomSecret,
  sameOrigin,
};
