// TEST C — MedPsy (Tether's own Psy model) loaded by URL, reasoning over lab values.
// Validates: (1) custom non-registry GGUF loads in QVAC, (2) clinical reasoning quality.
import { loadModel, completion, unloadModel } from "@qvac/sdk";

process.on("unhandledRejection", (e) => console.log(`(ignored unhandledRejection: ${e?.message?.slice(0, 80)})`));
const now = () => Date.now();
const rss = () => (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

// registry://hf/<repo>/resolve/<ref>/<file>  (same scheme Whisper uses)
const SRC = "registry://hf/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf";
const FALLBACK = "https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf";

async function load(src) {
  return loadModel({
    modelSrc: src, modelType: "llm", modelConfig: { ctx_size: 4096 },
    onProgress: (p) => { const pct = Math.floor(p?.percentage ?? 0); if (pct % 20 === 0) process.stdout.write(` ${pct}%`); },
  });
}

console.log(`[${rss()}MB] loading MedPsy-4B by URL (downloads ~2.5GB)...`);
let t = now(), modelId;
try { modelId = await load(SRC); }
catch (e) { console.log(`\n  registry:// form failed (${e.code || e.message}); trying https...`); modelId = await load(FALLBACK); }
console.log(`\n[${rss()}MB] MedPsy loaded in ${((now() - t) / 1000).toFixed(1)}s. modelId=${modelId}`);

const labs = `Patient lab panel:
- Hemoglobin A1c: 7.8% (ref 4.0-5.6%)
- Fasting glucose: 152 mg/dL (ref 70-99)
- LDL cholesterol: 165 mg/dL (ref <100)
- eGFR: 58 mL/min/1.73m2 (ref >90)
- ALT: 64 U/L (ref 7-56)`;
const history = [
  { role: "system", content: "You are a careful medical-education assistant (not a diagnosis). Given lab results, flag which values are abnormal and explain in plain language what they may indicate and what to discuss with a clinician. Be concise." },
  { role: "user", content: labs + "\n\nWhich values are concerning, and what might they suggest together?" },
];

t = now();
const r = completion({ modelId, history, stream: false });
const final = await (r.final ?? r);
const ms = now() - t;
const think = final.thinkingText ?? "";
const answer = final.contentText ?? final.text ?? "";
const stats = final.stats ?? {};
console.log(`\n--- MedPsy reasoning (${ms}ms) ---`);
if (think) console.log(`[thinking ${think.length} chars, first 280]\n${think.slice(0, 280)}...\n`);
console.log(`[answer]\n${answer}`);
console.log(`\n[stats] ${JSON.stringify(stats)}`);
console.log(`[${rss()}MB] done.`);
try { await unloadModel(modelId); } catch {}
process.exit(0);
