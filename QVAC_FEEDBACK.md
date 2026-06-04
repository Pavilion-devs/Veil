# QVAC SDK — Field Feedback from building Veil

Constructive feedback for the QVAC / Tether team, collected while building **Veil**
(a fully-offline, voice-driven macOS computer-use agent) end-to-end on `@qvac/sdk`.
Everything below is something we **actually hit**, with the workaround we shipped and
a suggested fix. We went deep — STT (one-shot + streaming), planner LLM with
grammar-constrained JSON + tool calling, TTS, OCR, MedPsy, VAD, and the worker
lifecycle — so this is real usage, not a skim.

We're sharing it because we want the product to get better, and because a lot of
these cost us hours that good error messages or docs would have saved.

## Repro environment
- **Hardware:** Apple M4 Pro, 24 GB unified memory
- **OS / runtime:** macOS 26.5, Node 24.15
- **SDK:** `@qvac/sdk` 0.12.1
- **Models touched:** `QWEN3_4B_INST_Q4_K_M`, `WHISPER_EN_TINY_Q8_0`, `VAD_SILERO_5_1_2`,
  `TTS_EN_SUPERTONIC_Q8_0`, doctr OCR (`OCR_DETECTOR_DB_MOBILENET_V3_LARGE` +
  `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL`), `medpsy-4b-q4_k_m-imat.gguf`

Severity legend: **🔴 High** (crash / silent wrong output / blocks work) ·
**🟠 Medium** (significant friction / surprising) · **🟡 Low** (papercut / docs).

---

## A. Bugs & silent footguns

### A1. 🔴 TTS returns an **empty buffer by default** (silent)
`textToSpeech({ modelId, text })` defaults to `stream: true`, and in that mode the
synchronous `result.buffer` is **empty** — no error, no warning, just 0 samples. You
only get audio if you pass `stream: false` (then `await result.buffer`) or consume
`result.bufferStream`.
- **Cost to us:** burned real time thinking the model was broken; it produces clear
  audio once you know the flag.
- **Workaround:** always `textToSpeech({ ..., stream: false })`, then `await r.buffer`.
- **Suggested fix:** either make `result.buffer` throw/warn when empty in stream mode,
  or have it lazily resolve the streamed buffer. At minimum, document the default loudly.

### A2. 🔴 `unloadModel` can throw and crash the process
`unloadModel(id)` intermittently rejects from an RPC-validation path (looks like a
ZodError), surfacing as an **unhandled promise rejection** that takes the whole
process down — including during otherwise-clean shutdown.
- **Workaround:** wrap every `unloadModel` in try/catch **and** install
  `process.on('unhandledRejection')` / `'uncaughtException'` guards. We rely on clean
  process exit instead of trusting `unloadModel`.
- **Suggested fix:** never reject from teardown; validate defensively and resolve.

### A3. 🔴 Documented OCR model combos are broken; only one works
We tried the combos the constants/examples imply:
- `OCR_LATIN_RECOGNIZER` + `OCR_CRAFT_DETECTOR` (`pipelineMode:"easyocr"`) → **fails**.
- `OCR_RECOGNIZER_PARSEQ` + `OCR_DETECTOR_DB_RESNET50` (`pipelineMode:"doctr"`) →
  loads but outputs **garbage**.
- The CRAFT / `rec_512` path hits a **512-dimension error**.

Only **doctr** with `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL` +
`detectorModelSrc: OCR_DETECTOR_DB_MOBILENET_V3_LARGE`, `pipelineMode:"doctr"` works
(and works well — 113 blocks, tight bboxes, conf 0.82–1.00).
- **Suggested fix:** mark the broken combos as unsupported (or fix the dim mismatch),
  and ship a "known-good OCR config" in the docs.

### A4. 🟠 Streaming STT needs a VAD, but the error and the param location are misleading
`transcribeStream({ modelId })` on a Whisper model fails with:
`Transcription failed: VAD model name is required for Whisper transcription`.
The intuitive fix — passing `transcribeStream({ vadModelSrc: VAD_SILERO_5_1_2 })`
(the param exists in the types) — **still throws the same error**. The VAD must be
supplied at **load time** via `loadModel({ modelConfig: { vadModelSrc: VAD_SILERO_5_1_2 } })`.
- **Cost to us:** the error says "name is required" while we were passing a full VAD
  descriptor object; the real issue was *where* it goes.
