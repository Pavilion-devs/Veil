// TEST B — OCR with bounding boxes on a REAL screenshot (our grounding fallback).
import { loadModel, ocr, unloadModel, OCR_LATIN_RECOGNIZER, OCR_CRAFT_DETECTOR } from "@qvac/sdk";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";

process.on("unhandledRejection", (e) => console.log(`(ignored unhandledRejection: ${e?.message?.slice(0, 80)})`));
process.on("uncaughtException", (e) => console.log(`(ignored uncaughtException: ${e?.message?.slice(0, 80)})`));
const now = () => Date.now();
const rss = () => (process.memoryUsage().rss / 1024 / 1024).toFixed(0);

// Capture the real screen (our actual use case). May be black if Screen Recording perm is missing.
let shot = "/Users/olathepavilion/Documents/qvac/spike/screen.png";
try {
  execSync(`/usr/sbin/screencapture -x ${shot}`, { timeout: 15000 });
  console.log(`screenshot: ${shot} (${(statSync(shot).size / 1024).toFixed(0)} KB)`);
} catch (e) {
  console.log(`screencapture failed: ${e.message}`);
  shot = null;
}
// Baseline image guaranteed to contain text.
const baseline = "/Users/olathepavilion/Documents/qvac/spike/node_modules/@qvac/classification-ggml/test/images/report_1.jpg";

console.log(`[${rss()}MB] loading OCR (CRAFT detector + Latin recognizer)...`);
let t = now();
const modelId = await loadModel({
  modelSrc: OCR_LATIN_RECOGNIZER,
  modelType: "ocr",
  modelConfig: { langList: ["en"], useGPU: true, detectorModelSrc: OCR_CRAFT_DETECTOR },
  onProgress: (p) => { if ((p?.percentage ?? 0) % 25 < 1) process.stdout.write(`.${Math.floor(p.percentage)}`); },
});
console.log(`\n[${rss()}MB] OCR loaded in ${((now() - t) / 1000).toFixed(1)}s`);

async function runOCR(label, img) {
  if (!img || !existsSync(img)) { console.log(`\n[${label}] SKIP (no image)`); return; }
  try {
    const t0 = now();
    const { blocks, stats } = ocr({ modelId, image: img });
    const out = await blocks;
    const ms = now() - t0;
    console.log(`\n[${label}] ${img.split("/").pop()} -> ${out.length} text blocks in ${ms}ms`);
    try { const s = await stats; if (s) console.log(`  stats: ${JSON.stringify(s)}`); } catch {}
    for (const b of out.slice(0, 18)) {
      console.log(`  "${b.text}"  bbox=${JSON.stringify(b.bbox)}  conf=${b.confidence?.toFixed?.(2)}`);
    }
    if (out.length > 18) console.log(`  ...(+${out.length - 18} more)`);
  } catch (e) { console.log(`\n[${label}] OCR FAILED: ${e.message?.split("\n")[0]}`); }
}

await runOCR("BASELINE", baseline);   // clean document image first
await runOCR("SCREENSHOT", shot);     // Retina screenshot (may hit the 512-dim edge case)

console.log(`\n[${rss()}MB] done.`);
try { await unloadModel(modelId); } catch {}
process.exit(0);
