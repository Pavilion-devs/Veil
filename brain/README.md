# Veil — Brain (Phases 1–2: agent loop + socket transport)

The Node/`@qvac/sdk` "brain": all on-device inference + the agent loop. It runs
the full **perceive → plan → show → act → verify** loop with real QVAC STT +
planner + TTS, either against an in-process **mock hands** (a fake Notes app) or
over a **real Unix socket** to an external hands server — the same wire the Swift
"eyes & hands" app will speak (see `PROTOCOL.md`). The loop is hands-agnostic, so
going from mock to the real Swift app is a transport swap, not a loop change.

## Run

```bash
# One turn from a typed command:
node runTurn.js "create a new note"
node runTurn.js --no-speak "search for groceries and type milk"
node runTurn.js --inject-wrong "create a new note"   # force a wrong 1st action

# One turn from a wav (STT in):
node runTurn.js --wav ./logs/cmd-create-note.wav --turn 3

# The five Phase-1 acceptance tests (PLAN §13), all in ONE qvac worker:
node acceptance.js

# --- Over a real Unix socket (Phase 2 transport; mirrors the Swift app + brain) ---
node handsServer.js                                       # terminal 1: reference hands (no QVAC)
node runTurn.js --socket /tmp/veil-hands.sock "create a new note"   # terminal 2: brain
node ipcAcceptance.js                                     # full loop over the socket (3/3)

# --- Brain API: app drives the brain via push-to-talk (Phase 3, PLAN §3.3) ---
node refApp.js          # terminal 1: app listens + serves hands + drives runTurn from stdin
node brainMain.js       # terminal 2: brain connects, holds QVAC, streams transcript/step/speak/done
> create a new note     # type into terminal 1; watch the events stream back
> :wav /path/to/cmd.wav # stream a 16k mono s16le wav as if it were the mic (real audio path)
node brainApiAcceptance.js   # automated: event stream + cancel over a real socket (2/2)
node streamingAcceptance.js  # automated: streaming mic STT (Whisper+VAD) end-to-end (3/3)

# --- Hero health skill: OCR a lab doc → MedPsy reasoning → speak (Phase 4, PLAN §7) ---
node healthAcceptance.js     # doctr OCR → MedPsy flags abnormals → query_health loop (2/2)
node fixtures/make-labs.js   # (re)render the sample lab report fixture (Chrome headless)

# --- P2P tiered intelligence: hard steps delegate to a big peer model (Phase 5, PLAN §6) ---
node p2pAcceptance.js        # provider start, offline-detect, local fallback, routing (4/4)
node peerProvider.js         # run on the TEAMMATE's box; prints a public key to share
VEIL_PEER_KEY=<key> node brainMain.js   # enable delegation from the brain
```

> Single-worker rule: only one Node process may use QVAC at a time. The brain
> reaps any orphan worker + clears `~/.qvac/.worker.lock` on startup, but if you
> ever hit a lock error, run `pkill -f "@qvac/sdk/dist/server"; rm -f ~/.qvac/.worker.lock`.
>
> The SDK (~5.2 GB native prebuilds) is shared from `../spike/node_modules` via a
> `node_modules` symlink, so there is nothing to install for Phase 1.

## Modules (PLAN §4.1)

