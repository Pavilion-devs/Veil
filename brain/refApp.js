// refApp.js — reference "eyes & hands" app: the full executable spec for the
// Swift side. It LISTENS on the socket, serves the Hands API (backed by the
// MockHands Notes fixture), and on each stdin line (simulating push-to-talk)
// calls runTurn on the brain and prints the streamed transcript/step/speak/done
// events. Uses NO QVAC.
//
//   node refApp.js                 # terminal 1: listens on /tmp/veil-hands.sock
//   node brainMain.js              # terminal 2: connects, holds the QVAC worker
//   > create a new note            # type into terminal 1; watch events stream
import fs from "node:fs";
import readline from "node:readline";
import { listenPeer, serveHandsOnPeer } from "./ipc.js";
import { MockHands } from "./mockHands.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stream a 16 kHz mono s16le WAV to the brain as mic frames (push-to-talk),
// driven by the brain's `listening` handshake. For demoing real recordings.
async function streamWav(peer, wavPath) {
  const pcm = fs.readFileSync(wavPath).subarray(44); // strip WAV header
  await new Promise((resolve) => {
    const onListening = async () => {
      for (let i = 0; i < pcm.length; i += 3200) {
        peer.emit("audio", { pcm: Buffer.from(pcm.subarray(i, Math.min(i + 3200, pcm.length))).toString("base64") });
        await sleep(4);
      }
      peer.emit("audioEnd");
      resolve();
    };
    peer.on("listening", onListening);
  });
}

const DEFAULT_SOCK = "/tmp/veil-hands.sock";

function parseArgs(argv) {
  const opts = { socket: DEFAULT_SOCK };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--socket") opts.socket = argv[++i];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const hands = new MockHands();
  let brain = null;

  await listenPeer({
    socketPath: opts.socket,
    onConnection: (peer) => {
      brain = peer;
      serveHandsOnPeer(peer, hands); // app serves the Hands API to the brain
      // Render the brain's streamed turn events (what the Swift UI would draw).
      peer.on("transcript", (d) => console.log(`  📝 heard: "${d.text}"`));
      peer.on("step", (d) => {
        const at = d.overlay ? ` @(${Math.round(d.overlay.x)},${Math.round(d.overlay.y)})` : "";
        console.log(`  ▸ step ${d.i}: ${d.overlay?.label ?? d.action?.action}${at}`);
      });
      peer.on("speak", (d) => console.log(`  🔊 "${d.text}"`));
      peer.on("done", (d) => console.log(`  ✅ ${d.status} — "${d.finalText}"`));
      peer.sock.on("close", () => {
        brain = null;
        console.log("[app] brain disconnected");
      });
      console.log("[app] brain connected. Type a command (push-to-talk), Ctrl-C to quit.");
    },
  });

  console.log(`[app] reference Notes fixture listening on ${opts.socket}`);
  console.log("[app] now start the brain:  node brainMain.js");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.on("close", () => {
    console.log("[app] input closed, exiting");
    process.exit(0);
  });
  rl.prompt();
  rl.on("line", async (line) => {
    const cmd = line.trim();
    if (!cmd) return rl.prompt();
    if (!brain) {
      console.log("[app] (brain not connected yet)");
      return rl.prompt();
    }
    hands.reset(); // fresh app state per utterance
    try {
      if (cmd.startsWith(":wav ")) {
        // Stream a 16k mono s16le wav as if it were the mic (real audio path).
        const wavPath = cmd.slice(5).trim();
        const pending = brain.request("runTurn", { audio: true, speak: false });
        await streamWav(brain, wavPath);
        const res = await pending;
        console.log(`  → ${JSON.stringify(res)}`);
      } else {
        // Plain text = typed command (skips STT).
        const res = await brain.request("runTurn", { command: cmd, speak: false });
        console.log(`  → ${JSON.stringify(res)}`);
      }
    } catch (e) {
      console.log(`  → error: ${e.message}`);
    }
    rl.prompt();
  });
}

main();
