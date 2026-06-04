// make-labs.js — render labs.html -> labs.png with headless Chrome (no extra
// deps). Run once to (re)generate the OCR fixture for the health skill:
//   node fixtures/make-labs.js
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function renderLabs({ html = path.join(HERE, "labs.html"), out = path.join(HERE, "labs.png") } = {}) {
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
  execFileSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2", // crisp text -> better OCR
      "--window-size=900,1180",
      `--screenshot=${out}`,
      `file://${html}`,
    ],
    { stdio: "ignore" },
  );
  return out;
}

// Ensure the fixture exists; render it if missing. Safe to call from tests.
export function ensureLabsPng(out = path.join(HERE, "labs.png")) {
  if (!fs.existsSync(out)) renderLabs({ out });
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = renderLabs();
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
}
