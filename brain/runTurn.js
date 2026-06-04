// runTurn.js — CLI harness for one turn against the mock hands.
//
//   node runTurn.js "create a new note"
//   node runTurn.js --wav ./logs/cmd.wav --turn 3
//   node runTurn.js --inject-wrong "create a new note"   # force a wrong 1st action
//   node runTurn.js --no-speak "search for groceries and type milk"
//
// Boots ONE qvac worker, runs the loop, prints the step trace + spoken result,
// writes logs/turn-<n>.jsonl, then shuts down cleanly (no stale lock).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { HandsClient } from "./ipc.js";
import { TurnLogger } from "./logging.js";
import { runTurn, describeAction } from "./orchestrator.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

function parseArgs(argv) {
  const opts = { command: "", wav: null, turn: 1, maxSteps: 8, speak: true, injectWrong: false, socket: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wav") opts.wav = argv[++i];
    else if (a === "--turn") opts.turn = Number(argv[++i]);
    else if (a === "--max-steps") opts.maxSteps = Number(argv[++i]);
    else if (a === "--no-speak") opts.speak = false;
    else if (a === "--inject-wrong") opts.injectWrong = true;
    else if (a === "--socket") opts.socket = argv[++i];
    else opts.command = opts.command ? `${opts.command} ${a}` : a;
  }
  return opts;
}

export function printTrace(result, logger) {
  console.log(`\n=== Turn ${logger.turn} ===`);
  console.log(`transcript: "${result.transcript}"`);
  for (const s of result.steps) {
    const tail = s.verify
      ? `  ->  ${s.verify.ok ? "ok" : "FAIL"}  (${s.verify.reason}; AX-diff ${s.verify.diff})`
      : `  ->  ${s.outcome}`;
    console.log(`  [${s.i}] ${describeAction(s.action)}${tail}`);
  }
  console.log(`status: ${result.status}`);
  console.log(`spoke:  "${result.finalText}"`);
  console.log(`log:    ${logger.path()}`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.command && !opts.wav) {
    console.error('usage: node runTurn.js "<command>" | --wav <file>  [--turn n] [--inject-wrong] [--no-speak]');
    process.exit(2);
  }

  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();
  // Real socket hands (the Swift app / reference handsServer) when --socket is
  // given; otherwise the in-process mock. The orchestrator is identical either way.
  let hands;
  if (opts.socket) {
    hands = new HandsClient({ socketPath: opts.socket });
    await hands.connect();
    console.log(`[runTurn] connected to hands at ${opts.socket}`);
  } else {
    hands = new MockHands();
  }
  const logger = new TurnLogger({ turn: opts.turn, dir: LOG_DIR });

  // Inject a wrong first action that PASSES validation but produces no screen
  // change (typing with nothing focused), so the *verifier* catches it.
  const injectFirstAction = opts.injectWrong
    ? { thought: "(injected wrong action for the self-correction test)", action: "type", text: "milk" }
    : null;

  try {
    const result = await runTurn({
      qvac,
      hands,
      logger,
      command: opts.command || undefined,
      wavPath: opts.wav || undefined,
      maxSteps: opts.maxSteps,
      injectFirstAction,
      speak: opts.speak,
    });
    printTrace(result, logger);
  } finally {
    if (opts.socket) hands.close();
    await qvac.shutdown();
  }
  process.exit(0);
}

main();
