// walletAcceptance.js — the hero "money" skill (PLAN §7, §10), DEVNET only.
// The star is the MANDATORY voice-confirm gate: nothing is ever sent without an
// explicit spoken "confirm". Tests the gate from every angle:
//   A. parseConfirmation classifies yes / no / ambiguous.
//   B. skill, confirmed  → submits; form filled; recipient resolved.
//   C. skill, DECLINED   → does NOT submit (no funds move).   ← safety-critical
//   D. skill, no confirm capability → FAILS CLOSED (no send).
//   E. loop, confirmed   → planner wallet_send → gate → submit → done.
//   F. loop, declined    → wallet_send → gate says no → NOT sent → done.
//
//   node walletAcceptance.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QvacManager } from "./qvac.js";
import { MockWallet } from "./mockWallet.js";
import { TurnLogger } from "./logging.js";
import { runTurn, describeAction } from "./orchestrator.js";
import { walletSend, parseConfirmation, resolveRecipient } from "./skills/wallet.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

async function main() {
  // ---- A: confirmation parsing (no model needed) ----
  {
    const ok = parseConfirmation("yes, confirm") === true && parseConfirmation("confirm it") === true;
    const no = parseConfirmation("no, cancel") === false && parseConfirmation("stop") === false;
    const amb = parseConfirmation("maybe later") === null && parseConfirmation("") === null;
    record("A. parseConfirmation: yes→true, no→false, ambiguous→null", ok && no && amb, `ok=${ok} no=${no} ambiguous=${amb}`);
  }

  // ---- B: skill, confirmed → submits ----
  {
    const w = new MockWallet();
    const phrases = [];
    const r = await walletSend({
      hands: w,
      amount: "0.5",
      asset: "SOL",
      to: "Alex",
      confirm: async (p) => {
        phrases.push(p);
        return true;
      },
    });
    const filled = w.recipient === resolveRecipient("Alex").address && w.amount === "0.5";
    const phraseOk = /0\.5 SOL/.test(phrases[0] || "") && /devnet/.test(phrases[0] || "");
    record(
      "B. confirmed → submits; form filled; recipient resolved; phrase states amount+network",
      r.submitted && r.confirmed && filled && phraseOk && w.submitted,
      `submitted=${r.submitted} filled=${filled} tx=${JSON.stringify(w.lastTx)}`,
    );
  }

  // ---- C: skill, DECLINED → does NOT submit (safety-critical) ----
  {
    const w = new MockWallet();
    const r = await walletSend({ hands: w, amount: "2", asset: "SOL", to: "Alex", confirm: async () => false });
    record(
      "C. DECLINED at the gate → NOTHING is sent (no funds move)",
      r.submitted === false && r.confirmed === false && w.submitted === false && w.lastTx === null,
      `submitted=${r.submitted} walletSubmitted=${w.submitted} reason=${r.reason}`,
    );
  }

  // ---- D: skill, no confirm capability → fail closed ----
  {
    const w = new MockWallet();
    const r = await walletSend({ hands: w, amount: "1", asset: "SOL", to: "Alex", confirm: null });
    record(
      "D. no confirm capability → FAILS CLOSED (never auto-sends)",
      r.submitted === false && w.submitted === false,
      `submitted=${r.submitted} reason=${r.reason}`,
    );
  }

  // ---- loop integration (needs the planner) ----
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();
  try {
    // ---- E: loop, confirmed ----
    {
      const w = new MockWallet();
      const logger = new TurnLogger({ turn: 50, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands: w,
        logger,
        command: "send 0.5 SOL to Alex",
        speak: false,
        confirm: async () => true, // user says "confirm"
      });
      for (const s of r.steps) console.log(`     [${s.i}] ${describeAction(s.action)} -> ${s.outcome}`);
      const sent = r.wallet?.submitted && w.submitted && w.lastTx?.amount === "0.5";
      record(
        "E. loop: 'send 0.5 SOL to Alex' → wallet_send → confirm → submit → done",
        sent && r.status === "done",
        `walletSubmitted=${w.submitted} tx=${JSON.stringify(w.lastTx)} status=${r.status}`,
      );
    }

    // ---- F: loop, declined ----
    {
      const w = new MockWallet();
      const logger = new TurnLogger({ turn: 51, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands: w,
        logger,
        command: "send 1 SOL to Sam",
        speak: false,
        confirm: async () => false, // user says "cancel"
      });
      for (const s of r.steps) console.log(`     [${s.i}] ${describeAction(s.action)} -> ${s.outcome}`);
      record(
        "F. loop: user cancels at the gate → NOT sent → done",
        r.wallet?.submitted === false && w.submitted === false && r.status === "done",
        `walletSubmitted=${w.submitted} status=${r.status}`,
      );
    }
  } finally {
    await qvac.shutdown();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} wallet tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
