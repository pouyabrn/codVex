const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const WebSocket = require("ws");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3010);
const THREAD_SYNC_INTERVAL_MS = Number(process.env.THREAD_SYNC_INTERVAL_MS || 2500);
const DEFAULT_THREAD_CWD = process.env.CODEX_THREAD_CWD || process.cwd();

const STATIC_DIR = path.join(__dirname, "public");
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

function log(scope, message, details) {
  const parts = [`[${scope}]`, message];
  if (details !== undefined) {
    parts.push(typeof details === "string" ? details : JSON.stringify(details));
  }
  console.log(parts.join(" "));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileExists(filePath) {
  return fsp
    .access(filePath, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

function getArchDir() {
  const arch = os.arch();
  if (arch === "x64") {
    return "linux-x86_64";
  }
  if (arch === "arm64") {
    return "linux-aarch64";
  }
  return `linux-${arch}`;
}

async function findCodexBinary() {
  if (process.env.CODEX_BIN && (await fileExists(process.env.CODEX_BIN))) {
    return process.env.CODEX_BIN;
  }

  const archDir = getArchDir();
  const homeDir = os.homedir();
  const roots = [
    path.join(homeDir, ".cursor-server", "extensions"),
    path.join(homeDir, ".vscode-server", "extensions"),
    path.join(homeDir, ".vscode", "extensions"),
  ];

  const candidates = [];
  for (const root of roots) {
    if (!(await fileExists(root))) {
      continue;
    }
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (!entry.name.startsWith("openai.chatgpt-")) {
        continue;
      }
      const binaryPath = path.join(root, entry.name, "bin", archDir, "codex");
      if (await fileExists(binaryPath)) {
        const stats = await fsp.stat(binaryPath);
        candidates.push({ binaryPath, mtimeMs: stats.mtimeMs });
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(
      "Could not find the Codex binary. Set CODEX_BIN to the full path of your local codex executable."
    );
  }

  return candidates[0].binaryPath;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sanitizeThreadPreview(text) {
  if (!text) {
    return "Untitled thread";
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 120);
}

function summarizeThread(thread) {
  return {
    id: thread.id,
    preview: sanitizeThreadPreview(thread.preview),
    cwd: thread.cwd,
    source: thread.source,
    status: thread.status,
    updatedAt: thread.updatedAt,
    path: thread.path,
    name: thread.name,
  };
}

class CodexBridge {
  constructor() {
    this.codexBin = null;
    this.appServerChild = null;
    this.appServerPort = null;
    this.appServerUrl = null;
    this.upstream = null;
    this.pendingRpc = new Map();
    this.pendingServerRequests = new Map();
    this.browserClients = new Set();
    this.loadedThreadIds = new Set();
    this.selectedThreadId = null;
    this.selectedThreadSnapshotKey = null;
    this.rpcCounter = 1;
    this.ready = false;
    this.syncTimer = null;
    this.connecting = false;
  }

  async start() {
    this.codexBin = await findCodexBinary();
    this.appServerPort = await getFreePort();
    this.appServerUrl = `ws://127.0.0.1:${this.appServerPort}`;

    await this.startAppServer();
    await this.connectUpstream();

    this.syncTimer = setInterval(() => {
      this.syncSelectedThread().catch((error) => {
        log("sync", "Selected thread refresh failed", error.message);
      });
    }, THREAD_SYNC_INTERVAL_MS);
  }

  async startAppServer() {
    log("bridge", "Starting local Codex app-server", {
      binary: this.codexBin,
      url: this.appServerUrl,
    });

    this.appServerChild = spawn(
      this.codexBin,
      ["app-server", "--listen", this.appServerUrl],
      {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    this.appServerChild.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        log("codex", text);
      }
    });

    this.appServerChild.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        log("codex", text);
      }
    });

    this.appServerChild.on("exit", (code, signal) => {
      this.ready = false;
      log("codex", `app-server exited`, { code, signal });
      this.broadcast({
        type: "bridgeStatus",
        status: this.getStatus(),
      });
    });

    await this.waitForHealth();
  }

  async waitForHealth() {
    const readyUrl = `http://127.0.0.1:${this.appServerPort}/readyz`;
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(readyUrl);
        if (response.ok) {
          return;
        }
      } catch (_error) {
        // Still starting.
      }
      await sleep(250);
    }

    throw new Error("Timed out waiting for Codex app-server to become ready.");
  }

  async connectUpstream() {
    if (this.connecting) {
      return;
    }
    this.connecting = true;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.appServerUrl);
      this.upstream = socket;

      socket.on("open", async () => {
        try {
          await this.initializeSession();
          this.ready = true;
          this.connecting = false;
          this.broadcast({
            type: "bridgeStatus",
            status: this.getStatus(),
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      socket.on("message", (raw) => {
        this.handleUpstreamMessage(raw.toString("utf8")).catch((error) => {
          log("upstream", "Failed to handle message", error.message);
        });
      });

      socket.on("close", () => {
        this.ready = false;
        this.loadedThreadIds.clear();
        this.broadcast({
          type: "bridgeStatus",
          status: this.getStatus(),
        });
      });

      socket.on("error", (error) => {
        reject(error);
      });
    });
  }

  async initializeSession() {
    await this.rpc("initialize", {
      clientInfo: {
        name: "codvex-mobile-bridge",
        title: "CodVex Mobile Bridge",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.send({
      method: "initialized",
    });
  }

  send(payload) {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      throw new Error("Codex app-server websocket is not connected.");
    }
    this.upstream.send(JSON.stringify(payload));
  }

  rpc(method, params) {
    const id = this.rpcCounter++;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, 30000);

      this.pendingRpc.set(id, { resolve, reject, timeout, method });
      this.send({ id, method, params });
    });
  }

  async handleUpstreamMessage(raw) {
    const message = JSON.parse(raw);

    if (message.id !== undefined && message.method) {
      this.pendingServerRequests.set(String(message.id), message);
      this.broadcast({
        type: "serverRequest",
        requestId: String(message.id),
        method: message.method,
        params: message.params,
      });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pendingRpc.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRpc.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(message.error.message || `Request ${pending.method} failed.`)
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (!message.method) {
      return;
    }

    await this.handleNotification(message);
  }

  async handleNotification(message) {
    const { method, params } = message;

    if (method === "thread/status/changed") {
      if (params.status?.type === "notLoaded") {
        this.loadedThreadIds.delete(params.threadId);
      } else {
        this.loadedThreadIds.add(params.threadId);
      }
    }

    if (method === "thread/closed") {
      this.loadedThreadIds.delete(params.threadId);
    }

    if (method === "serverRequest/resolved") {
      this.pendingServerRequests.delete(String(params.requestId));
    }

    if (method === "turn/completed" && params.threadId === this.selectedThreadId) {
      await this.syncSelectedThread(true);
    }

    if (method === "item/completed" && params.threadId === this.selectedThreadId) {
      await this.syncSelectedThread(true);
    }

    this.broadcast({
      type: "notification",
      method,
      params,
    });
  }

  getStatus() {
    return {
      ready: this.ready,
      codexBin: this.codexBin,
      appServerUrl: this.appServerUrl,
      host: HOST,
      port: PORT,
      selectedThreadId: this.selectedThreadId,
      defaultThreadCwd: DEFAULT_THREAD_CWD,
      pendingRequests: Array.from(this.pendingServerRequests.values()).map((request) => ({
        requestId: String(request.id),
        method: request.method,
        params: request.params,
      })),
    };
  }

  addBrowserSocket(socket) {
    this.browserClients.add(socket);
    socket.send(
      JSON.stringify({
        type: "bridgeStatus",
        status: this.getStatus(),
      })
    );

    socket.on("close", () => {
      this.browserClients.delete(socket);
    });
  }

  broadcast(payload) {
    const body = JSON.stringify(payload);
    for (const socket of this.browserClients) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(body);
      }
    }
  }

  async listThreads(cwd) {
    const result = await this.rpc("thread/list", {
      limit: 30,
      cwd: cwd || null,
      archived: false,
    });

    const threads = (result.data || []).map(summarizeThread);
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    return threads;
  }

  async readThread(threadId) {
    const result = await this.rpc("thread/read", {
      threadId,
      includeTurns: true,
    });
    return result.thread;
  }

  async selectThread(threadId) {
    this.selectedThreadId = threadId;
    this.selectedThreadSnapshotKey = null;
    await this.syncSelectedThread(true);
    this.broadcast({
      type: "bridgeStatus",
      status: this.getStatus(),
    });
  }

  async syncSelectedThread(force = false) {
    if (!this.selectedThreadId) {
      return;
    }
    const thread = await this.readThread(this.selectedThreadId);
    const nextKey = JSON.stringify(thread);

    if (!force && nextKey === this.selectedThreadSnapshotKey) {
      return;
    }

    this.selectedThreadSnapshotKey = nextKey;
    this.broadcast({
      type: "threadSnapshot",
      thread,
    });
  }

  async ensureThreadLoaded(threadId) {
    if (this.loadedThreadIds.has(threadId)) {
      return;
    }

    await this.rpc("thread/resume", {
      threadId,
      persistExtendedHistory: false,
    });

    this.loadedThreadIds.add(threadId);
  }

  async sendMessage(threadId, text) {
    await this.ensureThreadLoaded(threadId);

    return this.rpc("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text,
          text_elements: [],
        },
      ],
    });
  }

  async respondToServerRequest(requestId, result) {
    const pending = this.pendingServerRequests.get(String(requestId));
    if (!pending) {
      throw new Error(`No pending server request with id ${requestId}.`);
    }

    this.send({
      id: pending.id,
      result,
    });
  }
}

