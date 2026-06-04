// ipcAcceptance.js — prove the agent loop runs OVER A REAL UNIX SOCKET, not
// just in-process. Spins up serveHands(MockHands) on a socket, connects a
// HandsClient, and runs full turns through it. Asserts the SERVER-side fixture
// state changed via socket round-trips — i.e. the wire protocol (PLAN §3.4)
// works end-to-end and is a faithful drop-in for the in-process mock.
//
// This is the bridge that makes Phase 2 tractable: when the Swift app implements
// the same protocol (see PROTOCOL.md), it drops straight in here.
//
//   node ipcAcceptance.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { HandsClient, serveHands } from "./ipc.js";
import { TurnLogger } from "./logging.js";
import { runTurn, describeAction } from "./orchestrator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const SOCK = "/tmp/veil-ipc-accept.sock";

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}
function printTrace(r) {
  console.log(`   transcript: "${r.transcript}"`);
  for (const s of r.steps) {
    const tail = s.verify ? `-> ${s.verify.ok ? "ok" : "FAIL"} (${s.verify.reason})` : `-> ${s.outcome}`;
    console.log(`     [${s.i}] ${describeAction(s.action)} ${tail}`);
  }
  console.log(`   status=${r.status}  spoke="${r.finalText}"`);
}

async function main() {
  // hands fixture lives behind the socket (stands in for the Swift app)
  const hands = new MockHands();
  const server = await serveHands({ hands, socketPath: SOCK, log: () => {} });
  const client = new HandsClient({ socketPath: SOCK });
  await client.connect();

  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();

  try {
    // ---- Test A: raw protocol round-trip (no model) ----
    {
      const tree = await client.getAXTree();
      const okTree = Array.isArray(tree) && tree.some((e) => e.label === "New Note");
      const cap = await client.captureScreen();
      const okCap = cap && cap.width === 1440;
      record(
        "A. raw Hands API round-trips over the socket (getAXTree, captureScreen)",
        okTree && okCap,
        `treeLen=${tree.length} screen=${cap.width}x${cap.height}`,
      );
    }

    // ---- Test B: full agent loop over the socket mutates server-side state ----
    {
      hands.reset(); // fresh app state for this turn (focus cleared)
      const before = hands.notes.length; // server-side fixture
      const logger = new TurnLogger({ turn: 90, dir: LOG_DIR });
      const r = await runTurn({ qvac, hands: client, logger, command: "create a new note", speak: false });
      printTrace(r);
      const created = hands.notes.length === before + 1; // changed VIA the socket
      record(
        "B. full loop over socket: click(New Note) → server fixture gains a note → done",
        r.status === "done" && created,
        `serverNotes ${before}→${hands.notes.length} status=${r.status}`,
      );
    }

    // ---- Test C: multi-step over the socket (click → type → done) ----
    // "create a note and type X" is a deterministic 2-step: New Note auto-focuses
    // the editor, so the type lands without field-selection ambiguity. This tests
    // multi-step TRANSPORT parity, not the model's field-guessing.
    {
      hands.reset();
      const logger = new TurnLogger({ turn: 91, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands: client,
        logger,
        command: "create a new note and type hello in it",
        speak: false,
      });
      printTrace(r);
      const idxClick = r.steps.findIndex((s) => s.action?.action === "click" && s.outcome === "ok");
      const idxType = r.steps.findIndex((s) => s.action?.action === "type" && s.outcome === "ok");
      const landed = hands.notes.some((n) => n.body.toLowerCase().includes("hello"));
      record(
        "C. multi-step over socket: click(New Note) → type → verify → done",
        r.status === "done" && idxClick >= 0 && idxType > idxClick && landed,
        `clickThenType=${idxClick >= 0 && idxType > idxClick} landed=${landed} status=${r.status}`,
      );
    }
  } finally {
    client.close();
    server.close();
    await qvac.shutdown();
    try {
      if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} IPC tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
