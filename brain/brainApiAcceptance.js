// brainApiAcceptance.js — Brain API (PLAN §3.3) over a real Unix socket, in one
// process (one QVAC worker). Sets up the app side (listener + MockHands hands
// server) and the brain side (connector + QVAC + runTurn/cancel handlers + event
// streaming), then drives turns FROM THE APP — the real push-to-talk direction —
// and asserts the transcript/step/speak/done event stream and cancel work.
//
//   node brainApiAcceptance.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listenPeer, connectPeer, serveHandsOnPeer, handsFromPeer } from "./ipc.js";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { attachBrain } from "./brainHandlers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const SOCK = "/tmp/veil-brainapi.sock";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function main() {
  const hands = new MockHands(); // lives on the app side, behind the socket

  // --- app side: listen, serve hands, capture the brain peer once it connects ---
  let appSidePeer = null;
  let resolveConn;
  const gotConn = new Promise((r) => (resolveConn = r));
  const server = await listenPeer({
    socketPath: SOCK,
    onConnection: (peer) => {
      serveHandsOnPeer(peer, hands);
      appSidePeer = peer;
      resolveConn();
    },
  });

  // --- brain side: connect, hold QVAC, serve runTurn/cancel, stream events ---
  const brainPeer = await connectPeer({ socketPath: SOCK });
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();
  const brainHands = handsFromPeer(brainPeer);
  attachBrain(brainPeer, { qvac, hands: brainHands, logDir: LOG_DIR, turnBase: 80 });

  await gotConn; // app side has the brain peer

  try {
    // ---- Test A: app calls runTurn; brain streams transcript/step/speak/done ----
    {
      hands.reset();
      const before = hands.notes.length;
      const events = [];
      const collect = (ev) => (d) => events.push([ev, d]);
      appSidePeer.on("transcript", collect("transcript"));
      appSidePeer.on("step", collect("step"));
      appSidePeer.on("speak", collect("speak"));
      appSidePeer.on("done", collect("done"));

      const res = await appSidePeer.request("runTurn", { command: "create a new note", speak: false });
      for (const [ev, d] of events) {
        if (ev === "transcript") console.log(`   📝 "${d.text}"`);
        else if (ev === "step") console.log(`   ▸ step ${d.i}: ${d.action?.action}${d.overlay ? ` @(${Math.round(d.overlay.x)},${Math.round(d.overlay.y)})` : ""}`);
        else if (ev === "speak") console.log(`   🔊 "${d.text}"`);
        else if (ev === "done") console.log(`   ✅ ${d.status} — "${d.finalText}"`);
      }
      const has = (ev) => events.some(([e]) => e === ev);
      const stepWithOverlay = events.some(([e, d]) => e === "step" && d.overlay && d.action?.action === "click");
      const created = hands.notes.length === before + 1;
      record(
        "A. app→runTurn streams transcript + step(+overlay) + done; server fixture changed",
        res.status === "done" && has("transcript") && stepWithOverlay && has("done") && created,
        `events=[${events.map((e) => e[0]).join(",")}] result=${JSON.stringify(res)} created=${created}`,
      );
    }

    // ---- Test B: cancel aborts an in-flight turn ----
    {
      hands.reset();
      const cancelPeer = appSidePeer;
      let cancelled = false;
      // Fire cancel as soon as the first step streams in.
      const onStep = async () => {
        if (cancelled) return;
        cancelled = true;
        await cancelPeer.request("cancel", {});
      };
      cancelPeer.on("step", onStep);
      const res = await cancelPeer.request("runTurn", { command: "search for milk and then open the file menu", speak: false });
      console.log(`   result=${JSON.stringify(res)}`);
      record(
        "B. cancel aborts the in-flight turn (status=cancelled, stopped early)",
        res.status === "cancelled" && res.steps < 8,
        `status=${res.status} steps=${res.steps}`,
      );
    }
  } finally {
    brainPeer.close();
    server.close();
    await qvac.shutdown();
    try {
      if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} Brain API tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
