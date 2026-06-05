# Veil — Brain ⇄ Eyes&Hands wire protocol

The contract between the **Node brain** (all QVAC inference + the agent loop) and
the **Swift "eyes & hands" app** (capture + Accessibility + actuation + mic +
overlay). Implements PLAN §3.2–§3.4. The Node reference implementation
(`ipc.js` + `handsServer.js`) is the executable spec — the Swift app must match
it byte-for-byte on the wire.

## Transport
- **Unix domain socket** (fallback: localhost TCP). Default path `/tmp/veil-hands.sock`.
- **Newline-delimited JSON** (`\n` after each message; one JSON object per line).
- UTF-8. No length prefix, no framing beyond the newline.

## Message shapes
```jsonc
// request  (caller → callee)
{ "id": 1, "method": "clickElement", "params": { "id": 1 } }
// response (callee → caller) — exactly one of result | error, echoing id
{ "id": 1, "result": { "ok": true } }
{ "id": 1, "error": { "message": "no element with id 99" } }
// event    (fire-and-forget, no id)
{ "event": "transcript", "data": { "text": "create a note" } }
```

## Who calls whom
Two role pairs share the one socket:

1. **Hands API** — the **brain is the client**, the **Swift app is the server**.
   The brain calls these; the Swift app implements them. **This is what the Swift
   app must build first** (it's all the brain needs to drive the computer).
2. **Brain API** — the reverse: on push-to-talk the Swift app calls `runTurn` on
   the brain, which streams back `transcript` / `step` / `speak` / `done` events.
   **Done + tested on the brain side** (see the Brain API section below).

## Hands API (Swift implements as server) — PLAN §3.2

| method | params | result |
|---|---|---|
| `captureScreen` | `{display?}` | `{pngPath, width, height, scale}` |
| `getAXTree` | `{appBundleId?, onscreenOnly?:true}` | `Element[]` (see below) |
| `clickElement` | `{id}` **or** `{x,y}` | `{ok, reason?}` |
| `type` | `{text}` | `{ok, reason?}` — types into the focused element |
| `key` | `{keys:"cmd+space"}` | `{ok, noop?}` |
| `scroll` | `{dx,dy}` | `{ok, noop?}` |
| `openApp` | `{name}` | `{ok, changed?}` |
| `showOverlay` | `{x,y,label}` | `{ok}` — animate cursor to (x,y) BEFORE the act |
| `playAudio` | `{wavPath}` **or** `{pcm}` | `{ok}` — brain & app share the filesystem |

### `Element` (grounded UI element)
```jsonc
{
  "id": 1,                                  // stable integer id the brain references
  "role": "button",                         // button|textfield|textarea|row|menuitem|checkbox|link|cell|tab|...
  "label": "New Note",                      // AX title / description
  "value": "",                              // AX value (e.g. a field's text)
  "bounds": { "x": 20, "y": 20, "w": 120, "h": 32 },  // logical points, top-left origin
  "enabled": true,
  "focused": false
}
```
Rules the brain relies on:
- **ids are stable within a perceive** and are what `clickElement {id}` / overlay
  target. Assign them deterministically from the AX tree; never reuse an id for a
  different element in the same snapshot.
- **`focused`** must be accurate — `type` goes to the focused element, and the
  brain decides whether to click a field first based on this flag.
- **`value`** changing (or rows added/removed, or `focused` flipping) is how the
  brain's verifier confirms an action had an effect (AX-diff). Report them faithfully.
- **`bounds` are logical points, top-left origin.** ⚠️ Actuation note for the
  Swift `Actuator`: CGEvent uses a top-left origin but AppKit is bottom-left —
  do the Y-flip in the app, and keep the points↔pixels (`scale`) math local to
  the app. The brain only ever speaks logical points.

## Behaviors the reference server encodes (match these)
- Unknown / off-screen `clickElement {id}` → `{ok:false, reason}` (don't throw).
- `type` with nothing focused → `{ok:false, reason}` (so the brain learns to click first).
- A no-op `key`/`scroll` → `{ok:true, noop:true}` (verifier won't demand a change).
- On a new connection, clear any stale socket file before `listen`.

## Brain API (Swift calls as client) — PLAN §3.3
Topology: the **app listens** and the **brain connects** (the brain is a launched
sidecar). On the same peer, the app calls these on the brain:

| method | params | result | notes |
|---|---|---|---|
| `runTurn` | `{command?, wavPath?, speak?}` | `{status, finalText, transcript, steps}` | one voice command → completed task. `command` OR `wavPath` (mic audio). Streams events meanwhile. `status` ∈ `done\|needs_user\|max_steps\|stuck\|cancelled\|busy`. |
| `cancel` | `{}` | `{ok, cancelling}` | aborts the in-flight turn between steps. |

One turn at a time: a second `runTurn` while one is running returns `{status:"busy"}`.

### Events streamed during a turn (brain → app)
```jsonc
{ "event": "transcript", "data": { "text": "create a new note" } }      // after STT
{ "event": "step", "data": { "i": 0, "action": {…Action…},              // before each UI act
                             "overlay": { "x": 80, "y": 36, "label": "click [1]" } } }
{ "event": "delegate", "data": { "to": "peer", "reason": "hard step" } } // P2P: routing a hard step to the peer
{ "event": "health", "data": { "flagged": ["…"], "analysis": "…" } }     // health skill result
{ "event": "speak", "data": { "text": "New note created." } }            // when the brain speaks
{ "event": "done",  "data": { "status": "done", "finalText": "…",        // turn end
                              "transcript": "…", "steps": 2 } }
```
The `delegate` event is the demo's "delegating to peer…" beat — show it while the
big model runs on the teammate's box. If the peer is down the turn still completes
(local fallback), so treat `delegate` as informational, not blocking.
The Swift UI should: show `transcript` as the heard text; on each `step`, animate
the cursor to `overlay.{x,y}` (logical points) and label it; play TTS / show
captions on `speak`; settle on `done`. `action` is the planner's Action object
(PLAN §3.1) — `{thought, action, targetId?, text?, keys?}`.

### Streaming mic input (push-to-talk)
Call `runTurn` with `{audio:true}` (no `command`/`wavPath`). Handshake:
1. App → brain: `runTurn {audio:true}` request (resolves at turn end).
2. Brain → app: `{event:"listening"}` — the STT session is open; start capturing.
3. App → brain: `{event:"audio", data:{pcm:"<base64>"}}` frames, then `{event:"audioEnd"}`.
4. Brain → app: `{event:"partial", data:{text}}` per VAD segment, then the normal
   `transcript` → `step…` → `done` stream.

**PCM format: signed 16-bit little-endian, 16 kHz, mono** (`s16le`/16000/1),
base64-encoded per frame (~100 ms/frame is fine). The Swift app downsamples mic
audio to 16 kHz mono PCM16 and base64s each frame. (Whisper tiny.en + Silero VAD;
real speech transcribes well — synthetic TTS is the weak input, not the path.)
`cancel` mid-capture ends the utterance and unwinds the turn.

### Run the full reference (both directions, no Swift needed)
```bash
node refApp.js          # terminal 1: app = listens + serves Hands API + drives runTurn from stdin
node brainMain.js       # terminal 2: brain = connects, holds QVAC, serves runTurn/cancel, streams events
> create a new note     # type into terminal 1 (simulates push-to-talk); watch events stream back
node brainApiAcceptance.js   # automated: event stream + cancel over a real socket (2/2)
```
When the app disconnects (user quits), the brain auto-shuts-down the QVAC worker
cleanly — no stale lock. The Swift app replaces `refApp.js`; `brainMain.js` is the
real brain entrypoint and does not change.

## Test your Swift server against the real brain
The brain side is done and tested. Point it at your server:
```bash
# your Swift app listens on /tmp/veil-hands.sock, then:
cd brain && node runTurn.js --socket /tmp/veil-hands.sock "create a new note"
```
Or compare against the Node reference server:
```bash
node handsServer.js                       # reference Notes fixture on the socket
node runTurn.js --socket /tmp/veil-hands.sock "create a new note"   # other terminal
node ipcAcceptance.js                     # full loop over the socket, 3/3 must pass
```
If `runTurn --socket` drives your Swift app through `click(New Note) → done`, the
protocol is correct and your app drops straight into the loop.
