// voice.js — fully-local voice I/O via QVAC.
//   STT one-shot:  Whisper tiny.en   (transcribe a wav -> text)
//   STT streaming: Whisper tiny.en + Silero VAD (mic PCM frames -> text as the
//                  VAD detects speech segments). PCM is s16le, 16 kHz, mono.
//   TTS: Supertonic (text -> 24kHz mono wav) — MUST pass stream:false to get
//        result.buffer (default stream:true yields an empty buffer).
import { transcribe, transcribeStream, textToSpeech } from "@qvac/sdk";
import fs from "node:fs";

// --- Speech to text (one-shot, complete wav/buffer) ---
export async function stt(qvac, wavPath) {
  const modelId = await qvac.get("stt");
  const t0 = Date.now();
  const text = await transcribe({ modelId, audioChunk: wavPath });
  return { text: String(text).trim(), ms: Date.now() - t0 };
}

// Coerce a chunk to the Uint8Array of s16le bytes the session expects.
function toPcmBytes(chunk) {
  if (chunk == null) return new Uint8Array(0);
  if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof Int16Array) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (Array.isArray(chunk)) return new Uint8Array(Int16Array.from(chunk).buffer); // int16 samples
  if (typeof chunk === "string") return Buffer.from(chunk, "base64"); // base64 s16le
  return new Uint8Array(0);
}

// --- Speech to text (streaming) ---
// Open a session, push s16le/16k/mono PCM frames with write(), then endInput().
// `done` resolves to the full transcript once the stream drains. Partial
// segments are delivered via onPartial as the VAD detects them.
export class StreamingTranscriber {
  constructor(qvac, { onPartial } = {}) {
    this.qvac = qvac;
    this.onPartial = onPartial;
    this.parts = [];
    this.session = null;
    this.done = null;
    this.t0 = Date.now();
  }

  async start() {
    const modelId = await this.qvac.get("sttStream");
    this.session = await transcribeStream({ modelId });
    this.done = (async () => {
      for await (const x of this.session) {
        const s = String(x);
        if (s.trim()) {
          this.parts.push(s.trim());
          this.onPartial?.(s.trim());
        }
      }
      return this.parts.join(" ").replace(/\s+/g, " ").trim();
    })();
    return this;
  }

  write(chunk) {
    this.session.write(toPcmBytes(chunk));
  }

  endInput() {
    this.session.end();
  }

  async abort() {
    try {
      await this.session?.destroy?.();
    } catch {
      /* ignore */
    }
  }

  ms() {
    return Date.now() - this.t0;
  }
}

// Convenience: transcribe an already-buffered PCM blob by chunking it through a
// streaming session (simulates a mic). `pcm` is s16le 16k mono bytes.
export async function sttStreamFromPcm(qvac, pcm, { frameBytes = 3200, onPartial } = {}) {
  const tr = new StreamingTranscriber(qvac, { onPartial });
  await tr.start();
  const bytes = toPcmBytes(pcm);
  for (let i = 0; i < bytes.length; i += frameBytes) {
    tr.write(bytes.subarray(i, Math.min(i + frameBytes, bytes.length)));
    await new Promise((r) => setTimeout(r, 4)); // pace like a real mic
  }
  tr.endInput();
  const text = await tr.done;
  return { text, ms: tr.ms() };
}

// --- Text to speech --- writes a 24kHz mono WAV, returns its path + stats.
export async function tts(qvac, text, outPath) {
  const modelId = await qvac.get("tts");
  const t0 = Date.now();
  const r = textToSpeech({ modelId, text, stream: false });
  const buffer = (await r.buffer) ?? [];
  const ms = Date.now() - t0;
  if (buffer.length) writeWav(outPath, buffer);
  return { wavPath: buffer.length ? outPath : null, samples: buffer.length, ms };
}

// Supertonic emits float PCM in [-1,1] (we detect int16 just in case).
export function writeWav(outPath, data, sampleRate = 24000) {
  const head = data.slice(0, 200).map((v) => Math.abs(v));
  const isFloat = Math.max(...head) <= 1.5;
  const pcm = Int16Array.from(data, (v) => {
    const x = isFloat ? v * 32767 : v;
    return Math.max(-32768, Math.min(32767, Math.round(x)));
  });
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.byteLength, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.byteLength, 40);
  fs.writeFileSync(outPath, Buffer.concat([h, Buffer.from(pcm.buffer)]));
}
