// orchestrator.js — one voice command -> completed task. Runs the agent loop
// (PLAN §2): perceive -> plan -> show -> act -> verify, with bounded replanning
// driven by the verifier's AX-diff. Model-agnostic above the Hands API, so the
// same loop runs against MockHands now and the real Swift app later.
import path from "node:path";
import { perceive, renderScreen, findElement } from "./perception.js";
import { plan, validateAction, SYSTEM_PROMPT } from "./planner.js";
import { execute, isUiAction } from "./executor.js";
import { verify } from "./verifier.js";
import { stt, tts } from "./voice.js";

function describeAction(a) {
  switch (a.action) {
    case "click":
      return `click [${a.targetId}]`;
    case "type":
      return `type ${JSON.stringify(a.text)}`;
    case "key":
      return `key ${a.keys}`;
    case "open_app":
      return `open_app ${JSON.stringify(a.text)}`;
    case "scroll":
      return "scroll";
    case "speak":
      return `speak ${JSON.stringify(a.text)}`;
    case "ask_user":
      return `ask_user ${JSON.stringify(a.text)}`;
    case "done":
      return `done ${a.text ? JSON.stringify(a.text) : ""}`.trim();
    default:
      return a.action;
  }
}

const summarizeDiff = (d) => `+${d.added.length} -${d.removed.length} ~${d.changed.length}`;

