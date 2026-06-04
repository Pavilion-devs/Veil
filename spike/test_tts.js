// TTS fix attempt — Supertonic returned empty buffer; try both stream modes.
import { loadModel, textToSpeech, TTS_EN_SUPERTONIC_Q8_0 } from "@qvac/sdk";
import { writeFileSync } from "node:fs";
process.on("unhandledRejection", () => {});
process.on("uncaughtException", (e) => console.log(`uncaught: ${e?.message?.slice(0, 80)}`));

const now = () => Date.now();
const text = "Sending fifty U S D T to Alex. Please confirm.";
const id = await loadModel({
  modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelType: "tts",
  modelConfig: { ttsEngine: "supertonic", language: "en" },
});
console.log("tts loaded.");

// --- A: explicit stream:false, await buffer ---
let bufA = [];
try {
  const t = now();
  const r = textToSpeech({ modelId: id, text, stream: false });
  bufA = (await r.buffer) ?? [];
  console.log(`A) stream:false -> buffer ${bufA.length} samples (${now() - t}ms)  keys=${Object.keys(r)}`);
} catch (e) { console.log(`A) ERROR ${e.message?.split("\n")[0]}`); }

// --- B: stream:true, collect bufferStream ---
let bufB = [];
try {
  const t = now();
  const r = textToSpeech({ modelId: id, text, stream: true });
  for await (const chunk of r.bufferStream) {
    if (Array.isArray(chunk)) bufB.push(...chunk);
    else if (ArrayBuffer.isView(chunk)) bufB.push(...chunk);
    else bufB.push(chunk);
  }
  try { await r.done; } catch {}
  console.log(`B) stream:true -> collected ${bufB.length} samples (${now() - t}ms)`);
} catch (e) { console.log(`B) ERROR ${e.message?.split("\n")[0]}`); }

// --- write whichever produced audio ---
const data = bufA.length ? bufA : bufB;
if (data.length) {
  const sr = 24000;
  const isFloat = Math.max(...data.slice(0, 200).map(Math.abs)) <= 1.5;
  const pcm = Int16Array.from(data, (v) => {
    const x = isFloat ? v * 32767 : v;
    return Math.max(-32768, Math.min(32767, Math.round(x)));
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.byteLength, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.byteLength, 40);
  const out = "/Users/olathepavilion/Documents/qvac/spike/tts_out.wav";
  writeFileSync(out, Buffer.concat([h, Buffer.from(pcm.buffer)]));
  console.log(`wrote ${out}  (~${(data.length / sr).toFixed(2)}s @${sr}Hz, ${isFloat ? "float" : "int16"} src)`);
} else {
  console.log("NO AUDIO from either mode — needs a voice param or different call shape.");
}
process.exit(0);
