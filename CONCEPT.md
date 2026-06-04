# Veil — The Offline AI That *Runs* Your Computer

> **Working name:** Veil *(placeholder — "a privacy veil over your screen")*
> **Built for:** QVAC Hackathon I — "Unleash Edge AI" (Tether), June 1–21, 2026
> **Track:** General Purpose (≤32 GB) **+** Our Psy Models (MedPsy)
> **Core idea:** A voice-driven computer-use agent powered by **tiered private intelligence** — small model on your device, big model on a nearby peer, **cloud never.**
> **Status:** Concept locked, day-1 feasibility spike next.

---

## TL;DR (read this if nothing else)

**Veil is a voice-driven AI agent that watches your screen and actually operates your computer for you — clicking, typing, filling forms, reading documents — and it does 100% of its thinking *on your hardware*. No cloud. No server. Nothing you see or say ever leaves your devices. It works in airplane mode.**

Today's "computer-use" agents (Claude Computer Use, OpenAI Operator, the viral `clicky` app) are powerful but share one fatal flaw: **they ship your entire screen to a datacenter.** A screen agent sees *everything* — your bank, your DMs, your medical portal, your seed phrase. That's the most privacy-invasive software a person can run, and right now the only versions that exist send it all to the cloud.

**We flip that.** Veil is the first truly *local* computer-use agent. The most powerful and most dangerous category of AI — made completely private. That is QVAC's entire reason to exist, demonstrated in one product.

---

## The pitch in one breath

> "Computer-use agents are the most powerful AI there is — and the most dangerous, because they see your whole screen. So we built one where your screen never leaves your machines. No cloud. Works on a plane. And it doesn't just *point* — it *acts*. When a task is too heavy for one device, it borrows the brain of the laptop next to it — still private, still no internet. Watch me run my computer, read my medical records, and move my money, with my voice and nothing on the cloud."

---

## Tiered private intelligence (the heart of it)

This is the part that makes Veil both *work* and *win*, and it's built on QVAC's flagship feature: **peer-to-peer delegated inference.**

```
  YOU (voice)
     │
     ▼
  ┌─────────────────────────────────────────────┐
  │  YOUR MAC  —  small, fast model              │
  │  • perception (screen + voice)               │
  │  • simple actions, instant response          │
  └───────────────┬─────────────────────────────┘
                  │  hard step? (complex plan,
                  │  clinical reasoning, tough call)
                  ▼
  ┌─────────────────────────────────────────────┐
  │  PEER DEVICE  —  big, powerful model          │
  │  • runs the heavy reasoning                   │
  │  • encrypted P2P, NEVER the cloud             │
  └─────────────────────────────────────────────┘
                  │  peer offline? → falls back to local automatically
                  ▼
              ACTION on your screen
```

A weak device borrows a strong device's brain — **privately, over an encrypted peer-to-peer link, with the cloud never in the loop.** This is QVAC's signature capability, and we put it at the center instead of the edge. It's also a **heavily-weighted judging criterion** ("Performance: P2P load distribution").

**Crucially, P2P is an *amplifier*, never a dependency.** Veil runs fully standalone on a single Mac; the peer makes it smarter when available, and if the peer drops mid-task it **gracefully falls back to the local model.** That resilience is itself a feature we show off.

---

## "But aren't on-device models weak?" — Yes. And that's exactly the game.

Every team in this hackathon is *required* to use QVAC's small on-device models. So model quality isn't something we compete on — it's a **constant for everyone.** The only variable is **engineering.** The judges literally ask for *"novel ways to make small models useful through clever prompting, RAG, and tool use."* **The team that makes weak models reliable wins.** That's the whole contest, and it's what we're built for. Five ways we beat the weak-model problem:

1. **Deterministic grounding.** The model never guesses where to click — coordinates come from the macOS Accessibility tree + OCR boxes (see "secret sauce"). Where most agents fail, the model isn't even involved.
2. **Grammar-constrained actions.** Output is forced into a strict JSON schema — a dumb model still *can't* emit an invalid action.
3. **A self-verifying loop.** Every action is checked and retried, turning an unreliable per-step model into a reliable system.
4. **Bigger models when the hardware allows.** QVAC can load models beyond its default set — so we run a substantially larger model locally than the tiny defaults, and an even larger one on a peer.
5. **Tiered intelligence (above).** The genuinely hard reasoning offloads to a powerful peer. *The weak-model problem becomes the showcase for QVAC's best feature.*

