// ipc.js — the brain <-> eyes&hands transport (PLAN §3.4).
//
// Unix domain socket, newline-delimited JSON. Three message shapes:
//   request   {id, method, params}    -> response {id, result} | {id, error}
//   event     {event, data}           (no id, fire-and-forget)
//
// The connection is BIDIRECTIONAL (RpcPeer): each end can issue requests, serve
// requests, and emit/receive events — because both API directions share one
// socket:
//   - Hands API (§3.2): the BRAIN calls, the Swift app serves.
//   - Brain API (§3.3): the Swift app calls runTurn/cancel, the BRAIN serves and
//     streams back transcript/step/speak/done events.
import net from "node:net";
import fs from "node:fs";

// Split a byte stream into complete JSON objects on newline boundaries.
export function makeLineDecoder(onMessage) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip malformed frames rather than wedge the stream
      }
      onMessage(msg);
    }
  };
}

const encode = (obj) => JSON.stringify(obj) + "\n";

// ---- Bidirectional JSON-RPC-ish peer over one socket ----
export class RpcPeer {
  constructor(sock, { log = () => {}, requestTimeoutMs = 20000 } = {}) {
    this.sock = sock;
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.handlers = new Map(); // method -> async fn(params)
    this.listeners = new Map(); // event -> Set<fn>
    this._closed = false;
    sock.on("data", makeLineDecoder((m) => this._onMessage(m)));
    sock.on("close", () => this._onClose());
    sock.on("error", (e) => this.log({ phase: "ipc", msg: "socket error", err: String(e?.message ?? e) }));
  }

  handle(method, fn) {
    this.handlers.set(method, fn);
    return this;
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }

  emit(event, data = {}) {
    if (!this._closed) this.sock.write(encode({ event, data }));
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(new Error("peer closed"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(encode({ id, method, params }));
    });
  }

  async _onMessage(msg) {
    // Incoming request -> dispatch a handler, respond.
    if (msg.method != null && msg.id != null) {
      const fn = this.handlers.get(msg.method);
      if (!fn) {
        this.sock.write(encode({ id: msg.id, error: { message: `unknown method '${msg.method}'` } }));
        return;
      }
      try {
        const result = await fn(msg.params ?? {});
        this.sock.write(encode({ id: msg.id, result: result ?? null }));
      } catch (e) {
        this.sock.write(encode({ id: msg.id, error: { message: String(e?.message ?? e) } }));
      }
      return;
    }
    // Response to one of our requests.
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? String(msg.error)));
      else resolve(msg.result);
      return;
    }
    // Event.
    if (msg.event != null) {
      for (const fn of this.listeners.get(msg.event) ?? []) {
        try {
          fn(msg.data);
        } catch {
          /* a listener throwing must not wedge the stream */
        }
      }
    }
  }

  _onClose() {
    this._closed = true;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("peer closed"));
    }
    this.pending.clear();
  }

  close() {
    if (!this._closed) this.sock.end();
  }
}

export function connectPeer({ socketPath, log } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    sock.once("connect", () => resolve(new RpcPeer(sock, { log })));
    sock.once("error", reject);
  });
}

export function listenPeer({ socketPath, onConnection, log = () => {} }) {
  try {
    if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); // clear stale socket
  } catch {
    /* ignore */
  }
  const server = net.createServer((sock) => onConnection(new RpcPeer(sock, { log })));
  return new Promise((resolve) => server.listen(socketPath, () => resolve(server)));
}

// ---- Hands API glue (§3.2) ----
export const HANDS_METHODS = [
  "captureScreen",
  "getAXTree",
  "clickElement",
  "type",
  "key",
  "scroll",
  "openApp",
  "showOverlay",
  "playAudio",
];

// Wrap a connected peer as a hands object the orchestrator can drive.
export function handsFromPeer(peer) {
  const o = {};
  for (const m of HANDS_METHODS) o[m] = (params = {}) => peer.request(m, params);
  return o;
}

// Register a hands implementation (e.g. MockHands, or the Swift app) as request
// handlers on a peer.
export function serveHandsOnPeer(peer, hands) {
  for (const m of HANDS_METHODS) {
    peer.handle(m, (params) => {
      const fn = hands[m];
      if (typeof fn !== "function") throw new Error(`unknown hands method '${m}'`);
      return fn.call(hands, params ?? {});
    });
  }
  return peer;
}

// ---- Back-compat convenience wrappers (built on RpcPeer) ----
export class HandsClient {
  constructor({ socketPath, log } = {}) {
    this.socketPath = socketPath;
    this.log = log;
    this.peer = null;
  }
  async connect() {
    this.peer = await connectPeer({ socketPath: this.socketPath, log: this.log });
    return this;
  }
  request(method, params) {
    return this.peer.request(method, params);
  }
  close() {
    this.peer?.close();
  }
}
for (const m of HANDS_METHODS) {
  HandsClient.prototype[m] = function (params = {}) {
    return this.peer.request(m, params);
  };
}

export async function serveHands({ hands, socketPath, log = () => {} }) {
  const server = await listenPeer({
    socketPath,
    log,
    onConnection: (peer) => {
      serveHandsOnPeer(peer, hands);
      log({ phase: "ipc", msg: "brain connected" });
    },
  });
  log({ phase: "ipc", msg: "hands server listening", socketPath });
  return server;
}