| File | Role |
|---|---|
| `qvac.js` | Model lifecycle: orphan-worker reap + lock clear on start, `unhandledRejection`/`uncaughtException` guards, guarded `unloadModel`, keep-warm load-on-demand cache, canonical `modelType` names. |
| `mockHands.js` | The Hands API (§3.2) against a scripted Notes fixture; `click`/`type` mutate real state so the verifier observes genuine change. Swappable for the real socket client. |
| `perception.js` | AX tree + screenshot → grounded element list `[{id,role,label,value,bounds,focused}]` + the compact prompt rendering. |
| `planner.js` | Grammar-constrained `json_schema` action (PLAN §3.1); `targetId` enforced for `click` with one inline self-repair. |
| `executor.js` | Action → Hands command(s). |
| `verifier.js` | AX-diff (Decision §10.3): catches no-op / wrong / rejected actions and feeds the replan loop. |
| `voice.js` | STT (Whisper tiny.en) one-shot + `StreamingTranscriber` (mic PCM + Silero VAD); TTS (Supertonic, **`stream:false`**) → 24 kHz WAV. |
| `skills/health.js` | Hero health skill: doctr OCR (reading-order reconstructed) → MedPsy reasoning → speakable summary (strips the model's `<think>`). |
| `fixtures/labs.html` + `make-labs.js` | Sample lab report (fake data) → `labs.png` via Chrome headless; the OCR fixture. |
| `p2p.js` | `PeerLink` (P2P §6): registers a delegated big planner (`fallbackToLocal`), heartbeat online-check, DHT pre-warm. |
| `peerProvider.js` | The teammate's `startQVACProvider` entrypoint — hosts the big model, prints its public key. |
| `orchestrator.js` | The loop: perceive → plan → show → act → verify, with bounded replan + loop guard. |
| `logging.js` | Structured JSONL, one line per step/event, per turn (`logs/turn-<n>.jsonl`). |
| `ipc.js` | Bidirectional socket transport (PLAN §3.4): `RpcPeer` (request/respond + emit/on over one socket). Glue: `HandsClient`/`serveHands` (Hands API), `handsFromPeer`/`serveHandsOnPeer`. |
| `handsServer.js` | Reference hands server — `MockHands` over the socket; the executable spec for the Swift app (no QVAC). |
| `brainHandlers.js` | The Brain API handlers (`runTurn`/`cancel` + streaming mic + event streaming), shared by `brainMain.js` and the tests so they run shipping code. |
| `brainMain.js` | The real brain entrypoint: connects to the app socket, holds QVAC, `attachBrain`, auto-shuts-down on app disconnect. |
| `refApp.js` | Full Swift stand-in: listens, serves the Hands API, drives `runTurn` from stdin (text or `:wav` mic streaming), printing streamed events. |
| `runTurn.js` | CLI harness for one turn (`--socket` to drive a real hands server). |
| `acceptance.js` | The five PLAN §13 acceptance tests (in-process). |
| `ipcAcceptance.js` | The agent loop over a real Unix socket (3/3). |
| `brainApiAcceptance.js` | Brain API over a real socket: event stream + cancel (2/2). |
| `streamingAcceptance.js` | Streaming mic STT (Whisper + Silero VAD) end-to-end (3/3). |
| `healthAcceptance.js` | Hero health skill: OCR → MedPsy → speak, + the `query_health` loop (2/2). |
| `p2pAcceptance.js` | P2P routing (single-machine): provider start, offline-detect, local fallback, escalation (4/4). |
| `PROTOCOL.md` | The brain⇄hands+brain wire contract — what the Swift teammate builds against. |

## Model stack (validated, all local)

Planner `QWEN3_4B_INST_Q4_K_M` · STT one-shot `WHISPER_EN_TINY_Q8_0` · STT
streaming `WHISPER_EN_TINY_Q8_0` + `VAD_SILERO_5_1_2` (mic PCM, s16le/16k/mono) ·
TTS `TTS_EN_SUPERTONIC_Q8_0`. Loaded once, kept warm; one worker, ~19 GB Metal budget.

## Acceptance (PLAN §13) — all passing

1. `"create a new note"` → `click(New Note)` → verified → `done`.
2. `"search…type milk"` → multi-step `click → type` → verify → `done`.
3. wav → STT transcript → loop → TTS wav out (`stream:false`).
4. Wrong first action → **verifier catches the unchanged state** → replan → succeed.
5. Whole run uses **one** qvac worker; clean exit leaves **no stale lock**.

`node acceptance.js` exits 0 only if all five pass (verified stable across repeated runs).

## Out of scope for Phase 1

Real screen capture, AX tree, CGEvent actuation, Chrome/wallet, MedPsy skill
wiring, P2P — those are Phases 2–5. The loop above is hands-agnostic, so swapping
`MockHands` for the real socket client is the only change needed to go live.
