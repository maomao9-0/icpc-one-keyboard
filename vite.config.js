import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const require = createRequire(import.meta.url);
const sessionHandler = require("./api/session.js");

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function apiResponse(res) {
  return {
    statusCode: 200,
    setHeader: (...args) => res.setHeader(...args),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      res.writeHead(this.statusCode, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    },
  };
}

function localSessionApi() {
  return {
    name: "one-keyboard-local-session-api",
    configureServer(server) {
      // Local development deliberately uses the test adapter. Production never
      // falls back to it: it requires the Upstash credentials injected by Vercel.
      if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.KV_REST_API_URL) {
        process.env.ONE_KEYBOARD_STORE ||= ":memory:";
      }
      server.middlewares.use("/api/session", async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        req.query = Object.fromEntries(url.searchParams);
        req.body = req.method === "POST" ? await readJsonBody(req) : {};
        await sessionHandler(req, apiResponse(res));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localSessionApi()],
});
