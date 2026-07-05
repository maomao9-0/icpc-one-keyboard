const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.PLAYWRIGHT_PORT || 4173);
const origin = `http://${host}:${port}`;
process.env.ONE_KEYBOARD_STORE ||= ":memory:";
const handler = require("../api/session.js");

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function jsonBody(req) {
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

function apiRes(res) {
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === "/api/session") {
    req.query = Object.fromEntries(url.searchParams);
    req.body = req.method === "POST" ? await jsonBody(req) : {};
    handler(req, apiRes(res));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safePath = path.normalize(path.join(root, file));
  if (!safePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(safePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(safePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(port, host);
