# Veil — Build Plan

> The execution blueprint. Read `CONCEPT.md` for the pitch and `SPIKE_RESULTS.md` for validated capabilities + gotchas. This doc is *what we build, how, in what order.*

**Goal:** A fully-offline, voice-driven macOS computer-use agent — 100% on-device QVAC inference — that *operates the computer* (clicks/types/reads), with **tiered P2P intelligence** (small model local, big model on a peer, cloud never) and two hero skills: **MedPsy health** and **sovereign USDt/BTC**.
**Deadline:** Early-bird **June 17**, final **June 21, 2026**.
**Hardware:** Apple M4 Pro / 24 GB (main) + teammate's machine (P2P peer).
**Track:** General Purpose + Our Psy Models.

---

## 1. System architecture

Two processes on one machine, talking over a local socket:

```
 ┌─────────────────────────────────────────────────────────────┐
 │  SWITCH APP  "eyes & hands"  (Swift / macOS menu-bar)        │
 │  - ScreenCaptureKit capture        (lift from clicky)        │
 │  - Accessibility-tree reader       (NEW)                     │
 │  - Actuation: CGEvent / AXPress    (NEW)                     │
 │  - Push-to-talk + mic PCM          (lift from clicky)        │
 │  - Bezier "about-to-act" overlay   (lift from clicky)        │
 │  - Audio playback (AVAudioPlayer)  (lift from clicky)        │
 │  NO AI here.                                                 │
 └───────────────┬───────────────────────────▲─────────────────┘
                 │ commands (click/type/...)   │ sensor data (AX tree,
                 │ + mic PCM                    │ screenshot) + results
        local socket (newline-delimited JSON, request/response + events)
                 │                              │
 ┌───────────────▼───────────────────────────┴─────────────────┐
 │  BRAIN  (Node / @qvac/sdk)  — ALL inference, single worker   │
 │  orchestrator: perceive → plan → show → act → verify         │
 │  models: STT · planner LLM (tools+grammar) · OCR · VLM       │
 │          verify · MedPsy · TTS · RAG · P2P delegate          │
 └───────────────┬─────────────────────────────────────────────┘
                 │ delegate hard reasoning (encrypted P2P, no cloud)
        ┌────────▼────────┐
        │  PEER (Node)    │  startQVACProvider hosting a big model
        │  teammate's box │  (GPT_OSS_20B / QWEN3_8B)
        └─────────────────┘
```

**Why two processes:** macOS capture/AX/actuation are far more robust in Swift; QVAC is JS. Keeping all AI in the Node brain satisfies the mandatory "QVAC for all inference." The brain runs as a launched sidecar (documented in repro), not bundled in the `.app` — avoids fragile Node-in-app packaging for the demo.

---

## 2. The agent loop (orchestrator)

One "turn" = one voice command → completed task. Loop until `done` or max steps:

1. **Perceive** — brain calls `hands.captureScreen()` + `hands.getAXTree()`. Build a *grounded element list* `[{id, role, label, value, bounds}]`, filtered to actionable + on-screen. If a region has no AX coverage (canvas/Electron), run **OCR (doctr)** on that crop to get text+boxes. (VLM only if needed.)
2. **Plan** — feed `{system, screen-state, user-command, short history}` to the planner LLM with **grammar-constrained `json_schema`** → one `Action`. Route to **peer** if the step is flagged "hard" (see §6).
3. **Show** — `hands.showOverlay(bounds)` animates the cursor to the target *before* acting (transparency + great demo).
4. **Act** — `hands.click(id|x,y)` / `hands.type(text)` / `hands.key(combo)` / `hands.openApp(name)` etc.
5. **Verify** — re-perceive; compare expected vs actual (AX-diff first; VLM verify for visual cases). If mismatch → replan (bounded retries). If success and task complete → `speak()` result, `done`.

Every step emits a structured log line (→ free "Artifact Quality" points + debugging).

---

## 3. Interfaces / contracts

