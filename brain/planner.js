// planner.js — the decision step. Build the prompt from the grounded screen +
// command + short history, call the planner LLM with a grammar-constrained
// json_schema action, then validate/repair. Spike lesson: make targetId
// effectively required for click so grammar always grounds the target; we
// enforce it here and self-repair once before deferring to the verify loop.
import { completion } from "@qvac/sdk";

// Action schema (PLAN §3.1). Phase 1 covers the computer-use core; health/
// wallet actions land in Phase 4 and are intentionally absent from the enum so
// the small model can't wander off-task in the Notes demo.
export const ACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thought: { type: "string" },
    action: {
      type: "string",
      enum: ["click", "type", "key", "scroll", "open_app", "query_health", "speak", "ask_user", "done"],
    },
    targetId: { type: "integer" },
    text: { type: "string" },
    keys: { type: "string" },
  },
  required: ["thought", "action"],
};

export const SYSTEM_PROMPT = [
  "You are Veil, a macOS computer-use agent. You operate the Mac by choosing ONE next action per step.",
  "Each step you are given the on-screen UI elements (integer id, role, label, current value) and the user's command, plus the result of your previous action.",
  "Respond with a SINGLE JSON action object and nothing else.",
  "",
  "Actions:",
  '  click      — click an element. Set "targetId" to an EXISTING on-screen id. Never invent ids.',
  '  type       — type "text" into the focused field. ONLY the element marked (focused) receives text.',
  "               If no element is focused, or the focused one is the wrong field, CLICK the target field first.",
  '  key        — press a key combo in "keys" (e.g. "cmd+n").',
  "  scroll     — scroll the current view.",
  '  open_app   — open the app named in "text".',
  "  query_health — read the lab/health document currently on screen and flag anything concerning.",
  "               Use this when the user asks about their labs, results, or health and a document is visible.",
  '  speak      — say "text" to the user (no UI change).',
  '  ask_user   — ask a clarifying question in "text" when the command is ambiguous.',
  '  done       — the task is fully complete. Put a short spoken confirmation in "text".',
  "",
  "Rules:",
  "  - Pick the single best next action toward completing the command.",
  "  - Keep \"thought\" to one short sentence.",
  "  - Only reference element ids that appear in the current on-screen list.",
  "  - Return action \"done\" (with a brief \"text\" confirmation) AS SOON AS the command is satisfied.",
  "  - NEVER repeat an action you already completed successfully — if it is already done, return \"done\".",
].join("\n");

function parseAction(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Grammar should give pure JSON, but be defensive: grab the first object.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Validate an action against the current grounded screen. Returns
// { valid, reason }. Enforces the spike's "targetId required for click" lesson.
export function validateAction(a, elements) {
  if (!a || typeof a !== "object") return { valid: false, reason: "action was not a JSON object" };
  const ids = new Set(elements.map((e) => e.id));
  const idList = [...ids].join(", ");
  switch (a.action) {
    case "click":
      if (!Number.isInteger(a.targetId) || !ids.has(a.targetId))
        return { valid: false, reason: `click requires a valid targetId from the on-screen ids [${idList}]` };
      return { valid: true };
    case "type":
      if (!a.text) return { valid: false, reason: "type requires non-empty 'text'" };
      return { valid: true };
    case "key":
      if (!a.keys) return { valid: false, reason: "key requires a 'keys' combo such as cmd+n" };
      return { valid: true };
    case "open_app":
      if (!a.text) return { valid: false, reason: "open_app requires an app name in 'text'" };
      return { valid: true };
    case "speak":
      if (!a.text) return { valid: false, reason: "speak requires 'text'" };
      return { valid: true };
    case "ask_user":
      if (!a.text) return { valid: false, reason: "ask_user requires a question in 'text'" };
      return { valid: true };
    case "scroll":
    case "query_health":
    case "done":
      return { valid: true };
    default:
      return { valid: false, reason: `unknown action "${a.action}"` };
  }
}

async function complete(modelId, messages) {
  const r = completion({
    modelId,
    history: messages,
    stream: false,
    responseFormat: { type: "json_schema", json_schema: { name: "agent_action", schema: ACTION_SCHEMA } },
  });
  const final = await (r.final ?? r);
  const text = final.contentText ?? final.text ?? (await r.text);
  return text;
}

// Decide the next action. `messages` is the running planner conversation
// (system + alternating screen/feedback turns) maintained by the orchestrator.
// `role` selects the model tier: "planner" (local) or a delegated big planner
// for hard steps routed to a P2P peer. Returns { action, valid, reason, raw, repaired }.
export async function plan({ qvac, messages, elements, log = () => {}, role = "planner" }) {
  const modelId = await qvac.get(role);

  const t0 = Date.now();
  let raw = await complete(modelId, messages);
  let action = parseAction(raw);
  let { valid, reason } = validateAction(action, elements);
  let repaired = false;

  // One inline self-repair: tell the model exactly what was wrong and retry,
  // before falling back to the verify/replan loop.
  if (!valid) {
    log({ phase: "plan", msg: "invalid action, repairing", reason, raw });
    const repairMsgs = [
      ...messages,
      { role: "assistant", content: raw ?? "" },
      {
        role: "user",
        content: `That action was invalid: ${reason}. Reply with a corrected single JSON action object.`,
      },
    ];
    raw = await complete(modelId, repairMsgs);
    action = parseAction(raw);
    ({ valid, reason } = validateAction(action, elements));
    repaired = true;
  }

  log({ phase: "plan", msg: "planned", ms: Date.now() - t0, action, valid, reason, repaired });
  return { action, valid, reason, raw, repaired };
}
