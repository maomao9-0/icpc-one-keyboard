const { Redis } = require("@upstash/redis");

const keyPrefix = "one-keyboard:session:";
const defaultTtlSeconds = 10 * 60 * 60;

function ttlSeconds() {
  return (
    Number(process.env.ONE_KEYBOARD_SESSION_TTL_SECONDS) || defaultTtlSeconds
  );
}

function keyFor(code) {
  return `${keyPrefix}${code}`;
}

function isTestStore() {
  return process.env.ONE_KEYBOARD_STORE === ":memory:";
}

function memorySessions() {
  globalThis.__oneKeyboardMemorySessions ||= new Map();
  return globalThis.__oneKeyboardMemorySessions;
}

function readMemory(code) {
  const entry = memorySessions().get(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    memorySessions().delete(code);
    return null;
  }
  return structuredClone(entry.session);
}

function redis() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    const error = new Error(
      "Session storage is not configured. Connect an Upstash Redis database to this Vercel project.",
    );
    error.statusCode = 500;
    throw error;
  }
  globalThis.__oneKeyboardRedis ||= new Redis({
    url,
    token,
    enableAutoPipelining: true,
  });
  return globalThis.__oneKeyboardRedis;
}

const compareAndSetScript = `
  local current = redis.call("GET", KEYS[1])
  if not current then return 0 end
  local session = cjson.decode(current)
  if tonumber(session.revision or 0) ~= tonumber(ARGV[1]) then return -1 end
  redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3])
  return 1
`;

const compareAndDeleteScript = `
  local current = redis.call("GET", KEYS[1])
  if not current then return 0 end
  local session = cjson.decode(current)
  if tonumber(session.revision or 0) ~= tonumber(ARGV[1]) then return -1 end
  redis.call("DEL", KEYS[1])
  return 1
`;

async function get(code) {
  if (isTestStore()) return readMemory(code);
  return redis().get(keyFor(code));
}

async function create(session) {
  session.revision = 1;
  if (isTestStore()) {
    if (readMemory(session.code)) return false;
    memorySessions().set(session.code, {
      session: structuredClone(session),
      expiresAt: Date.now() + ttlSeconds() * 1000,
    });
    return true;
  }
  const result = await redis().set(keyFor(session.code), session, {
    ex: ttlSeconds(),
    nx: true,
  });
  return result === "OK";
}

async function compareAndSet(session, expectedRevision) {
  session.revision = expectedRevision + 1;
  if (isTestStore()) {
    const current = readMemory(session.code);
    if (!current) return 0;
    if (Number(current.revision || 0) !== expectedRevision) return -1;
    memorySessions().set(session.code, {
      session: structuredClone(session),
      expiresAt: Date.now() + ttlSeconds() * 1000,
    });
    return 1;
  }
  const script = redis().createScript(compareAndSetScript);
  return Number(
    await script.eval(
      [keyFor(session.code)],
      [String(expectedRevision), JSON.stringify(session), String(ttlSeconds())],
    ),
  );
}

async function compareAndDelete(code, expectedRevision) {
  if (isTestStore()) {
    const current = readMemory(code);
    if (!current) return 0;
    if (Number(current.revision || 0) !== expectedRevision) return -1;
    memorySessions().delete(code);
    return 1;
  }
  const script = redis().createScript(compareAndDeleteScript);
  return Number(await script.eval([keyFor(code)], [String(expectedRevision)]));
}

module.exports = { compareAndDelete, compareAndSet, create, get, ttlSeconds };
