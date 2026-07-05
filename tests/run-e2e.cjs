const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.join(__dirname, "..");
const cliPath = require.resolve("@playwright/test/cli");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", (error) => {
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function runPlaywright(extraEnv = {}) {
  const child = spawn(process.execPath, [cliPath, "test", ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  return child;
}

async function main() {
  if (process.env.PLAYWRIGHT_BASE_URL) {
    const child = runPlaywright();
    child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }

  const port = await getFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join("tests", "server.cjs")], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      ONE_KEYBOARD_STORE: ":memory:",
    },
    stdio: "inherit",
  });

  let settled = false;
  const cleanup = () => {
    if (server.exitCode === null && !server.killed) server.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  server.once("exit", (code) => {
    if (!settled) {
      settled = true;
      process.exit(code ?? 1);
    }
  });

  await waitForServer(baseURL);

  const child = runPlaywright({ PLAYWRIGHT_BASE_URL: baseURL });
  child.on("exit", (code, signal) => {
    settled = true;
    cleanup();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
