import * as sdk from "@qvac/sdk";
for (const name of [
  "QWEN3_4B_INST_Q4_K_M",
  "WHISPER_EN_TINY_Q8_0",
  "PARAKEET_CTC_0_6B_Q8_0",
  "TTS_EN_SUPERTONIC_Q8_0",
  "OCR_0_6B_MULTIMODAL_Q4_K_M",
  "OCR_CRAFT_DETECTOR",
  "OCR_LATIN_RECOGNIZER",
  "MEDGEMMA_4B_IT_Q4_1",
  "VAD_SILERO_5_1_2",
]) {
  const v = sdk[name];
  console.log(`\n### ${name}  (type=${typeof v})`);
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1)?.slice(0, 900));
}
// Also dump MODEL_TYPES / ModelType so we know valid modelType strings.
console.log("\n### MODEL_TYPES ###");
console.log(JSON.stringify(sdk.MODEL_TYPES ?? sdk.ModelType ?? null));