// Run one full turn. Returns { transcript, status, finalText, steps, ttsWavPath }.
export async function runTurn({
  qvac,
  hands,
  logger,
  command,
  wavPath,
  maxSteps = 8,
  maxFailures = 3,
  injectFirstAction = null,
  speak = true,
  ttsDir,
  onEvent = () => {}, // Brain API stream (§3.3): transcript | step | speak | done
  cancelToken = { cancelled: false }, // set .cancelled to abort between steps
}) {
  ttsDir = ttsDir ?? path.dirname(logger.file);

  // --- 1. transcript (STT if a wav was given, else the typed command) ---
  let transcript = command ?? "";
  if (wavPath) {
    const r = await stt(qvac, wavPath);
    transcript = r.text;
    logger.log({ phase: "stt", msg: "transcribed", wavPath, transcript, ms: r.ms });
  }
  logger.log({ phase: "turn", msg: "start", transcript });
  onEvent({ event: "transcript", data: { text: transcript } });

  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  const steps = [];
  const recent = []; // action descriptions, for loop detection
  let pendingFeedback = `User command: "${transcript}"`;
  let failures = 0;
  let status = "max_steps";
  let finalText = "";
  let ttsSeq = 0;

  const say = async (text) => {
    if (!text) return null;
    onEvent({ event: "speak", data: { text } });
    if (!speak) return null;
    const out = path.join(ttsDir, `turn-${logger.turn}-spk-${ttsSeq++}.wav`);
    const r = await tts(qvac, text, out);
    if (r.wavPath) await hands.playAudio({ wavPath: r.wavPath });
    logger.log({ phase: "tts", msg: "spoke", text, wavPath: r.wavPath, samples: r.samples, ms: r.ms });
    return r.wavPath;
  };

  for (let i = 0; i < maxSteps; i++) {
    // --- 0. cancel check (Brain API cancel arrives between steps) ---
    if (cancelToken.cancelled) {
      status = "cancelled";
      logger.log({ phase: "turn", msg: "cancelled", atStep: i });
      break;
    }

    // --- 2. perceive ---
    const { elements } = await perceive(hands);
    const userMsg = `${renderScreen(elements)}\n\n${pendingFeedback}\n\nReply with the next action.`;
    messages.push({ role: "user", content: userMsg });

    // --- 3. plan (or inject a scripted first action for the self-correction test) ---
    let action;
    let valid;
    let reason;
    let raw;
    if (i === 0 && injectFirstAction) {
      action = injectFirstAction;
      ({ valid, reason } = validateAction(action, elements));
      raw = JSON.stringify(action);
      logger.log({ phase: "plan", msg: "injected first action", action });
    } else {
      ({ action, valid, reason, raw } = await plan({
        qvac,
        messages,
        elements,
        log: (o) => logger.log(o),
      }));
    }
    messages.push({ role: "assistant", content: raw ?? JSON.stringify(action) });

    const step = { i, action, valid, reason };
    logger.log({ phase: "step", msg: "decided", i, action: describeAction(action || {}), valid, reason });

    // --- loop guard: stop if the same action repeats 3× in a row (a small model
    // can get stuck re-issuing a step that "succeeds" but never finishes the task). ---
    const desc = describeAction(action || {});
    if (action && action.action !== "done") {
      recent.push(desc);
      const n = recent.length;
      if (n >= 3 && recent[n - 1] === recent[n - 2] && recent[n - 2] === recent[n - 3]) {
        status = "stuck";
        step.outcome = "loop";
        steps.push(step);
        logger.log({ phase: "turn", msg: "loop detected, stopping", action: desc });
        await say("I seem to be repeating myself, so I stopped.");
        break;
      }
    }

    // --- invalid action -> feed back, replan ---
    if (!valid) {
      failures++;
      pendingFeedback = `Your previous reply was invalid: ${reason}. Choose a valid action.`;
      step.outcome = "invalid";
      steps.push(step);
      if (failures > maxFailures) {
        status = "stuck";
        break;
      }
      continue;
    }

    // --- terminal / speech actions ---
    if (action.action === "done") {
      finalText = action.text || "Done.";
      status = "done";
      step.outcome = "done";
      steps.push(step);
      await say(finalText);
      logger.log({ phase: "turn", msg: "done", finalText, steps: i + 1 });
      break;
    }
    if (action.action === "ask_user") {
      finalText = action.text;
      status = "needs_user";
      step.outcome = "ask_user";
      steps.push(step);
      await say(finalText);
      logger.log({ phase: "turn", msg: "needs_user", question: finalText });
      break;
    }
    if (action.action === "speak") {
      await say(action.text);
      pendingFeedback = `You said: "${action.text}". Now continue the task, or return "done" if it is complete.`;
      step.outcome = "spoke";
      steps.push(step);
      continue;
    }

    // --- 4. show overlay before acting (transparency + demo). Emit the Brain
    // API `step` event (action + overlay) so the Swift UI can animate. ---
    if (isUiAction(action)) {
      const target =
        (action.targetId != null && findElement(elements, action.targetId)) ||
        elements.find((e) => e.focused) ||
        null;
      const overlay = target?.bounds
        ? {
            x: target.bounds.x + target.bounds.w / 2,
            y: target.bounds.y + target.bounds.h / 2,
            label: describeAction(action),
          }
        : null;
      onEvent({ event: "step", data: { i, action, overlay } });
      if (overlay) await hands.showOverlay(overlay);
    }

    // --- 5. act ---
    const pre = elements;
    const handsResult = await execute({ hands, action });

    // --- 5b. verify (re-perceive + AX-diff) ---
    const { elements: post } = await perceive(hands);
    const v = verify({ action, pre, post, handsResult });
    step.verify = { ok: v.ok, reason: v.reason, diff: summarizeDiff(v.diff) };
    logger.log({
      phase: "verify",
      msg: v.ok ? "ok" : "failed",
      i,
      action: describeAction(action),
      reason: v.reason,
      diff: v.diff,
    });

    if (!v.ok) {
      failures++;
      pendingFeedback =
        `Your last action (${describeAction(action)}) had no effect: ${v.reason}. ` +
        `The screen did not change. Pick a different action or a different targetId.`;
      step.outcome = "no_effect";
      steps.push(step);
      if (failures > maxFailures) {
        status = "stuck";
        break;
      }
      continue;
    }

    // success -> reset failure streak, report progress, continue planning
    failures = 0;
    const typedNote =
      action.action === "type" ? ` The text ${JSON.stringify(action.text)} now appears in the focused field.` : "";
    pendingFeedback =
      `Your last action (${describeAction(action)}) succeeded (AX-diff ${summarizeDiff(v.diff)}).${typedNote} ` +
      `If the user's command is now fully satisfied, return action "done" with a brief confirmation. ` +
      `Do NOT repeat an action you already completed. Otherwise take the next step.`;
    step.outcome = "ok";
    steps.push(step);
  }

  if (status === "max_steps") {
    finalText = "I couldn't complete that within the step limit.";
    await say(finalText);
    logger.log({ phase: "turn", msg: "max_steps" });
  }
  if (status === "stuck") {
    finalText = "I got stuck and stopped to avoid repeating a failing action.";
    await say(finalText);
    logger.log({ phase: "turn", msg: "stuck" });
  }
  if (status === "cancelled") {
    finalText = "Cancelled.";
  }

  onEvent({ event: "done", data: { status, finalText, transcript, steps: steps.length } });
  return { transcript, status, finalText, steps, ttsWavPath: ttsSeq ? path.join(ttsDir, `turn-${logger.turn}-spk-0.wav`) : null };
}

export { describeAction };