### 3.1 Action schema (planner output — grammar-enforced)
```jsonc
{
  "thought": "string",                       // brief reasoning
  "action": "click | type | key | scroll | open_app | speak | query_health | wallet_send | ask_user | done",
  "targetId": 0,                             // REQUIRED for click/type/scroll (AX element id). Grammar makes it required per-action.
  "text": "string",                          // for type / speak / open_app / query_health
  "keys": "string",                          // for key, e.g. "cmd+space"
  "amount": "string", "asset": "USDT|BTC", "to": "string"  // for wallet_send
}
```
Lesson from spike: make `targetId` **required** for click/type so grammar always populates it.

### 3.2 Hands API (Swift exposes → Brain calls)
| Method | Args | Returns |
|---|---|---|
| `captureScreen` | `{display?}` | `{pngPath, width, height, scale}` |
| `getAXTree` | `{appBundleId?, onscreenOnly:true}` | `[{id, role, label, value, bounds:{x,y,w,h}, enabled, focused}]` |
| `clickElement` | `{id}` or `{x,y}` | `{ok}` |
| `type` | `{text}` | `{ok}` |
| `key` | `{keys:"cmd+space"}` | `{ok}` |
| `scroll` | `{dx,dy}` | `{ok}` |
| `openApp` | `{name}` | `{ok}` |
| `showOverlay` | `{x,y,label}` | `{ok}` |
| `playAudio` | `{pcm|wavPath}` | `{ok}` |

### 3.3 Brain API (Swift calls on push-to-talk)
| Method | Args | Returns |
|---|---|---|
| `runTurn` | streams mic PCM | events: `transcript`, `step` (action+overlay), `speak`, `done` |
| `cancel` | — | aborts current turn |

### 3.4 Transport
Unix domain socket (fallback: localhost TCP), **newline-delimited JSON**, `{id, method, params}` / `{id, result|error}` + `{event, data}`. Mirror clicky's existing provider-abstraction style so the seam is clean.

---

## 4. Module breakdown

### 4.1 Brain (Node) — `qvac/brain/`
- `qvac.js` — model lifecycle: load/unload, keep-warm set, **single-worker + orphan-cleanup** (kill worker + clear `~/.qvac/.worker.lock` on start/crash), `unhandledRejection`/`uncaughtException` guards, guarded `unloadModel`.
- `perception.js` — AX tree + screenshot → grounded element list; doctr OCR fallback; element id assignment + bounds normalization (Retina points↔pixels).
- `planner.js` — prompt build + `completion()` with `responseFormat: json_schema`; tool-calling variant; history/compaction.
- `executor.js` — Action → hands command(s); overlay-before-act.
- `verifier.js` — AX-diff + optional VLM (`QWEN3VL_2B`) check; retry/replan policy.
- `voice.js` — STT (`transcribeStream` Whisper/Parakeet + Silero VAD); TTS (`textToSpeech` Supertonic, **`stream:false`**).
- `skills/health.js` — find/open lab doc → OCR (doctr) → MedPsy reason → speak. (Optional RAG over a records folder.)
- `skills/wallet.js` — drive wallet UI by grounding; **mandatory voice-confirm gate**; testnet only.
- `p2p.js` — `startQVACProvider` (peer) + `loadModel({delegate:{providerPublicKey, fallbackToLocal:true}})`; "hard step" router; connection pre-warm.
- `orchestrator.js` — the loop (§2).
- `ipc.js` — socket server (Brain API) + hands client (Hands API).
- `logging.js` — structured JSONL per turn/step (artifact).

