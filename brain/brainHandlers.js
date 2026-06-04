// brainHandlers.js — register the Brain API (PLAN §3.3) on a connected peer.
// Shared by brainMain.js (the real entrypoint) and the acceptance tests, so the
// tests exercise the exact handler code that ships.
//
// runTurn supports two input modes:
//   - text/wav:  {command} or {wavPath}            -> one-shot
//   - streaming: {audio:true}                      -> mic PCM frames
//        The app, on the `listening` event, emits `audio` events
//        ({pcm:<base64 s16le 16k mono>}) then `audioEnd`. The brain
//        streaming-transcribes (Whisper+VAD), emits `partial` segments, and
//        runs the loop on the final transcript.
import { StreamingTranscriber } from "./voice.js";
import { runTurn } from "./orchestrator.js";
import { TurnLogger } from "./logging.js";

export function attachBrain(peer, { qvac, hands, logDir, turnBase = 0 }) {
  let turnNo = turnBase;
  let currentCancel = null;
  let activeTranscriber = null;

  peer.handle("runTurn", async (params = {}) => {
    if (currentCancel) return { status: "busy", finalText: "A turn is already running." };
    const cancelToken = { cancelled: false };
    currentCancel = cancelToken;
    const logger = new TurnLogger({ turn: ++turnNo, dir: logDir });
    try {
      let command = params.command;

      // Streaming mic input: open a session, tell the app we're listening, then
      // route its audio frames in until audioEnd drains the transcript.
      if (params.audio) {
        const tr = new StreamingTranscriber(qvac, { onPartial: (t) => peer.emit("partial", { text: t }) });
        await tr.start();
        activeTranscriber = tr;
        peer.emit("listening", {}); // app starts streaming on this
        command = await tr.done; // resolves once audioEnd routed + stream drains
        activeTranscriber = null;
        logger.log({ phase: "stt", msg: "streamed", transcript: command, ms: tr.ms() });
      }

      const r = await runTurn({
        qvac,
        hands,
        logger,
        command,
        wavPath: params.wavPath,
        speak: params.speak ?? true,
        onEvent: (e) => peer.emit(e.event, e.data),
        cancelToken,
      });
      return { status: r.status, finalText: r.finalText, transcript: r.transcript, steps: r.steps.length };
    } finally {
      currentCancel = null;
      activeTranscriber = null;
    }
  });

  peer.handle("cancel", async () => {
    if (currentCancel) currentCancel.cancelled = true;
    // If we're mid-capture, unblock the transcriber so the turn can wind down.
    if (activeTranscriber) {
      try {
        activeTranscriber.endInput();
      } catch {
        /* ignore */
      }
    }
    return { ok: true, cancelling: !!currentCancel };
  });

  // Mic audio frames + end-of-utterance (events from the app).
  peer.on("audio", (d) => {
    try {
      activeTranscriber?.write(d?.pcm);
    } catch {
      /* a bad frame must not wedge the turn */
    }
  });
  peer.on("audioEnd", () => {
    try {
      activeTranscriber?.endInput();
    } catch {
      /* ignore */
    }
  });

  return { isBusy: () => !!currentCancel };
}
