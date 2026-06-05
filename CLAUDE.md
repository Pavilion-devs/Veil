# CLAUDE.md — Veil (QVAC Hackathon)

**What this is:** Veil — a fully-offline, voice-driven **macOS computer-use agent**. It watches the screen and *operates the computer* (clicks/types/reads), with **100% on-device QVAC inference** (no cloud), **tiered P2P intelligence** (small model local → hard steps delegate to a peer), and two hero skills: **MedPsy health** + **sovereign Solana-devnet wallet**. For the QVAC Hackathon I "Unleash Edge AI" (Tether). **Early-bird deadline: June 17, 2026.** Track: General Purpose + Our Psy Models.

## Read these first (in order)
1. `PLAN.md` — the build blueprint (architecture, interfaces, modules, timeline, Phase-1 spec). **Source of truth.**
2. `SPIKE_RESULTS.md` — what's validated on this machine + every QVAC gotcha + repro.
3. `CONCEPT.md` — the pitch / why it wins (forward to teammates).

## Architecture (one line)
Swift "eyes & hands" app (capture + Accessibility-tree grounding + CGEvent actuation + overlay + mic; forked from MIT `farzaa/clicky`) ⇄ local socket ⇄ **Node "brain"** (`@qvac/sdk`, ALL inference: STT, planner LLM with tools+grammar JSON, OCR, VLM-verify, MedPsy, TTS, P2P). Grounding is **deterministic** (AX tree + OCR boxes, never VLM-guessed); actions are **grammar-constrained JSON**; loop = `perceive → plan → show → act → verify`.

## ⚠️ QVAC gotchas — DO NOT relearn these the hard way
- **ONE qvac worker per machine** (corestore lock). Use one Node process. Before any run: `pkill -f "@qvac/sdk/dist/server"; rm -f ~/.qvac/.worker.lock`. Crashes orphan the worker → clean on startup.
- **`unloadModel` can throw** (ZodError → unhandled rejection → crash). Guard it; add `process.on('unhandledRejection'/'uncaughtException')`.
- **TTS:** call `textToSpeech({..., stream:false})` to get `result.buffer` (default is stream:true → empty). Load `{ttsEngine:"supertonic", language:"en"}`. No `useGPU` key for tts/whisper.
- **OCR:** use the **doctr** pipeline (`OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL` + `detectorModelSrc: OCR_DETECTOR_DB_MOBILENET_V3_LARGE`, `pipelineMode:"doctr"`). The CRAFT/`rec_512` combo is broken; PARSEQ outputs garbage.
- **MedPsy** loads via plain **https** URL (`https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf`), NOT `registry://`.
- `modelType` canonical names: `llamacpp-completion`, `whispercpp-transcription`, `tts-ggml`, `onnx-ocr`.
- **TurboQuant does not exist** in the SDK. ~19 GB Metal working set on this 24 GB M4 Pro.

## Validated model stack
Planner `QWEN3_4B_INST_Q4_K_M` (+ `GPT_OSS_20B`/`QWEN3_8B` for the peer) · STT `WHISPER_EN_TINY_Q8_0` · TTS `TTS_EN_SUPERTONIC_Q8_0` · OCR doctr · health MedPsy-4B · RAG `GTE_LARGE_FP16`. P2P: `startQVACProvider` + `loadModel({delegate:{providerPublicKey, fallbackToLocal:true}})`.

## Repo layout
`spike/` validated probes (reference) · `brain/` Node brain (Phase 1+) · `app/` Swift fork of clicky (Phase 2+) · `QVAC_FEEDBACK.md` SDK field feedback for the Tether/QVAC team (bugs, footguns, DX — hand off later).

## Status & next step
Spike ✅. Plan locked. **Phase 1 ✅ (brain skeleton)** — full `perceive→plan→show→act→verify` loop in `brain/` vs `mockHands`, real QVAC STT/planner/TTS, all 5 `PLAN.md §13` tests passing, one worker, clean exit. Run: `cd brain && node acceptance.js`.
**Phase 2 + Brain API (brain side) ✅** — full bidirectional socket transport done + tested. `ipc.js` = `RpcPeer` (NDJSON request/respond + emit/on over one socket, PLAN §3.4). **Hands API** (brain→app): `handsServer.js`, `node runTurn.js --socket …`, `node ipcAcceptance.js` (loop over a real socket, 3/3). **Brain API** (app→brain, PLAN §3.3): `brainMain.js` serves `runTurn`/`cancel` + streams `transcript`/`step`(+overlay)/`speak`/`done`; `refApp.js` is the full Swift stand-in (push-to-talk from stdin); `node brainApiAcceptance.js` (event stream + cancel, 2/2). App-quit → brain auto-shuts-down QVAC cleanly (no stale lock), verified. Wire locked in `brain/PROTOCOL.md`.
**Streaming mic STT ✅** — `runTurn {audio:true}`: app streams s16le/16k/mono PCM frames as `audio` events (on a `listening` handshake) → brain streaming-transcribes (`WHISPER_EN_TINY_Q8_0` + `VAD_SILERO_5_1_2`) → `partial`/`transcript` events → loop. `brainHandlers.js` (shared by `brainMain.js` + tests), `voice.js` `StreamingTranscriber`/`sttStreamFromPcm`, `node streamingAcceptance.js` (3/3).
**Health skill ✅ (hero lead, Phase 4)** — `query_health` action: OCR the on-screen lab doc (doctr, reading-order reconstructed from bboxes) → MedPsy-4B reasoning (strips `<think>`) → speak. `skills/health.js`, `fixtures/labs.{html,png}`, `ocr`+`medpsy` roles, MockHands `showDocument()`. `node healthAcceptance.js` (2/2).
**P2P tiered intelligence ✅ scaffold (Phase 5)** — `p2p.js` `PeerLink` registers a delegated `plannerBig` (`loadModel({delegate:{providerPublicKey, fallbackToLocal:true}})`); `qvac.js` passes `delegate` + `registerModel`; orchestrator escalates to the peer on struggle and emits a `delegate` event (opt-in `peer` param → no regression; wired via `VEIL_PEER_KEY` in `brainMain.js`). `peerProvider.js` = teammate's `startQVACProvider` entrypoint. `node p2pAcceptance.js` (4/4: provider start, offline-detect, **local fallback**, escalation routing — all single-machine). Cross-machine offload needs the peer's box. **All 6 suites green (19 tests): acceptance 5/5, ipc 3/3, brainApi 2/2, streaming 3/3, health 2/2, p2p 4/4.**
**Next:** the Swift "eyes & hands" app (teammate's lane per `PLAN.md §8`) replaces `refApp.js` — build `AXTreeReader` + `Actuator` + the socket peer in `brain/PROTOCOL.md`. Brain side unchanged: `brainMain.js` is the real entrypoint. Remaining brain work: wallet skill (Phase 4, needs real Chrome grounding).

## Conventions
- Action schema + Hands/Brain API are defined in `PLAN.md §3` — build to that contract.
- Emit structured JSONL logs per step (hackathon needs artifacts).
- Hardware: Apple M4 Pro, 24 GB. Demo target: airplane-mode-on, single Mac (+ teammate's peer for P2P).