### 4.2 Eyes & hands (Swift) — fork of `farzaa/clicky` (MIT)
**Lift ~as-is:** `CompanionScreenCaptureUtility` (capture + points/pixels math — raise the 1280 clamp), `OverlayWindow` + `CompanionResponseOverlay` (overlay), `GlobalPushToTalkShortcutMonitor` + `BuddyDictationManager` (AVAudioEngine) + `BuddyAudioConversionSupport` (PCM16), `WindowPositionManager` (AX perms), menu-bar shell.
**Build new:** `AXTreeReader` (traverse `AXUIElement`, roles/labels/`AXValue` bounds, `AXUIElementCopyElementAtPosition`), `Actuator` (CGEvent mouse/keyboard — **mind AppKit-bottom-left vs CGEvent-top-left Y-flip** — + `AXUIElementPerformAction(kAXPressAction)`), `BrainClient` (socket; replaces `ClaudeAPI`), mic-PCM streamer + audio player wired to brain.
**Delete:** Cloudflare `worker/`, `ElevenLabsTTSClient`, `AssemblyAI*`, `OpenAIAPI`, analytics, Sparkle, `ElementLocationDetector`.

---

## 5. Model stack (validated in spike)
| Role | Model | Config notes |
|---|---|---|
| Planner / tools | `QWEN3_4B_INST_Q4_K_M` | `{ctx_size:4096, tools:true}`; `responseFormat json_schema` |
| Big peer brain | `GPT_OSS_20B_INST_Q4_K_M` or `QWEN3_8B_INST_Q4_K_M` | via P2P delegate |
| Visual verify | `QWEN3VL_2B_MULTIMODAL_Q4_K` (+mmproj) | verify only, not coordinates |
| OCR (grounding) | doctr: `OCR_RECOGNIZER_CRNN_MOBILENET_V3_SMALL` + `detectorModelSrc: OCR_DETECTOR_DB_MOBILENET_V3_LARGE`, `pipelineMode:"doctr"` | returns `{text,bbox,confidence}` |
| STT | `WHISPER_EN_TINY_Q8_0` (+ Parakeet CTC for streaming) | no `useGPU` key |
| TTS | `TTS_EN_SUPERTONIC_Q8_0` | `{ttsEngine:"supertonic", language:"en"}`; call **`stream:false`** |
| Health | `medpsy-4b-q4_k_m-imat.gguf` (https URL) | NOT `registry://` |
| RAG | `GTE_LARGE_FP16` (1024-d) + SQLite-vector | optional for health |

**Memory budget (~19 GB Metal working set):** resident = planner + STT + TTS + OCR (~6–8 GB); swap-on-demand = VLM, MedPsy. One worker, multiple models.

---

## 6. P2P tiered intelligence
- **Peer setup:** teammate runs `startQVACProvider({firewall:{mode:"allow",publicKeys:[ourKey]}})`, hosts `GPT_OSS_20B`/`QWEN3_8B`, shares its public key.
- **Routing:** planner tags a step `hard` (long-horizon plan, ambiguous intent, MedPsy deep-reason) → brain loads that model with `delegate:{providerPublicKey, fallbackToLocal:true}` and runs the completion on the peer.
- **Demo beat:** UI shows "delegating to peer…"; big model runs on teammate's box; internet off; if peer drops → auto local fallback.
- **Caveat:** first DHT connect ~15–45s → **pre-warm** before demo; only offload non-time-critical steps live.

---

## 7. Hero skills (flows)
- **Computer-use:** "Open Notes and write up today's standup." → openApp → AX-grounded type. (Curate 2–3 apps we test hard: Notes, a PDF viewer, the wallet.)
- **Health (MedPsy):** "Open my latest labs and flag anything concerning." → locate/open PDF → doctr OCR values → MedPsy reason → speak. Medical data never leaves device.
- **Money (Solana devnet):** wallet = **Phantom** or **Solflare** Chrome extension on **devnet** (user has both). "Send 0.5 SOL to `<addr>`." → focus Chrome → open the wallet popup → ground the form (**OCR-first**, see §9) → fill amount + address → **voice-confirm gate** → submit. **Devnet only, no real funds.** Keys never leave the device. Generalizes to USDt/stablecoins on mainnet; on-chain *swaps* are a stretch (devnet liquidity is unreliable).

---

