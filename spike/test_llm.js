// TEST A — the make-or-break test.
// Can a small local QVAC LLM reliably act as our computer-use PLANNER:
//   (1) call a tool given a grounded element list, and
//   (2) emit a grammar-constrained JSON action (guaranteed-valid)?
import { loadModel, completion, unloadModel, QWEN3_4B_INST_Q4_K_M } from "@qvac/sdk";

const mb = (b) => (b / 1024 / 1024).toFixed(0);
const rss = () => mb(process.memoryUsage().rss);
const now = () => Date.now();

// A simulated "grounded screen" — exactly what our AX-tree + OCR layer would feed the model.
const ELEMENTS = [
  { id: 1, role: "button", label: "New Note" },
  { id: 2, role: "textfield", label: "Search" },
  { id: 3, role: "button", label: "Delete" },
  { id: 4, role: "menuitem", label: "File" },
  { id: 5, role: "button", label: "Send" },
];
const SYS =
  "You are a macOS computer-use agent. You are given a list of on-screen UI elements " +
  "(each with an integer id, a role, and a label) and a user command. " +
  "Pick the single best element to act on and the action to take. Never invent element ids.";
const screen = `On-screen elements:\n${ELEMENTS.map((e) => `  [${e.id}] ${e.role} "${e.label}"`).join("\n")}`;

console.log(`[${rss()}MB] start. loading QWEN3_4B_INST_Q4_K_M (downloads ~2.5GB on first run)...`);
let t = now();
let lastPct = -10;
const modelId = await loadModel({
  modelSrc: QWEN3_4B_INST_Q4_K_M,
  modelType: "llm",
  modelConfig: { ctx_size: 4096, device: "gpu", tools: true },
  onProgress: (p) => {
    const pct = Math.floor(p?.percentage ?? 0);
    if (pct >= lastPct + 10) { lastPct = pct; console.log(`  download ${pct}%`); }
  },
});
const loadMs = now() - t;
console.log(`[${rss()}MB] loaded in ${(loadMs / 1000).toFixed(1)}s (incl. any download). modelId=${modelId}`);

// ---- (1) TOOL CALLING ----
const tools = [
  { name: "click_element", description: "Click a UI element by its id",
    parameters: { type: "object", properties: { elementId: { type: "integer" } }, required: ["elementId"] } },
  { name: "type_text", description: "Type text into the focused field",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
];
async function runToolTest(cmd) {
  const history = [
    { role: "system", content: SYS },
    { role: "user", content: `${screen}\n\nUser command: "${cmd}"` },
  ];
  const t0 = now();
  const r = completion({ modelId, history, tools, stream: false });
  const final = await (r.final ?? r);
  const ms = now() - t0;
  const calls = final.toolCalls ?? (await r.toolCalls) ?? [];
  console.log(`  TOOL  "${cmd}" -> ${ms}ms :: ${JSON.stringify(calls.map((c) => ({ name: c.name, args: c.arguments })))}`);
  return { ms, calls };
}

// ---- (2) GRAMMAR-CONSTRAINED JSON ACTION (our real action schema) ----
const actionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["click", "type", "scroll", "done"] },
    elementId: { type: "integer" },
    text: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action", "reason"],
};
async function runJsonTest(cmd) {
  const history = [
    { role: "system", content: SYS + " Respond ONLY with the action object." },
    { role: "user", content: `${screen}\n\nUser command: "${cmd}"` },
  ];
  const t0 = now();
  const r = completion({
    modelId, history, stream: false,
    responseFormat: { type: "json_schema", json_schema: { name: "agent_action", schema: actionSchema } },
  });
  const final = await (r.final ?? r);
  const ms = now() - t0;
  const text = final.contentText ?? final.text ?? (await r.text);
  let ok = false, parsed = null;
  try { parsed = JSON.parse(text); ok = true; } catch {}
  console.log(`  JSON  "${cmd}" -> ${ms}ms :: valid=${ok} :: ${ok ? JSON.stringify(parsed) : text?.slice(0, 200)}`);
  return { ms, ok, parsed };
}

console.log("\n--- TOOL CALLING ---");
for (const cmd of ["create a new note", "delete this", "search for groceries", "send the message"]) {
  try { await runToolTest(cmd); } catch (e) { console.log(`  TOOL "${cmd}" ERROR: ${e.message}`); }
}

console.log("\n--- GRAMMAR-CONSTRAINED JSON ACTION ---");
let okCount = 0, total = 0;
for (const cmd of ["create a new note", "delete this", "search for groceries", "send the message", "open the File menu"]) {
  total++;
  try { const r = await runJsonTest(cmd); if (r.ok) okCount++; } catch (e) { console.log(`  JSON "${cmd}" ERROR: ${e.message}`); }
}

console.log(`\n[${rss()}MB] SUMMARY: json valid ${okCount}/${total}; model load ${(loadMs / 1000).toFixed(1)}s`);
await unloadModel(modelId);
console.log(`[${rss()}MB] unloaded. done.`);
