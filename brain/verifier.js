// verifier.js — AX-diff first (PLAN §2 step 5, Decision §10.3). Compare the
// grounded screen before and after an action; a UI action that produced no
// observable change (or that the hands rejected) is a failure the orchestrator
// feeds back to the planner for a bounded replan. This is what makes the
// self-correction loop real rather than decorative.

function indexById(list) {
  const m = new Map();
  for (const e of list) m.set(e.id, e);
  return m;
}

// Structural diff of two grounded element lists.
export function diffTrees(pre, post) {
  const a = indexById(pre);
  const b = indexById(post);
  const added = [];
  const removed = [];
  const changed = [];
  for (const id of b.keys()) if (!a.has(id)) added.push(id);
  for (const id of a.keys()) {
    if (!b.has(id)) {
      removed.push(id);
      continue;
    }
    const x = a.get(id);
    const y = b.get(id);
    const fields = [];
    if (x.value !== y.value) fields.push("value");
    if (x.focused !== y.focused) fields.push("focused");
    if (x.label !== y.label) fields.push("label");
    if (fields.length) changed.push({ id, fields });
  }
  return { added, removed, changed };
}

export function isEmptyDiff(d) {
  return !d.added.length && !d.removed.length && !d.changed.length;
}

// Verify the effect of an action. Returns { ok, changed, diff, reason }.
export function verify({ action, pre, post, handsResult }) {
  const diff = diffTrees(pre, post);
  const changed = !isEmptyDiff(diff);

  // Hands explicitly rejected the command (e.g. unknown/hallucinated id).
  if (handsResult && handsResult.ok === false) {
    return { ok: false, changed, diff, reason: handsResult.reason || "hands rejected the action" };
  }

  // Actions we expect to visibly change the screen. scroll and a no-op key are
  // allowed to leave the AX tree untouched.
  const expectChange =
    ["click", "type", "open_app"].includes(action.action) ||
    (action.action === "key" && !handsResult?.noop);

  if (expectChange && !changed) {
    return { ok: false, changed, diff, reason: "action produced no observable change on screen" };
  }

  return {
    ok: true,
    changed,
    diff,
    reason: changed ? "state changed as expected" : "no change required",
  };
}