## 8. Timeline (Jun 3 → Jun 17 early-bird)
| Phase | Days | Deliverable |
|---|---|---|
| **0. Spike** ✅ | done | All capabilities validated; this plan |
| **1. Brain skeleton** ✅ | Jun 4–5 | Orchestration loop end-to-end vs **mock hands** (simulated screen). STT→plan→act(mock)→verify→TTS. **Done: `brain/`, all 5 §13 acceptance tests passing.** |
| **2. Eyes & hands** | Jun 6–8 | clicky builds; `AXTreeReader` + `Actuator` + `BrainClient` socket; real capture + AX + click/type. **Brain side ✅: full bidirectional transport — Hands API (`ipc.js`/`handsServer.js`) AND Brain API (`brainMain.js`/`refApp.js`: `runTurn`/`cancel` + `transcript`/`step`/`speak`/`done` + cancel) tested over a real socket; app-quit auto-cleanup verified; wire locked in `brain/PROTOCOL.md`.** Swift peer = teammate's lane. |
| **3. Real loop (MVP)** | Jun 9–11 | Voice → real AX-grounded computer-use on Notes + PDF viewer, with verify + overlay. **Brain side ✅: streaming mic STT (`runTurn {audio:true}` → Whisper+Silero VAD over the socket, `streamingAcceptance.js` 3/3); `brainHandlers.js` shared by entrypoint+tests.** |
| **4. Hero skills** | Jun 12–13 | Health (MedPsy labs) + money (testnet wallet + confirm). **Health ✅ (brain side): `query_health` → doctr OCR → MedPsy → speak; `skills/health.js`, `healthAcceptance.js` 2/2.** Wallet next (needs real Chrome grounding). |
| **5. P2P** | Jun 14 | Delegate hard step to teammate's peer; fallback works. **Brain side ✅ scaffold: `p2p.js` PeerLink (delegated big planner + `fallbackToLocal`), escalate-on-struggle routing + `delegate` event, `peerProvider.js`; `p2pAcceptance.js` 4/4 (provider/offline/fallback/routing on one machine). Cross-machine offload pending the peer's box.** |
| **6. Polish + artifacts** | Jun 15–16 | Structured logs, **demo video**, repro docs, hardware proof, build-in-public |
| **7. Submit** | Jun 17 | Early-bird submission. Jun 18–21 = buffer/fixes |

Parallelizable: me → brain; teammate → Swift eyes/hands + peer setup; you → demo props, apps, build-in-public, Discord/Keet.

---

## 9. Risks & mitigations
| Risk | Mitigation |
|---|---|
| AX-tree gaps on some apps | Curate demo apps; OCR doctr fallback; VLM verify |
| Latency stacking per step | Keep models warm; small models for routing; cap verifier calls; P2P offload heavy step; narrate in demo |
| 24 GB memory ceiling | ~19 GB budget; load-on-demand; Q4; one worker |
| Worker orphan/lock on crash | Brain kills worker + clears lock on start/crash; guard `unloadModel` |
| Autonomous money risk | Devnet only; voice-confirm gate; no real funds |
| **Chrome-extension wallet grounding** | Extension/web-popup AX is unreliable → **OCR-first (doctr) + VLM** grounding; launch Chrome with `--force-renderer-accessibility`; **validate on Day 1 of Phase 4** before committing the money demo |
| P2P cold-start / peer offline | Pre-warm connection; `fallbackToLocal:true` |
| Demo fragility (live) | Scripted-but-real flows on tested apps; deterministic AX grounding; record a backup take |

---

## 10. Decisions (LOCKED 2026-06-04)
1. **Wallet/chain** → **Phantom or Solflare on Solana _devnet_** (Chrome extension; user has both). Demo action = **send devnet SOL + voice-confirm**. Grounding = OCR-first (§9). Swap = stretch only.
2. **Demo apps** → **Notes + Preview/PDF viewer + Chrome (Phantom/Solflare)**.
3. **Verify strategy** → **AX-diff first; VLM verify only on ambiguity.**
4. **Hero lead** → **health leads, money closes.**
5. **Name** → "Veil" (placeholder, revisit before submission).