---

## Why this is different from every other "personal AI"

| Other personal AI | **Veil** |
|---|---|
| Chats in a box; you do the work | **Acts on your behalf** — clicks, types, navigates real apps |
| Sends your data to the cloud | **100% on your own devices** — airplane-mode proof |
| Screen agents (clicky, Operator) stream your screen to a server | **Your screen never leaves your machines** |
| `clicky` only *points* at things | Veil **actually performs** the action |
| One model on one device, take it or leave it | **Tiered:** small-local + big-peer, encrypted P2P, never cloud |
| Generic assistant | **Sovereign** — your health data and your crypto keys stay yours |
| One model, one prompt | A **multi-agent system** that plans, acts, and verifies itself |

The headline isn't "another AI assistant." It's: **the one category of AI that absolutely *must* be private, finally made private — and made smart by pooling your own devices instead of a datacenter.**

---

## The secret sauce (why it actually works — our technical edge)

Small local models are weak at reading a screenshot and guessing where to click. Most teams will throw a screenshot at a vision model and watch it miss. **We never let the model guess coordinates.**

1. **OS-grounded perception.** We read the macOS **Accessibility tree** — every button, field, and menu exposes its exact label, role, and pixel bounds, deterministically. We combine that with **QVAC's OCR** (which returns text + bounding boxes). The agent gets a precise, real map of what's clickable — no hallucinated coordinates.
2. **The model only chooses + reasons.** Given that grounded map, the local LLM picks the right element and emits an action under a **strict JSON schema** (grammar-enforced — output is guaranteed valid). This is what makes a small on-device model reliable at computer use.
3. **A self-verifying loop.** `Perceive → Plan → Show → Act → Verify`. After every action the agent re-reads the screen and a vision model confirms the expected thing happened — if not, it re-plans.
4. **Tiered routing.** The planner decides per-step whether it's a "local-fast" job or a "delegate-to-peer" job, and routes accordingly (with automatic local fallback).

That AX-tree-first + OCR + verify + P2P-tiering architecture is genuinely novel and reads as **research-grade**, not a weekend hack.

---

## What it can do (the hero skills)

All private. All on your own devices. Cloud never.

- 🖥️ **Run your computer by voice.** "Open Notes and write up today's standup." It finds the app, opens it, and types — showing you each move before it makes it.
- 🩺 **Private health intelligence (MedPsy).** "Open my latest lab results and flag anything concerning." It OCRs your labs, reasons with **Tether's MedPsy** model, and explains it in plain language — *your medical data never touches a server.* (This wins us the dedicated **Psy Models** prize track too.)
- 💸 **Sovereign money agent.** "Send 50 USDt to Alex." It fills the wallet form by grounding on the real UI, asks for a **spoken confirmation**, then sends — *your keys never leave the device.* Dead-center on Tether's roadmap. (Demoed on testnet, with a confirm-gate, for safety.)
- 🔗 **Peer-powered brain (core).** When a task is too heavy for the Mac alone, it offloads the hard reasoning to a teammate's machine over QVAC's encrypted P2P — *the weak device borrows the strong device's brain, with the cloud never involved.* You literally see it light up "delegating to peer…" mid-task.
- 🧠 **Learns you, locally (stretch).** On-device LoRA fine-tuning means it can adapt to *your* apps and habits overnight, without a single byte of training data leaving the Mac.

---

## Spin-off potential (why this is bigger than a hackathon)

- **Accessibility superpower.** A fully-private, voice-driven computer operator is life-changing for blind, motor-impaired, and elderly users — and it works without a network.
- **Enterprise / regulated work.** Law firms, clinics, journalists, finance — anyone who legally *cannot* send their screen to a cloud — get an agent that automates real workflows on-prem by construction.
- **Offline-first / field use.** Disaster zones, flights, ships, rural and low-connectivity regions — the agent keeps working when the internet doesn't.
- **Home compute mesh.** Your phone, laptop, and desktop pool into one private brain — the household as its own little AI cluster, no subscription, no cloud. (This is the tiered-intelligence idea taken to its natural end.)
- **The sovereign agent economy.** An on-device agent that holds keys and transacts in USDt/BTC is the seed of "agents that act in the world on your behalf, without a custodian." Exactly Tether's thesis.
- **Personal automation OS.** Long-term, Veil becomes a local layer that automates anything you can see on a screen — the private alternative to cloud RPA and cloud agents.

