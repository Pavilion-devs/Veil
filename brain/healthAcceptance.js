// healthAcceptance.js — the hero "health" skill (PLAN §7), end to end, all
// on-device:
//   A. skill direct:   doctr OCR a lab image → MedPsy reasoning → flags abnormals.
//   B. loop integration: a lab doc is "open in Preview" → the planner emits
//      query_health → OCR → MedPsy → speak → done.
//
//   node healthAcceptance.js
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { TurnLogger } from "./logging.js";
import { runTurn, describeAction } from "./orchestrator.js";
import { analyzeLabs } from "./skills/health.js";
import { ensureLabsPng } from "./fixtures/make-labs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

// MedPsy should connect these abnormal values to recognizable concepts.
const CONCEPT_HITS = [
  /a1c|diabet|glucose|blood sugar/i,
  /ldl|cholesterol|lipid|cardiov|heart/i,
  /egfr|kidney|renal|ckd/i,
  /alt|liver|hepat/i,
];

async function main() {
  const labsPng = ensureLabsPng(); // render fixture if missing
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();

  try {
    // ---- A: skill direct (OCR → MedPsy) ----
    {
      const r = await analyzeLabs(qvac, { imagePath: labsPng, log: () => {} });
      console.log(`   flagged lines (${r.flagged.length}):`);
      r.flagged.forEach((l) => console.log(`     • ${l}`));
      console.log(`   MedPsy analysis:\n      ${r.analysis.replace(/\n/g, "\n      ")}`);
      const conceptsHit = CONCEPT_HITS.filter((re) => re.test(r.analysis)).length;
      const ocrGotValues = ["7.8", "152", "165", "58", "64"].filter((v) => r.reportText.includes(v)).length;
      record(
        "A. OCR → MedPsy flags the abnormal panel (diabetes / lipids / kidney / liver)",
        ocrGotValues >= 4 && r.flagged.length >= 5 && conceptsHit >= 3,
        `ocrValues=${ocrGotValues}/5 flaggedLines=${r.flagged.length} conceptsHit=${conceptsHit}/4`,
      );
    }

    // ---- B: loop integration (planner → query_health → speak → done) ----
    {
      const hands = new MockHands();
      hands.showDocument(labsPng, "Lab Results"); // a lab PDF open in Preview
      const logger = new TurnLogger({ turn: 60, dir: LOG_DIR });
      const r = await runTurn({
        qvac,
        hands,
        logger,
        command: "read my lab results and flag anything concerning",
        speak: false,
      });
      console.log(`   transcript: "${r.transcript}"`);
      for (const s of r.steps) console.log(`     [${s.i}] ${describeAction(s.action)} -> ${s.outcome}`);
      console.log(`   status=${r.status}  spoke="${(r.finalText || "").slice(0, 80)}…"`);
      const didHealth = r.steps.some((s) => s.outcome === "health");
      const flagged = r.health?.flagged?.length ?? 0;
      const conceptsHit = r.health ? CONCEPT_HITS.filter((re) => re.test(r.health.analysis)).length : 0;
      record(
        "B. loop: lab doc open → query_health → OCR → MedPsy → spoke findings → done",
        didHealth && flagged >= 5 && conceptsHit >= 3 && r.status === "done",
        `query_health=${didHealth} flagged=${flagged} conceptsHit=${conceptsHit}/4 status=${r.status}`,
      );
    }
  } finally {
    await qvac.shutdown();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} health tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