## 11. What we need (props / accounts)
- [x] Wallet: **Phantom + Solflare** (Chrome, **switch to devnet** + faucet some SOL)
- [ ] Sample lab-result PDF (real-format, fake data)
- [ ] Teammate's machine specs + QVAC installed (P2P peer)
- [ ] Discord + Keet accounts (community votes + build-in-public)
- [ ] Decide build-in-public channel (X thread?) + cadence

## 12. Success criteria
- Live demo, **airplane mode on**, runs the computer-use flow + health + (stretch) money, with the **peer-offload** beat — on the M4 Pro.
- Submitted before **Jun 17**. Complete artifacts: repro steps, structured logs, demo video, hardware proof.
- Hits the rubric: multi-agent orchestration + tool calling, P2P load distribution, MedPsy usage, privacy-first on real consumer hardware.

---

## 13. Phase 1 spec — Brain skeleton (next session's target)

**Outcome:** the full `perceive → plan → show → act → verify` loop running end-to-end in Node, driven against a **mock hands** module (a fake screen), with real QVAC STT + planner + TTS. No Swift, no macOS APIs yet. Proves the orchestration + reliability before we wire real capture/actuation.

**Build under `qvac/brain/`:**
- `qvac.js` — model manager with the spike gotchas baked in: startup kills any orphan worker + clears `~/.qvac/.worker.lock`; `unhandledRejection`/`uncaughtException` guards; guarded `unloadModel`; keep-warm set.
- `mockHands.js` — implements the **Hands API (§3.2)** against a scripted in-memory screen: a small fixture app (e.g. a fake "Notes" with `[New Note]`, `[Search]`, a text area) returning a grounded element list; `clickElement`/`type` mutate the fixture state so `verify` can observe real change. Swappable later for the real socket client.
- `perception.js`, `planner.js` (json_schema action, `targetId` required for click/type), `executor.js`, `verifier.js` (AX-diff against the mock state), `voice.js` (STT in / TTS out), `orchestrator.js`, `logging.js` (JSONL per step).
- `runTurn.js` — CLI harness: takes a text command (and optionally a wav) → runs a full turn → prints the step trace + final spoken text; writes `turn-<n>.jsonl`.

**Acceptance tests (must pass):**
1. Text command "create a new note" → loop emits `click(New Note)` → mock state changes → verifier confirms → `done`. Logged.
2. "search for groceries and type milk" → multi-step: `click(Search)` → `type("milk")` → verify → `done`.
3. A wav command → STT transcript → same loop → TTS wav out (`stream:false`).
4. A deliberately-wrong first action → verifier catches the unchanged state → replans → succeeds (proves the self-correction loop).
5. Whole run uses ONE qvac worker; clean exit leaves no stale lock.

**Out of scope for Phase 1:** real screen capture, AX tree, CGEvent, Chrome/wallet, MedPsy skill wiring (model already validated), P2P. Those are Phases 2–5.

---

## 14. Dev setup / how to run
- **Repo layout:** `qvac/` = root. `qvac/spike/` = validated probes (keep for reference + repro). `qvac/brain/` = Node brain (Phase 1+). `qvac/app/` = Swift eyes-and-hands fork of clicky (Phase 2+).
- **Prereqs (confirmed on the M4 Pro):** macOS 26.5, Node 24.15, Xcode 26.5, ffmpeg. `@qvac/sdk` 0.12.1.
- **Install brain deps:** `cd qvac/brain && npm i @qvac/sdk` (~5.4 GB native prebuilds, ~10 min first time). Models cache in `~/.qvac/models` (first use of each downloads it).
- **Single-worker rule:** only ONE Node process may use QVAC at a time. Always clean orphans before a run: `pkill -f "@qvac/sdk/dist/server"; rm -f ~/.qvac/.worker.lock`.
- **Git:** `git init` at `qvac/`; `.gitignore` excludes `node_modules/`, model/audio artifacts. The hackathon requires a reproducible repo + logs + demo video + hardware proof.
- **Reference docs:** `CONCEPT.md` (pitch), `SPIKE_RESULTS.md` (validated stack + gotchas + repro), this `PLAN.md` (blueprint), `CLAUDE.md` (session bootstrap).
