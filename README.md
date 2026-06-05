# Veil

**A fully-offline, voice-driven macOS computer-use agent — 100% on-device AI.**

Veil watches your screen and *operates your Mac* (clicks, types, reads) from a
voice command, with **all inference running locally** via Tether's
[QVAC](https://qvac.io) SDK — no cloud, ever. It pairs deterministic UI grounding
(the Accessibility tree + on-device OCR) with a small local planner LLM whose
output is **grammar-constrained**, and a **verify-and-self-correct loop**, so a
4-billion-parameter model on your laptop can reliably drive real apps.

Two hero skills: a **MedPsy health assistant** that reads your lab results and
flags concerns (medical data never leaves the device), and a **sovereign
Solana-devnet wallet** with a mandatory voice-confirm gate.

> Built for the **QVAC Hackathon** (Tether — "Unleash Edge AI"). Track: General
> Purpose + Our Psy Models. Target hardware: Apple M4 Pro, 24 GB — airplane mode on.

---

## Why it's interesting

- **100% on-device.** STT, the planner LLM, OCR, the MedPsy clinical model, and
  TTS all run locally through one QVAC worker. The demo runs with the network off.
- **Reliable small-model agency.** Grounding is deterministic (Accessibility tree
  + doctr OCR boxes, never VLM-guessed); actions are **grammar-constrained JSON**;
  every action is **verified by AX-diff** and self-corrects on failure.
- **Tiered P2P intelligence** (roadmap): hard steps delegate to a bigger model on
  a peer over QVAC's encrypted P2P, with automatic local fallback — still no cloud.
- **Privacy-first health.** "Flag anything concerning in my labs" → OCR the lab
  PDF → MedPsy reasons → speaks a summary. Nothing leaves the machine.

## Architecture

```
 ┌───────────────────────────────────────────────┐        ┌──────────────────────────────┐
 │  SWIFT app — "eyes & hands"  (menu-bar)        │  local │  BRAIN — Node / @qvac/sdk    │
 │  ScreenCaptureKit · Accessibility tree ·       │ socket │  ALL inference, one worker:  │
 │  CGEvent actuation · mic PCM · overlay         │◀──────▶│  STT · planner (tools+grammar)│
 │  NO AI here.                                   │ (JSON) │  OCR · VLM · MedPsy · TTS · P2P│
 └───────────────────────────────────────────────┘        └──────────────┬───────────────┘
   the teammate's lane (Phase 2+)                          loop: perceive →│plan → show → act → verify
                                                  delegate hard reasoning  ▼ (encrypted P2P, roadmap)
                                                                    ┌─────────────┐
                                                                    │ PEER (Node) │ big model
                                                                    └─────────────┘
```

The two processes talk over a Unix-domain socket with newline-delimited JSON
(bidirectional: the brain calls the **Hands API**; the app calls the **Brain
API** and receives a `transcript → step → speak → done` event stream). The wire
contract is locked in [`brain/PROTOCOL.md`](brain/PROTOCOL.md).

## Status

The **brain is built and tested end-to-end in Node** (against a mock hands + a
reference socket app). The Swift "eyes & hands" app is the next major piece.

| Capability | State | Proof |
|---|---|---|
| Agent loop (perceive→plan→show→act→verify) + self-correction | ✅ | `acceptance.js` 5/5 |
| Grammar-constrained planner + AX-diff verify | ✅ | `acceptance.js` |
| Bidirectional socket transport (Hands API) | ✅ | `ipcAcceptance.js` 3/3 |
| Brain API: `runTurn`/`cancel` + event stream | ✅ | `brainApiAcceptance.js` 2/2 |
| Streaming mic STT (Whisper tiny.en + Silero VAD) | ✅ | `streamingAcceptance.js` 3/3 |
| **Health skill: OCR → MedPsy → speak** | ✅ | `healthAcceptance.js` 2/2 |
| **Wallet skill: devnet send + voice-confirm gate** | ✅ | `walletAcceptance.js` 6/6 |
| **P2P tiered intelligence (routing + fallback)** | ✅ scaffold | `p2pAcceptance.js` 4/4 |
| Swift eyes & hands app | ⏳ next | builds against `brain/PROTOCOL.md` |
| Wallet grounding on real Chrome/Phantom | ⏳ | needs the Swift app (OCR-first, §9) |
| P2P cross-machine offload (big model on a peer) | ⏳ | needs the teammate's box |

All on-device, single QVAC worker, with orphan-reap + clean shutdown.
**25 automated tests across 7 suites, all green.**

## Quickstart (the brain, no Swift needed)

```bash
cd brain        # SDK is reused from spike/ via a node_modules symlink — nothing to install

# One full turn against the mock Notes app (real STT/planner/TTS):
node runTurn.js "create a new note"

# The acceptance suites:
node acceptance.js            # agent loop (5/5)
node ipcAcceptance.js         # loop over a real Unix socket (3/3)
node brainApiAcceptance.js    # Brain API events + cancel (2/2)
node streamingAcceptance.js   # streaming mic STT end-to-end (3/3)
node healthAcceptance.js      # MedPsy health skill: OCR → reason → speak (2/2)
node p2pAcceptance.js         # P2P routing: provider, offline-detect, fallback (4/4)
node walletAcceptance.js      # devnet send + voice-confirm gate (6/6)

# Interactive: app + brain in two terminals (push-to-talk from stdin):
node refApp.js                # terminal 1 (listens, serves hands)
node brainMain.js             # terminal 2 (connects, holds QVAC)
> create a new note           # type a command; watch transcript/step/speak/done stream
```

> **One QVAC worker per machine.** If you hit a lock error:
> `pkill -f "@qvac/sdk/dist/server"; rm -f ~/.qvac/.worker.lock`

## Model stack (all local, validated on M4 Pro / 24 GB)

Planner `QWEN3_4B_INST_Q4_K_M` (grammar JSON + tools) · STT `WHISPER_EN_TINY_Q8_0`
(+ `VAD_SILERO_5_1_2` for streaming) · TTS `TTS_EN_SUPERTONIC_Q8_0` · OCR doctr
(`DB-MobileNet-v3-large` + `CRNN-MobileNet-v3-small`) · Health
`medpsy-4b-q4_k_m` · big peer `GPT_OSS_20B` / `QWEN3_8B` (P2P).

## Repo layout & docs

| Path | What |
|---|---|
| [`brain/`](brain/) | The Node/QVAC brain (built). See [`brain/README.md`](brain/README.md). |
| [`brain/PROTOCOL.md`](brain/PROTOCOL.md) | The brain⇄app wire contract (what the Swift app implements). |
| [`spike/`](spike/) | Day-1 feasibility probes (reference). |
| `app/` | Swift "eyes & hands" fork (Phase 2+, the teammate's lane). |
| [`PLAN.md`](PLAN.md) | The build blueprint — architecture, modules, timeline. **Source of truth.** |
| [`CONCEPT.md`](CONCEPT.md) | The pitch / why it wins. |
| [`SPIKE_RESULTS.md`](SPIKE_RESULTS.md) | Validated capabilities + every QVAC gotcha. |
| [`QVAC_FEEDBACK.md`](QVAC_FEEDBACK.md) | Field feedback for the QVAC/Tether team. |

## Privacy & safety

Medical data is OCR'd and reasoned over entirely on-device. The wallet skill is
**devnet only**, with a **mandatory voice-confirm gate** and no real funds; keys
never leave the machine. The agent narrates and previews every action before it acts.

---

*Veil is a hackathon project under active development; "Veil" is a placeholder name.*
