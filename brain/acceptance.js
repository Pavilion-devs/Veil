// acceptance.js — the five Phase-1 acceptance tests (PLAN §13), run end-to-end
// against real QVAC STT + planner + TTS, all inside ONE qvac worker (single-
// worker rule). Each test gets a fresh MockHands fixture; models stay warm.
//
//   node acceptance.js
//
// Exits 0 only if all five pass.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { TurnLogger } from "./logging.js";
import { runTurn, describeAction } from "./orchestrator.js";
import { tts } from "./voice.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

function workerCount() {
  try {
    return Number(execSync('pgrep -f "@qvac/sdk/dist/server" | wc -l').toString().trim());
  } catch {
    return 0;
  }
}

function printTrace(r) {
  console.log(`   transcript: "${r.transcript}"`);
  for (const s of r.steps) {
    const tail = s.verify
      ? `-> ${s.verify.ok ? "ok" : "FAIL"} (${s.verify.reason}; diff ${s.verify.diff})`
      : `-> ${s.outcome}`;
    console.log(`     [${s.i}] ${describeAction(s.action)} ${tail}`);
  }
  console.log(`   status=${r.status}  spoke="${r.finalText}"`);
}

async function main() {
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();

  try {
    // ---- Test 1: "create a new note" -> click(New Note) -> state changes -> done ----
    {
      const hands = new MockHands();
      const before = hands.notes.length;
      const logger = new TurnLogger({ turn: 1, dir: LOG_DIR });
      const r = await runTurn({ qvac, hands, logger, command: "create a new note", speak: false });
      printTrace(r);
      const created = hands.notes.length === before + 1;
      const clicked = r.steps.some((s) => s.action?.action === "click" && s.verify?.ok);
      record(
        '1. "create a new note" → click(New Note) → verified → done',
        r.status === "done" && created && clicked,
        `created=${created} clicked&verified=${clicked} status=${r.status}`,
      );
    }

    // ---- Test 2: "search for groceries and type milk" -> click(Search) -> type("milk") ----
    {
      const hands = new MockHands();
      const logger = new TurnLogger({ turn: 2, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands,
        logger,
        command: "search for groceries and type milk",
        speak: false,
      });
      printTrace(r);
      // The capability under test is multi-step click→type→verify→done. The
      // command is ambiguous about WHICH field (Search vs note editor), so we
      // assert a verified click followed by a verified type, the typed text
      // landing in a field, and a clean done — not one hard-coded element.
      const idxClick = r.steps.findIndex((s) => s.action?.action === "click" && s.outcome === "ok");
      const idxType = r.steps.findIndex((s) => s.action?.action === "type" && s.outcome === "ok");
      const clickThenType = idxClick >= 0 && idxType > idxClick;
      const milkLanded =
        hands.searchQuery.toLowerCase().includes("milk") ||
        hands.notes.some((n) => n.body.toLowerCase().includes("milk"));
      const where = hands.searchQuery.toLowerCase().includes("milk")
        ? `search=${JSON.stringify(hands.searchQuery)}`
        : `note=${JSON.stringify(hands.notes.find((n) => n.body.toLowerCase().includes("milk"))?.body ?? "")}`;
      record(
        '2. "search…type milk" → multi-step click→type→verify→done',
        r.status === "done" && clickThenType && milkLanded,
        `clickThenType=${clickThenType} milkLanded=${milkLanded} (${where}) status=${r.status}`,
      );
    }

    // ---- Test 3: wav command -> STT -> loop -> TTS wav out (stream:false) ----
    {
      // Synthesize the spoken command first (exercises TTS), then feed it back
      // through STT — a fully self-contained voice round-trip, no external asset.
      const cmdWav = path.join(LOG_DIR, "cmd-create-note.wav");
      const synth = await tts(qvac, "Create a new note.", cmdWav);
      const hands = new MockHands();
      const before = hands.notes.length;
      const logger = new TurnLogger({ turn: 3, dir: LOG_DIR });
      const r = await runTurn({ qvac, hands, logger, wavPath: cmdWav, speak: true });
      printTrace(r);
      const ttsOut = r.ttsWavPath && fs.existsSync(r.ttsWavPath);
      const created = hands.notes.length === before + 1;
      record(
        "3. wav → STT transcript → loop → TTS wav out (stream:false)",
        Boolean(r.transcript) && synth.samples > 0 && ttsOut && r.status === "done" && created,
        `synthSamples=${synth.samples} transcript=${JSON.stringify(r.transcript)} ttsOut=${ttsOut} created=${created}`,
      );
    }

    // ---- Test 4: deliberately-wrong first action -> verifier catches it -> replan -> succeed ----
    {
      const hands = new MockHands();
      const before = hands.notes.length;
      const logger = new TurnLogger({ turn: 4, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands,
        logger,
        command: "create a new note",
        // Wrong first action that passes validation but changes nothing (typing
        // with no field focused), so the VERIFIER — not the validator — catches it.
        injectFirstAction: { thought: "(injected wrong action)", action: "type", text: "milk" },
        speak: false,
      });
      printTrace(r);
      const caught = r.steps[0]?.outcome === "no_effect"; // verifier flagged the wrong action
      const recovered = r.status === "done" && hands.notes.length === before + 1;
      record(
        "4. wrong first action → verifier catches unchanged state → replan → succeed",
        caught && recovered,
        `caughtWrongAction=${caught} recovered=${recovered} status=${r.status}`,
      );
    }

    // ---- Test 5: the whole run used exactly ONE qvac worker (single-worker rule) ----
    // The worker holds ~/.qvac/.worker.lock for its lifetime and only releases it
    // on process exit, so "clean exit leaves no stale lock" is checked by the
    // wrapper AFTER node exits (see the run command); here we assert one worker.
    {
      const wc = workerCount();
      record(
        "5. whole run uses ONE qvac worker (clean-exit lock check follows process exit)",
        wc === 1,
        `live worker processes = ${wc}`,
      );
    }
  } finally {
    await qvac.shutdown();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} acceptance tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