function renderStaticFile(filePath, res) {
  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] || "application/octet-stream";
  const stream = fs.createReadStream(filePath);

  stream.on("error", () => {
    sendJson(res, 404, { error: "Not found." });
  });

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  stream.pipe(res);
}

async function main() {
  const bridge = new CodexBridge();
  await bridge.start();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/api/status" && req.method === "GET") {
        sendJson(res, 200, bridge.getStatus());
        return;
      }

      if (url.pathname === "/api/threads" && req.method === "GET") {
        const cwd = url.searchParams.get("cwd") || DEFAULT_THREAD_CWD;
        const threads = await bridge.listThreads(cwd);
        sendJson(res, 200, { cwd, threads });
        return;
      }

      if (url.pathname === "/api/thread" && req.method === "GET") {
        const threadId = url.searchParams.get("threadId");
        if (!threadId) {
          sendJson(res, 400, { error: "Missing threadId." });
          return;
        }
        const thread = await bridge.readThread(threadId);
        sendJson(res, 200, { thread });
        return;
      }

      if (url.pathname === "/api/thread/select" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.threadId) {
          sendJson(res, 400, { error: "Missing threadId." });
          return;
        }
        await bridge.selectThread(body.threadId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/thread/message" && req.method === "POST") {
        const body = await readJsonBody(req);
        const text = String(body.text || "").trim();
        const threadId = body.threadId || bridge.selectedThreadId;

        if (!threadId) {
          sendJson(res, 400, { error: "No selected thread." });
          return;
        }
        if (!text) {
          sendJson(res, 400, { error: "Prompt cannot be empty." });
          return;
        }

        const result = await bridge.sendMessage(threadId, text);
        await bridge.selectThread(threadId);
        sendJson(res, 200, { ok: true, turn: result.turn });
        return;
      }

      if (url.pathname === "/api/request/respond" && req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body.requestId || body.result === undefined) {
          sendJson(res, 400, { error: "Missing requestId or result." });
          return;
        }
        await bridge.respondToServerRequest(body.requestId, body.result);
        sendJson(res, 200, { ok: true });
        return;
      }

      const requestedPath =
        url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
      const filePath = path.join(STATIC_DIR, requestedPath);

      if (!filePath.startsWith(STATIC_DIR)) {
        sendJson(res, 403, { error: "Forbidden." });
        return;
      }

      if (!(await fileExists(filePath))) {
        sendJson(res, 404, { error: "Not found." });
        return;
      }

      renderStaticFile(filePath, res);
    } catch (error) {
      sendJson(res, 500, {
        error: error.message || "Unexpected server error.",
      });
    }
  });

  const browserWss = new WebSocket.Server({ noServer: true });
  browserWss.on("connection", (socket) => bridge.addBrowserSocket(socket));

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    browserWss.handleUpgrade(req, socket, head, (client) => {
      browserWss.emit("connection", client, req);
    });
  });

  server.listen(PORT, HOST, () => {
    log("bridge", "CodVex mobile bridge is ready", {
      url: `http://${HOST}:${PORT}`,
      threadCwd: DEFAULT_THREAD_CWD,
    });
  });

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

