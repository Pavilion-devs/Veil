// streamingAcceptance.js — streaming mic STT (PLAN §4.1 voice / §3.3), end to
// end. Whisper tiny.en + Silero VAD over the bidirectional socket:
//   A. voice-level: chunk real PCM through a StreamingTranscriber.
//   B. socket end-to-end: app streams mic frames as `audio` events on the
//      `listening` handshake; the brain streaming-transcribes and emits
//      partial/transcript/done; the loop runs.
//
// Real human speech (jfk.wav, 16k mono s16le) is used for the hard assertions —
// synthetic TTS transcribes poorly on tiny.en, so a TTS command is included only
// as an informational run (real mic audio behaves like jfk).
//
//   node streamingAcceptance.js
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listenPeer, connectPeer, serveHandsOnPeer, handsFromPeer } from "./ipc.js";
import { QvacManager } from "./qvac.js";
import { MockHands } from "./mockHands.js";
import { attachBrain } from "./brainHandlers.js";
import { sttStreamFromPcm, tts } from "./voice.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, "logs");
const SOCK = "/tmp/veil-streaming.sock";
const JFK = path.join(HERE, "node_modules/@qvac/tts-ggml/test/reference-audio/jfk.wav");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`\n${pass ? "✅ PASS" : "❌ FAIL"} — ${name}`);
  if (detail) console.log(`        ${detail}`);
}

// Stream a raw s16le PCM buffer to a peer as `audio` events + `audioEnd`.
async function streamPcm(peer, pcm, frame = 3200) {
  for (let i = 0; i < pcm.length; i += frame) {
    peer.emit("audio", { pcm: Buffer.from(pcm.subarray(i, Math.min(i + frame, pcm.length))).toString("base64") });
    await sleep(4);
  }
  peer.emit("audioEnd");
}

async function main() {
  const hands = new MockHands();
  let appPeer = null;
  let resolveConn;
  const gotConn = new Promise((r) => (resolveConn = r));
  const server = await listenPeer({
    socketPath: SOCK,
    onConnection: (peer) => {
      serveHandsOnPeer(peer, hands);
      appPeer = peer;
      resolveConn();
    },
  });
  const brainPeer = await connectPeer({ socketPath: SOCK });
  const qvac = new QvacManager({ log: () => {} });
  await qvac.init();
  attachBrain(brainPeer, { qvac, hands: handsFromPeer(brainPeer), logDir: LOG_DIR, turnBase: 70 });
  await gotConn;

  // One persistent `listening` responder streams whatever PCM is queued.
  let pendingAudio = null;
  appPeer.on("listening", () => {
    const pcm = pendingAudio;
    pendingAudio = null;
    if (pcm) streamPcm(appPeer, pcm);
  });

  const jfkPcm = fs.readFileSync(JFK).subarray(44); // strip 44-byte WAV header

  try {
    // ---- A: voice-level streaming on real speech ----
    {
      const segs = [];
      const r = await sttStreamFromPcm(qvac, jfkPcm, { onPartial: (t) => segs.push(t) });
      console.log(`   transcript: "${r.text}"  (${r.ms}ms, ${segs.length} segments)`);
      record(
        "A. StreamingTranscriber transcribes real PCM (jfk) → contains 'country'",
        r.text.toLowerCase().includes("country") && segs.length >= 1,
        `segments=${segs.length}`,
      );
    }

    // ---- B: end-to-end over the socket (mic frames → transcript → loop) ----
    {
      hands.reset();
      const events = [];
      const tap = (ev) => (d) => events.push([ev, d]);
      for (const ev of ["transcript", "partial", "step", "done"]) appPeer.on(ev, tap(ev));
      pendingAudio = jfkPcm;
      const res = await appPeer.request("runTurn", { audio: true, speak: false });
      const transcriptEv = events.find(([e]) => e === "transcript")?.[1];
      const text = transcriptEv?.text ?? "";
      const partials = events.filter(([e]) => e === "partial").length;
      const doneFired = events.some(([e]) => e === "done");
      console.log(`   streamed transcript: "${text}"  partials=${partials}  result=${JSON.stringify(res)}`);
      record(
        "B. socket end-to-end: mic frames → streaming transcript ('country') + done",
        text.toLowerCase().includes("country") && partials >= 1 && doneFired,
        `partials=${partials} doneFired=${doneFired} status=${res.status}`,
      );
    }

    // ---- C: informational — a synthesized command through the same path ----
    // (tiny.en transcribes synthetic speech poorly; real mic audio = jfk-quality)
    try {
      hands.reset();
      const wav = path.join(LOG_DIR, "stream-cmd.wav");
      await tts(qvac, "Create a new note.", wav);
      const pcmPath = path.join(LOG_DIR, "stream-cmd.pcm");
      execSync(`ffmpeg -y -i "${wav}" -ar 16000 -ac 1 -f s16le "${pcmPath}" 2>/dev/null`);
      const cmdPcm = fs.readFileSync(pcmPath);
      const before = hands.notes.length;
      pendingAudio = cmdPcm;
      const events = [];
      appPeer.on("transcript", (d) => events.push(d));
      const res = await appPeer.request("runTurn", { audio: true, speak: false });
      const heard = events[events.length - 1]?.text ?? "";
      const created = hands.notes.length === before + 1;
      console.log(
        `   [info] synthesized "Create a new note." → heard "${heard}" → status=${res.status} noteCreated=${created}`,
      );
      record(
        "C. (info) synthesized command streams through the pipeline → transcript + done",
        Boolean(heard) && res.status != null,
        `heard=${JSON.stringify(heard)} noteCreated=${created} (synthetic speech; real mic = jfk-quality)`,
      );
    } catch (e) {
      console.log(`   [info] Test C skipped (${e.message?.split("\n")[0]})`);
    }
  } finally {
    brainPeer.close();
    server.close();
    await qvac.shutdown();
    try {
      if (fs.existsSync(SOCK)) fs.unlinkSync(SOCK);
    } catch {
      /* ignore */
    }
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================  ${passed}/${results.length} streaming tests passed  ================`);
  for (const r of results) console.log(`  ${r.pass ? "✅" : "❌"} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
