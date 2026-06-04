// TEST D — Voice in/out, fully local: Whisper STT + Supertonic TTS.
import {
  loadModel, transcribe, textToSpeech, unloadModel,
  WHISPER_EN_TINY_Q8_0, TTS_EN_SUPERTONIC_Q8_0,
} from "@qvac/sdk";
import { writeFileSync } from "node:fs";

const now = () => Date.now();
const rss = () => (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
const JFK = "/Users/olathepavilion/Documents/qvac/spike/node_modules/@qvac/tts-ggml/test/reference-audio/jfk.wav";

// ---------- STT ----------
try {
  console.log(`[${rss()}MB] loading Whisper tiny.en ...`);
  let t = now();
  const sttId = await loadModel({ modelSrc: WHISPER_EN_TINY_Q8_0, modelType: "whisper" });
  console.log(`[${rss()}MB] whisper loaded ${((now() - t) / 1000).toFixed(1)}s`);
  t = now();
  const text = await transcribe({ modelId: sttId, audioChunk: JFK });
  console.log(`[STT] jfk.wav -> "${String(text).trim()}"  (${now() - t}ms)`);
  await unloadModel(sttId);
} catch (e) { console.log(`[STT] ERROR: ${e.stack || e.message}`); }

// ---------- TTS ----------
try {
  console.log(`\n[${rss()}MB] loading Supertonic TTS ...`);
  let t = now();
  const ttsId = await loadModel({
    modelSrc: TTS_EN_SUPERTONIC_Q8_0, modelType: "tts",
    modelConfig: { ttsEngine: "supertonic", language: "en" },
  });
  console.log(`[${rss()}MB] tts loaded ${((now() - t) / 1000).toFixed(1)}s`);
  const phrase = "Sending fifty U S D T to Alex. Please confirm.";
  t = now();
  const res = textToSpeech({ modelId: ttsId, text: phrase });
  console.log(`  textToSpeech result keys: ${Object.keys(res).join(", ")}`);
  const buffer = await res.buffer;
  const ms = now() - t;
  const n = buffer?.length ?? 0;
  console.log(`[TTS] "${phrase}" -> ${n} PCM samples in ${ms}ms (~${(n / 24000).toFixed(2)}s audio @24kHz?)`);
  console.log(`  first samples: ${JSON.stringify(buffer?.slice?.(0, 6))}`);
  // Write a 24kHz mono WAV so we have an audio artifact to listen to.
  if (n > 0) {
    const sr = 24000;
    const pcm = Int16Array.from(buffer, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))));
    const hdr = Buffer.alloc(44);
    hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.byteLength, 4); hdr.write("WAVE", 8);
    hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
    hdr.writeUInt32LE(sr, 24); hdr.writeUInt32LE(sr * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
    hdr.write("data", 36); hdr.writeUInt32LE(pcm.byteLength, 40);
    const out = "/Users/olathepavilion/Documents/qvac/spike/tts_out.wav";
    writeFileSync(out, Buffer.concat([hdr, Buffer.from(pcm.buffer)]));
    console.log(`  wrote ${out} (open it to hear the local voice)`);
  }
  await unloadModel(ttsId);
} catch (e) { console.log(`[TTS] ERROR: ${e.stack || e.message}`); }

console.log(`\n[${rss()}MB] voice test done.`);