---

## Why it wins the hackathon (rubric fit)

The judging criteria reward exactly what this is:

- **Real-time local inference + P2P delegation** → our core "tiered intelligence" pillar. ✓✓ *(a named GP focus area)*
- **Performance / P2P load distribution** → small-local + big-peer routing with fallback. ✓✓ *(heavily weighted)*
- **Multi-agent orchestration + tool calling** → every action is a tool; planner/executor/verifier loop. ✓✓
- **Multimodal (vision + text + audio)** → screen + voice + speech. ✓
- **Advanced RAG** → health records corpus. ✓
- **Creative use of Psy models** → MedPsy hero skill → also enters the **Psy track**. ✓
- **Privacy-first, production-grade, real consumer hardware** → the entire thesis, on real devices. ✓✓✓
- **Artifact quality** → the self-verifying loop emits clean structured logs for free. ✓

One project → **General Purpose track + Our Psy track + a shot at the global prize.** Targeting the **Early-Bird bonus (submit before June 17)**.

---

## How it's built (at a glance)

- **Swift "eyes & hands" app** (macOS menu-bar) — screen capture (ScreenCaptureKit), Accessibility-tree reader, real actuation (CGEvent / Accessibility actions), push-to-talk, and an overlay that *shows* each action before it fires. *(We bootstrap from the open-source `clicky` app, MIT-licensed, and rip out all its cloud.)*
- **Node "brain"** using the **QVAC SDK** for **all** intelligence — speech-to-text, OCR, the planner/verifier LLM with tool calling, vision verification, MedPsy reasoning, RAG, text-to-speech, **and P2P delegation to a peer**. *(This is what satisfies the "QVAC for all AI inference" requirement.)*
- **Peer node** (teammate's machine) runs a QVAC provider hosting the big model; the Mac delegates hard steps to it over encrypted P2P.
- The Swift and Node sides talk over a local socket. **Every byte of AI runs on our own hardware via Metal — never the cloud.**

**Model stack (all local/peer, all QVAC):** a larger Qwen3 (planning + tool calls, local) with an even larger model on the peer, Qwen3-VL (visual verify), QVAC OCR (clickable text boxes), Parakeet/Whisper (speech-in), Supertonic (speech-out), MedPsy (health), GTE-Large + SQLite-vector (RAG). *Exact sizes locked after the day-1 spike measures real speed + memory on the M4 Pro.*

---

## The demo (90 seconds, airplane mode ON the whole time)

1. **Turn off Wi-Fi on camera.** "Nothing leaves these machines."
2. **Computer-use proof:** voice command → it opens an app and types, showing each move.
3. **Peer offload (the QVAC money shot):** a heavy request → screen shows "*delegating to peer…*" → the big model on the teammate's laptop does the thinking → answer comes back → **internet still off.**
4. **Health hero:** "Read my labs and flag anything concerning." → OCR → MedPsy → spoken explanation.
5. **Money mic-drop (stretch):** "Send 50 USDt to Alex." → fills form → spoken confirm → sent. Keys never left the device.

---

## Where we are / what's next

- ✅ Concept locked; both QVAC SDK and `clicky` codebases reconnoitered (real APIs confirmed — incl. P2P `startQVACProvider` / `delegate` with `fallbackToLocal`).
- ✅ Hardware ready: Apple M4 Pro, 24 GB, Metal, Node 24, Xcode 26. (Peer = teammate's machine.)
- ▶️ **Next:** Day-1 feasibility spike — prove the riskiest pieces run locally with real latency/memory numbers (tool-calling LLM, OCR-with-boxes, MedPsy, STT+TTS, **and a P2P delegate round-trip between two machines**) *before* writing app code.
- 🎯 Deadline: **June 17** (early-bird) / June 21 (final).

---

*One line for the teammate: we're building the first computer-use AI agent that runs entirely on our own devices — it operates your Mac by voice, and when a task is too heavy it borrows a nearby machine's brain over QVAC's encrypted peer-to-peer (never the cloud). It handles your most sensitive stuff (health + money) and proves it by working with the internet switched off. QVAC's P2P makes weak local models strong; nobody else has shipped this.*
