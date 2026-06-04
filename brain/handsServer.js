// handsServer.js — reference "eyes & hands" server: serves a MockHands fixture
// over the Unix socket so the brain can run OVER THE WIRE today, before any
// Swift exists. It is also the executable spec for the teammate's Swift app —
// the Swift BrainClient must serve exactly these methods with these shapes
// (see PROTOCOL.md). Uses NO QVAC, so it runs as its own process alongside the
// brain without touching the single-worker lock.
//
//   node handsServer.js                     # listens on /tmp/veil-hands.sock
//   node handsServer.js --socket /tmp/x.sock
//
// Then, in a second terminal:
//   node runTurn.js --socket /tmp/veil-hands.sock "create a new note"
import { MockHands } from "./mockHands.js";
import { serveHands } from "./ipc.js";

const DEFAULT_SOCK = "/tmp/veil-hands.sock";

function parseArgs(argv) {
  const opts = { socket: DEFAULT_SOCK };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--socket") opts.socket = argv[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hands = new MockHands();
  const log = (o) => console.log(`[hands] ${o.msg ?? JSON.stringify(o)}`);
  await serveHands({ hands, socketPath: opts.socket, log });
  console.log(`[hands] reference Notes fixture serving on ${opts.socket} — Ctrl-C to stop`);
  // Stay alive until killed.
}

main();