- **Workaround:** load a second Whisper instance with `modelConfig.vadModelSrc` set,
  used only for `transcribeStream`.
- **Suggested fix:** make `transcribeStream`'s `vadModelSrc` param actually work, or
  error with "set modelConfig.vadModelSrc at loadModel()"; the message should name the
  missing **field**, not "name".

### A5. 🟠 MedPsy GGUF won't load via `registry://`, only plain `https://`
`registry://hf/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf` (the same
scheme that works for Whisper) **fails**; the plain
`https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/...` URL works.
- **Workaround:** load by https URL.
- **Suggested fix:** support `registry://` uniformly for first-party models, or document
  which models are registry-backed vs URL-only.

---

## B. Worker lifecycle & concurrency

### B1. 🔴 One worker per machine; a crash leaves a stale lock that blocks the next run
A corestore/RocksDB lock means **only one process** may use QVAC at a time. A crash
(or an uncaught rejection like A2) orphans the detached worker and leaves
`~/.qvac/.worker.lock`, which then **blocks the next run** with a lock error.
- **Workaround we ship on every startup:**
  `pkill -f "@qvac/sdk/dist/server"; rm -f ~/.qvac/.worker.lock`, plus the rejection
  guards from A2. We architected the whole app around a single Node "brain" process.
- **Suggested fix:** self-heal stale locks on startup (detect dead PID → reclaim), and
  expose a documented "reset worker" API so apps don't have to `pkill` + `rm` a private
  lockfile.

### B2. 🟠 The worker lock is released only on process exit, not on `unloadModel`/idle
Unloading all models does **not** release the worker or its lock — the detached worker
outlives `unloadModel` and only dies when the parent process exits. There's no API to
query worker state or to bring it down deterministically while staying alive.
- **Impact:** you can't assert a "clean" state in-process; lifecycle is opaque.
- **Suggested fix:** a `shutdownWorker()` / `getWorkerState()` API, and release the lock
  when no models are loaded.

---

## C. API design & consistency

### C1. 🟠 `completion` result shape requires defensive probing
To read a completion reliably we have to do:
`const final = await (r.final ?? r); const text = final.contentText ?? final.text ?? (await r.text);`
The shape differs between stream/non-stream and across fields (`contentText`, `text`,
`thinkingText`, `toolCalls`, `final`).
- **Suggested fix:** one stable result type with documented fields; e.g. always
  `{ text, thinking, toolCalls, stats }` for non-stream and a typed event stream otherwise.

### C2. 🟠 `transcribeStream` is heavily overloaded — easy to call the wrong one
There are ~5 overloads: a **deprecated** upfront-audio async-generator, the bidirectional
`write()/end()` session, a parakeet-streaming-config variant, a metadata variant, and an
`emitVadEvents` variant. The simplest-looking call resolves to the deprecated one.
- **Suggested fix:** split into clearly-named functions (`transcribeFile` vs
  `openTranscriptionSession`) rather than overloading one name; flag the deprecated path
  at runtime.

### C3. 🟡 `modelType` aliases are deprecating silently
`llm`→`llamacpp-completion`, `whisper`→`whispercpp-transcription`, `tts`→`tts-ggml`,
`ocr`→`onnx-ocr`. The aliases still work but there's no runtime deprecation notice; we
only learned the canonical names by reading the plugin sources.
- **Suggested fix:** a one-time console deprecation warning when an alias is used.

### C4. 🟡 Config-surface inconsistency across model types
`useGPU` is invalid for whisper/tts (GPU is automatic) but valid for OCR; LLM uses
`device:"gpu"`. It's hard to predict which knobs apply to which `modelType`.
- **Suggested fix:** a per-modelType config reference table, and ignore-with-warning for
  unknown keys instead of silent drop / errors.

---

## D. Onboarding, noise & footprint

