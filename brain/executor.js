// executor.js — turn a validated UI Action into Hands command(s). Speech-only
// actions (speak / ask_user / done) are handled by the orchestrator via voice;
// the executor covers the actions that touch the screen.
export async function execute({ hands, action }) {
  switch (action.action) {
    case "click":
      return hands.clickElement({ id: action.targetId });
    case "type":
      return hands.type({ text: action.text });
    case "key":
      return hands.key({ keys: action.keys });
    case "scroll":
      return hands.scroll({ dx: 0, dy: 300 });
    case "open_app":
      return hands.openApp({ name: action.text });
    default:
      // Non-UI action — nothing for the hands to do.
      return { ok: true, ui: false };
  }
}

// Does this action touch the screen (and therefore go through the executor)?
export function isUiAction(action) {
  return ["click", "type", "key", "scroll", "open_app"].includes(action.action);
}
