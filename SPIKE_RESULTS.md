# Veil — Day-1 Feasibility Spike Results

**Date:** 2026-06-03 · **Machine:** Apple M4 Pro, 24 GB, macOS 26.5, Node 24.15, `@qvac/sdk` 0.12.1
**Verdict:** ✅ **GO.** Every QVAC capability the agent needs runs locally on this machine, with good speed and quality. The "small local models are weak" risk is empirically *managed* by our architecture (deterministic grounding + grammar-constrained output + verify loop).

---

## Scorecard

| Capability | Model | Result | Latency / Throughput |
|---|---|---|---|
| **LLM planner — tool calling** | `QWEN3_4B_INST_Q4_K_M` | **4/4 actions semantically correct** | 2.7–3.8 s (non-stream, cold) |
| **LLM planner — grammar JSON** | `QWEN3_4B_INST_Q4_K_M` | **5/5 valid, correct element each time** | 0.8–1.5 s |
| **Speech-to-text** | `WHISPER_EN_TINY_Q8_0` (43 MB) | Perfect transcript of `jfk.wav` | **263 ms** |
| **Text-to-speech** | `TTS_EN_SUPERTONIC_Q8_0` (252 MB) | 6.8 s of audio, clear | **117 ms (~58× realtime)** |
| **OCR + boxes** | doctr: DB-MobileNet + CRNN | **113 blocks, conf 0.82–1.00, tight bboxes** | ~ sub-second |
| **MedPsy clinical reasoning** | `medpsy-4b-q4_k_m` (https URL) | Flagged all 5 abnormals, staged CKD, hedged correctly | **72 tok/s GPU**, TTFT 308 ms |
| **Metal GPU** | — | `backendDevice: gpu`, ~19 GB working set | unified memory |

### Detail — LLM planner (the make-or-break test)
Simulated a grounded screen (`[id, role, label]` list) + voice command → action.
- Tool calls: "create a new note"→click #1, "delete this"→click #3, "search for groceries"→type "groceries", "send the message"→click #5. **All correct.**
- Grammar-constrained JSON (`responseFormat: json_schema`): 5/5 valid, picked the right element each time.
- **Refinement for build:** make `elementId` *required* for click/type in the action schema so grammar enforcement always populates it (when optional, the model sometimes put the target only in prose).

### Detail — MedPsy
Given a 5-value lab panel, it identified diabetes (A1c 7.8% + glucose 152), high CV risk (LDL 165), **CKD stage 3a (eGFR 58)**, likely fatty liver (ALT 64), tied them together as metabolic syndrome, and produced appropriate "discuss with clinician" guidance without over-diagnosing. Strong for a 4B.

---

## Confirmed model stack (all local, all QVAC)
- **Planner / tool-calling:** `QWEN3_4B_INST_Q4_K_M` (registry). Upgrade path: `QWEN3_8B_INST_Q4_K_M` or `GPT_OSS_20B_INST_Q4_K_M` (both in-registry) for the "big peer" via P2P.
- **STT:** `WHISPER_EN_TINY_Q8_0` (or Parakeet CTC for streaming).
- **TTS:** `TTS_EN_SUPERTONIC_Q8_0` — **must pass `stream:false`** (or consume `bufferStream`); `modelConfig: { ttsEngine:"supertonic", language:"en" }`.
- **OCR (grounding fallback):** doctr pipeline — `modelSrc: OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL`, `modelConfig: { langList:["en"], detectorModelSrc: OCR_DETECTOR_DB_MOBILENET_V3_LARGE, pipelineMode:"doctr" }`. Returns `{ text, bbox:[x1,y1,x2,y2], confidence }`.
- **Health:** `medpsy-4b-q4_k_m-imat.gguf` via **plain https URL** (`https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/...`). NOT `registry://`.
- **RAG:** `GTE_LARGE_FP16` (1024-d) + SQLite-vector (untested in spike; standard API).
- **Memory budget:** ~19 GB Metal working set → keep planner + STT + TTS + OCR resident (~6–8 GB), swap VLM / MedPsy on demand.

---

## Gotchas / lessons (bake into the Node brain)
1. **One QVAC worker per machine.** A corestore/RocksDB lock (`~/.qvac/.worker.lock` + registry-corestore `LOCK`) means **only one process** can use QVAC at a time. Our architecture is a single Node brain → fine. Multiple processes conflict.
2. **Crashes orphan the worker** and leave a stale lock that blocks the next run. The brain must **kill its worker on exit/crash** (process-group kill) and clear stale locks on startup.
3. **`unloadModel` has a flaky RPC-validation path** that can throw an unhandled rejection and crash the process. Guard it (`try/catch`) and/or rely on clean process exit; add `process.on('unhandledRejection'/'uncaughtException')`.
4. **`modelType` aliases are deprecating:** `llm`→`llamacpp-completion`, `whisper`→`whispercpp-transcription`, `tts`→`tts-ggml`, `ocr`→`onnx-ocr`. Use canonical names.
5. **No `useGPU` key** for whisper/tts modelConfig (GPU is automatic); it *is* valid for OCR.
6. **TurboQuant is not in the SDK** (no code/flag). Don't design around it.
7. **`screencapture` needs Screen Recording permission** — irrelevant to QVAC (the Swift app handles capture), worked once perms were granted.

---

## Reproduce
```bash
cd qvac/spike && npm install @qvac/sdk          # ~5.4 GB, ~10 min (native Metal/ONNX prebuilds)
node test_llm.js        # planner: tool calls + grammar JSON
node test_voice.js      # STT (jfk.wav) + TTS — run ONE qvac process at a time
node test_ocr2.js       # OCR doctr pipeline → boxes
node test_medpsy.js     # MedPsy clinical reasoning by https URL
node test_tts.js        # TTS stream:false → tts_out.wav
```
Models cache under `~/.qvac/models`. First run of each downloads its model.
