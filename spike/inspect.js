// Inspect the real @qvac/sdk surface: functions + model constants.
import * as sdk from "@qvac/sdk";

const keys = Object.keys(sdk).sort();
const fns = keys.filter((k) => typeof sdk[k] === "function");
const consts = keys.filter((k) => typeof sdk[k] !== "function");

console.log("=== FUNCTIONS (" + fns.length + ") ===");
console.log(fns.join(", "));

console.log("\n=== NON-FUNCTION EXPORTS (" + consts.length + ") ===");
console.log(consts.join(", "));

// Group model-ish constants by capability so we pick real names.
const groups = {
  QWEN3_LLM: /^QWEN3_(?!.*VL).*INST/,
  QWEN3_VL: /QWEN3VL|QWEN3_.*MULTIMODAL/,
  MMPROJ: /^MMPROJ/,
  OCR: /OCR/,
  PARAKEET: /PARAKEET/,
  WHISPER: /WHISPER/,
  VAD: /VAD/,
  TTS: /TTS|SUPERTONIC|CHATTERBOX/,
  EMBED: /GTE|EMBED|BGE/,
  MED: /MED/,
};
console.log("\n=== MODEL CONSTANTS BY CAPABILITY ===");
for (const [label, re] of Object.entries(groups)) {
  const hits = consts.filter((k) => re.test(k));
  if (hits.length) console.log(`\n[${label}] (${hits.length})\n  ` + hits.join("\n  "));
}

// Peek at the shape of one constant so we know if it's a string URL or an object.
const sample = consts.find((k) => /QWEN3.*INST/.test(k)) || consts[0];
if (sample) {
  console.log(`\n=== SAMPLE CONSTANT: ${sample} ===`);
  console.log(JSON.stringify(sdk[sample], null, 2)?.slice(0, 600));
}
