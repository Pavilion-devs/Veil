// logging.js — structured JSONL, one line per step/event, per turn. These files
// are first-class hackathon artifacts ("Artifact Quality" points) and the
// primary debugging surface for the agent loop.
import fs from "node:fs";
import path from "node:path";

export class TurnLogger {
  constructor({ turn, dir, echo = false }) {
    this.turn = turn;
    this.echo = echo;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `turn-${turn}.jsonl`);
    fs.writeFileSync(this.file, ""); // truncate any prior run of this turn
    this.lines = [];
  }

  log(obj) {
    const line = { ts: Date.now(), turn: this.turn, ...obj };
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n");
    this.lines.push(line);
    if (this.echo) {
      const tag = line.phase || "log";
      console.log(`  · ${tag}: ${line.msg ?? ""}`.trimEnd());
    }
    return line;
  }

  path() {
    return this.file;
  }
}
