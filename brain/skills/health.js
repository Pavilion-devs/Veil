// skills/health.js — the hero "health" skill (PLAN §7). Read a lab document and
// flag anything concerning, fully on-device:
//   doctr OCR (image -> text, reading-order reconstructed from bboxes)
//     -> MedPsy-4B clinical reasoning
//     -> concise spoken summary.
// Medical data never leaves the machine. Educational, not a diagnosis.
import { completion, ocr } from "@qvac/sdk";

const SYSTEM_PROMPT =
  "You are a careful medical-education assistant — NOT a diagnosis. Given lab results, " +
  "flag which values are abnormal and explain, in plain language a patient can understand, " +
  "what they may indicate and what to discuss with a clinician. Be concise (3–5 sentences). " +
  "Do not over-diagnose; group related findings; always advise following up with a clinician.";

// MedPsy is a reasoning model and emits a <think>…</think> block inline in the
// content — strip it so we never TTS the chain-of-thought to the user.
function stripThinking(s) {
  return String(s ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

// Reconstruct human reading order from doctr blocks ({text, bbox:[x1,y1,x2,y2]}).
// doctr returns blocks unordered (often reversed per line); sort top-to-bottom,
// cluster into lines by vertical overlap, then left-to-right within each line.
export function blocksToText(blocks) {
  const items = blocks
    .filter((b) => b.text?.trim() && Array.isArray(b.bbox))
    .map((b) => {
      const [x1, y1, x2, y2] = b.bbox;
      return { t: b.text.trim(), x: x1, y: (y1 + y2) / 2, h: Math.abs(y2 - y1) };
    });
  items.sort((a, b) => a.y - b.y);
  const lines = [];
  for (const it of items) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - it.y) <= Math.max(10, it.h * 0.7)) {
      L.items.push(it);
      L.y = (L.y * (L.items.length - 1) + it.y) / L.items.length;
    } else {
      lines.push({ y: it.y, items: [it] });
    }
  }
  return lines
    .map((L) => L.items.sort((a, b) => a.x - b.x).map((i) => i.t).join(" "))
    .join("\n");
}

// OCR an image to reading-order text.
export async function ocrImage(qvac, imagePath) {
  const modelId = await qvac.get("ocr");
  const { blocks } = ocr({ modelId, image: imagePath });
  const out = await blocks;
  return { text: blocksToText(out), blocks: out.length };
}

// Deterministic pre-pass: pull the lines the lab itself flagged HIGH/LOW.
export function flaggedLines(reportText) {
  return reportText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\b(HIGH|LOW|CRITICAL|ABNORMAL)\b/i.test(l));
}

// Analyze a lab document. Provide either an `imagePath` (OCR it) or `text`.
// Returns { reportText, flagged, analysis, spoken }.
export async function analyzeLabs(qvac, { imagePath, text, log = () => {} }) {
  let reportText = text ?? "";
  let blocks = 0;
  if (imagePath) {
    const t0 = Date.now();
    const r = await ocrImage(qvac, imagePath);
    reportText = r.text;
    blocks = r.blocks;
    log({ phase: "health", msg: "ocr", imagePath, blocks, ms: Date.now() - t0 });
  }

  const flagged = flaggedLines(reportText);

  const modelId = await qvac.get("medpsy");
  const history = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Lab report:\n${reportText}\n\nWhich values are concerning, and what might they suggest together?`,
    },
  ];
  const t0 = Date.now();
  const r = completion({ modelId, history, stream: false });
  const final = await (r.final ?? r);
  const analysis = stripThinking(final.contentText ?? final.text ?? (await r.text));
  log({ phase: "health", msg: "medpsy", flagged: flagged.length, ms: Date.now() - t0 });

  // The agent speaks the analysis; keep it tight for TTS.
  const spoken = analysis;
  return { reportText, flagged, analysis, spoken };
}