### D1. 🟠 ~5.2–5.4 GB of native prebuilds; ~10 min first install
`npm i @qvac/sdk` pulls ~5.2 GB of native Metal/ONNX prebuilds. Heavy for onboarding
and brutal for CI. (We worked around it by sharing one install across packages via a
`node_modules` symlink.)
- **Suggested fix:** split prebuilds per backend/addon so apps pull only what they load;
  optional lazy backend download.

### D2. 🟠 Very noisy, hard-to-silence stdout
Loading/running prints a wall of low-level logs that we can't easily quiet:
`ggml_metal_device_init …`, **repeated** `ggml_backend_load_best: search path … does
not exist` (benign but alarming — looks like a failure), `[sdk:server] …`,
`common_init_result …`. We pipe through `grep -v` to see our own output.
- **Suggested fix:** a real log-level / quiet mode that gates the native + server logs;
  demote the "search path does not exist" line (it's expected fallback) below `info`.

### D3. 🟡 "TurboQuant" isn't in the SDK
It's referenced in QVAC positioning but there's no code/flag for it in 0.12.1. We
initially planned around it.
- **Suggested fix:** clarify in docs what's shipping vs roadmap.

---

## E. Model-quality observations (likely model, not SDK — sharing as FYI)

### E1. 🟡 Bundled `WHISPER_EN_TINY_Q8_0` is weak on synthetic speech / streaming segmentation
On **real human speech** (the bundled `jfk.wav`) streaming STT is great. On **synthetic
TTS** speech it degrades badly (e.g. "Create a new note." → "I appreciate a new note."),
and on continuous speech the VAD segments can arrive jumbled
("And so am I fellow America. Not! What your country can do for you…"). Fine for our
push-to-talk demo (real mic), but a stronger small streaming default (or guidance) would
help.

### E2. 🟠 ~19 GB Metal working-set ceiling, with manual memory management
On 24 GB, `recommendedMaxWorkingSetSize ≈ 19069 MB`. You can't hold planner + STT + TTS
+ OCR + VLM + MedPsy resident at once, and there's no built-in eviction/budgeting — we
hand-rolled keep-warm + load-on-demand.
- **Suggested fix:** an optional model-cache with an LRU/eviction budget and a
  "resident set" hint, so apps don't each reinvent memory management.

---

## What worked really well (credit where due)
- **Grammar-constrained JSON** (`responseFormat: json_schema`) on `QWEN3_4B_INST_Q4_K_M`
  was rock-solid — valid, correct output every call. This is what makes a small local
  model usable as a reliable agent planner. ⭐
- **Tool calling** on the same 4B was semantically correct across our tests.
- **Metal GPU** path "just worked" — `backendDevice: gpu`, unified memory, good throughput.
- **TTS (Supertonic)** is fast and clear once you pass `stream:false` — ~58× realtime.
- **Whisper one-shot** is quick (~263 ms on `jfk.wav`) and accurate on real speech;
  **streaming** works well on real speech once the VAD is wired (A4).
- **doctr OCR** is excellent — tight bounding boxes, high confidence.
- **MedPsy-4B** clinical reasoning genuinely impressed us — flagged every abnormal in a
  lab panel, staged CKD correctly, tied findings into metabolic syndrome, and hedged
  appropriately. ~72 tok/s, TTFT ~308 ms. Strong for a 4B and a great differentiator.
- **P2P primitives** (`startQVACProvider` + `loadModel({ delegate })`) are a genuinely
  novel capability we don't get anywhere else.

## TL;DR for the QVAC team
The fastest wins for developer trust: **(1)** stop `unloadModel` from crashing the
process (A2), **(2)** self-heal the stale worker lock (B1), **(3)** make the TTS empty
buffer non-silent (A1), **(4)** fix/clarify the VAD requirement + error for streaming STT
(A4), and **(5)** ship a "known-good config" doc for OCR + a quiet/log-level mode (A3, D2).
The core inference quality (grammar JSON, MedPsy, doctr, Metal perf) is already a
compelling, differentiated platform — these are mostly DX and lifecycle sharp edges.
