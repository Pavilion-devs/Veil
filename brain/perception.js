// perception.js — turn raw sensor data (AX tree + screenshot) into a grounded,
// actionable element list and the compact text the planner sees. Grounding is
// deterministic (ids/bounds come from the tree, never guessed). In Phase 2+ a
// doctr-OCR fallback fills regions with no AX coverage; Phase 1 has full AX.

const ACTIONABLE_ROLES = new Set([
  "button",
  "textfield",
  "textarea",
  "row",
  "menuitem",
  "checkbox",
  "link",
  "cell",
  "tab",
]);

// Build the grounded element list for one perceive step.
export async function perceive(hands) {
  const [rawTree, screen] = await Promise.all([
    hands.getAXTree(),
    hands.captureScreen(),
  ]);

  const elements = rawTree
    .filter((e) => e.enabled !== false)
    .filter((e) => ACTIONABLE_ROLES.has(e.role) || e.label || e.value)
    .map((e) => ({
      id: e.id,
      role: e.role,
      label: e.label ?? "",
      value: e.value ?? "",
      bounds: e.bounds ?? null,
      focused: !!e.focused,
    }));

  return { elements, screen };
}

// Compact, model-friendly rendering of the grounded screen for the prompt.
// One line per element: [id] role "label" = "value"  (focused)
export function renderScreen(elements) {
  if (!elements.length) return "On-screen elements: (none)";
  const lines = elements.map((e) => {
    const val = e.value ? ` = ${JSON.stringify(e.value.slice(0, 60))}` : "";
    const foc = e.focused ? "  (focused)" : "";
    return `  [${e.id}] ${e.role} ${JSON.stringify(e.label)}${val}${foc}`;
  });
  return `On-screen elements:\n${lines.join("\n")}`;
}

// Look up an element by id in a grounded list (for overlay bounds, validation).
export function findElement(elements, id) {
  return elements.find((e) => e.id === id) ?? null;
}
