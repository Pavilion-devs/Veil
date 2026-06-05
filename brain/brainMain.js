// brainMain.js — the real brain entrypoint (Brain API server side, PLAN §3.3).
//
// Topology: the Swift "eyes & hands" app is the persistent process and LISTENS
// on the socket; it launches the brain as a sidecar (PLAN §1). The brain
// CONNECTS, then over that one bidirectional peer it:
//   - serves  runTurn / cancel        (the app calls these on push-to-talk)
//   - calls   the Hands API           (getAXTree / clickElement / ...)
//   - emits   transcript/step/speak/done events back to the app
//
// Holds the single QVAC worker. Run the app/handsServer first, then:
//   node brainMain.js                       # connects to /tmp/veil-hands.sock
//   node brainMain.js --socket /tmp/x.sock
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPeer, handsFromPeer } from "./ipc.js";
import { QvacManager } from "./qvac.js";
import { attachBrain } from "./brainHandlers.js";
import { PeerLink } from "./p2p.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const DEFAULT_SOCK = "/tmp/veil-hands.sock";

function parseArgs(argv) {
  const opts = { socket: DEFAULT_SOCK };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--socket") opts.socket = argv[++i];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();

  // Clean QVAC shutdown on signals too, so a killed brain never orphans the
  // worker (the startup reap is the backstop; this is the graceful path).
  const shutdown = async () => {
    try {
      await qvac.shutdown();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const peer = await connectPeer({ socketPath: opts.socket });
  const hands = handsFromPeer(peer);

  // P2P (§6): if a peer key is configured, hard steps delegate to the big model
  // on the teammate's box. Pre-warm the DHT connection so the first call is fast.
  let peerLink = null;
  if (process.env.VEIL_PEER_KEY) {
    try {
      peerLink = new PeerLink({ qvac, providerPublicKey: process.env.VEIL_PEER_KEY, log: (o) => console.log(`[p2p] ${o.msg}`) });
      const { online } = await peerLink.prewarm();
      console.log(`[brain] P2P peer ${online ? "online" : "offline (will fall back to local)"}`);
    } catch (e) {
      console.log(`[brain] P2P disabled: ${e.message}`);
      peerLink = null;
    }
  }

  // Register the Brain API (runTurn/cancel + streaming mic + event streaming).
  attachBrain(peer, { qvac, hands, logDir: LOG_DIR, peerLink });
  console.log(`[brain] connected to hands at ${opts.socket}; ready for runTurn`);

  // When the app disconnects, shut the worker down cleanly (no stale lock).
  peer.sock.on("close", async () => {
    console.log("[brain] hands disconnected; shutting down");
    await qvac.shutdown();
    process.exit(0);
  });
}

main();
