// p2pAcceptance.js — P2P tiered intelligence (PLAN §6), exercised on a SINGLE
// machine. Cross-machine offload needs the teammate's box; everything else —
// provider start, offline detection, local fallback, and the escalate-to-peer
// routing — is validated here:
//   A. startQVACProvider → online with a valid public key.
//   B. heartbeat to an offline peer → detected offline.
//   C. a delegated plan to an offline peer falls back to LOCAL → valid action.
//   D. a struggle routes the replan to the peer (delegate event) → recovers.
//
//   node p2pAcceptance.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startQVACProvider, stopQVACProvider, QWEN3_4B_INST_Q4_K_M } from "@qvac/sdk";
import { QvacManager } from "./qvac.js";
import { PeerLink, HEX64 } from "./p2p.js";
import { MockHands } from "./mockHands.js";
import { TurnLogger } from "./logging.js";
import { runTurn } from "./orchestrator.js";
import { perceive, renderScreen } from "./perception.js";
import { plan, SYSTEM_PROMPT } from "./planner.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const BOGUS_PEER = "deadbeef".repeat(8); // valid 64-hex format, no provider behind it

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function main() {
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();

  // Bogus peer + a cached small model as the "big" model so the fallback test
  // doesn't download GPT_OSS_20B. (Production: real key + QWEN3_8B/GPT_OSS_20B.)
  const peer = new PeerLink({
    qvac,
    providerPublicKey: BOGUS_PEER,
    bigModel: QWEN3_4B_INST_Q4_K_M,
    timeout: 6_000,
    healthCheckTimeout: 4_000,
    log: () => {},
  });

  try {
    // ---- A: the provider entrypoint the teammate runs ----
    {
      const res = await startQVACProvider({});
      const ok = res.success === true && HEX64.test(res.publicKey ?? "");
      record("A. startQVACProvider → online with a valid 64-hex public key", ok, `success=${res.success} key=${(res.publicKey || "").slice(0, 16)}…`);
      try {
        await stopQVACProvider();
      } catch {
        /* ignore */
      }
    }

    // ---- B: offline detection ----
    {
      const t0 = Date.now();
      const online = await peer.online(3_000);
      record("B. heartbeat to an offline peer → detected offline", online === false, `online=${online} (${Date.now() - t0}ms)`);
    }

    // ---- C: delegated plan falls back to local → valid action ----
    {
      const hands = new MockHands();
      const { elements } = await perceive(hands);
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${renderScreen(elements)}\n\nUser command: "create a new note"\n\nReply with the next action.` },
      ];
      const t0 = Date.now();
      const { action, valid } = await plan({ qvac, messages, elements, role: peer.role });
      record(
        "C. delegated plan to an offline peer falls back to LOCAL → valid action",
        valid === true && !!action?.action,
        `action=${action?.action} valid=${valid} (${Date.now() - t0}ms; fellBackToLocal)`,
      );
    }

    // ---- D: escalation routing end-to-end ----
    {
      const hands = new MockHands();
      const before = hands.notes.length;
      const logger = new TurnLogger({ turn: 40, dir: LOG_DIR });
      const events = [];
      const r = await runTurn({
        qvac,
        hands,
        logger,
        command: "create a new note",
        // A no-op first action forces a struggle → escalation to the peer.
        injectFirstAction: { thought: "(injected wrong action)", action: "type", text: "milk" },
        speak: false,
        peer,
        onEvent: (e) => events.push(e.event),
      });
      const delegated = events.includes("delegate");
      const created = hands.notes.length === before + 1;
      console.log(`   events=[${events.join(",")}] status=${r.status}`);
      record(
        "D. struggle → routing delegates the replan to the peer (event) → recovers (fallback) → done",
        delegated && created && r.status === "done",
        `delegateEvent=${delegated} noteCreated=${created} status=${r.status}`,
      );
    }
  } finally {
    try {
      await stopQVACProvider();
    } catch {
      /* ignore */
    }
    await qvac.shutdown();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} P2P tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  console.log("  ℹ️  cross-machine offload (big model on a peer) needs the teammate's box; run peerProvider.js there.");
  process.exit(passed === results.length ? 0 : 1);
}

main();
