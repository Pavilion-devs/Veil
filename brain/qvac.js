// qvac.js — QVAC model lifecycle manager.
// Bakes in every spike gotcha (SPIKE_RESULTS.md §Gotchas, CLAUDE.md):
//   - ONE worker per machine: kill orphan worker + clear stale lock on startup.
//   - unloadModel can throw (ZodError -> unhandled rejection): guard it.
//   - install unhandledRejection / uncaughtException handlers so a flaky RPC
//     path can never take the whole brain down mid-turn.
//   - canonical modelType names (aliases are deprecating).
//   - keep-warm set: load each model once, reuse across steps/turns.
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  loadModel,
  unloadModel,
  QWEN3_4B_INST_Q4_K_M,
  WHISPER_EN_TINY_Q8_0,
  TTS_EN_SUPERTONIC_Q8_0,
  VAD_SILERO_5_1_2,
} from "@qvac/sdk";

const WORKER_LOCK = path.join(os.homedir(), ".qvac", ".worker.lock");

// ---- Validated model stack (PLAN §5 / SPIKE_RESULTS.md) ----
// role -> load args. modelConfig matches what was proven on the M4 Pro.
export const MODELS = {
  planner: {
    modelSrc: QWEN3_4B_INST_Q4_K_M,
    modelType: "llamacpp-completion",
    modelConfig: { ctx_size: 4096, device: "gpu", tools: true },
  },
  stt: {
    // One-shot transcription of a complete wav (Phase-1 path; no VAD).
    modelSrc: WHISPER_EN_TINY_Q8_0,
    modelType: "whispercpp-transcription",
    modelConfig: {}, // no useGPU key for whisper (GPU is automatic)
  },
  sttStream: {
    // Streaming transcription of mic PCM frames. transcribeStream() REQUIRES a
    // VAD model to segment speech — a separate instance keeps the one-shot path
    // unchanged (both are tiny.en + an 885 KB VAD, negligible memory).
    modelSrc: WHISPER_EN_TINY_Q8_0,
    modelType: "whispercpp-transcription",
    modelConfig: { vadModelSrc: VAD_SILERO_5_1_2 },
  },
  tts: {
    modelSrc: TTS_EN_SUPERTONIC_Q8_0,
    modelType: "tts-ggml",
    modelConfig: { ttsEngine: "supertonic", language: "en" },
  },
};

let guardsInstalled = false;
function installGuards() {
  if (guardsInstalled) return;
  guardsInstalled = true;
  // The flaky unloadModel RPC path can surface as an unhandled rejection.
  // Swallow it loudly rather than crash the brain.
  process.on("unhandledRejection", (e) => {
    console.error(`[qvac] (ignored unhandledRejection) ${e?.message ?? e}`);
  });
  process.on("uncaughtException", (e) => {
    console.error(`[qvac] (ignored uncaughtException) ${e?.message ?? e}`);
  });
}

// Kill any orphaned worker from a previous crashed run and clear its stale
// lock. Safe to call on every startup: pkill matches only the SDK's detached
// server process, never this Node process; missing-process / missing-lock are
// non-errors.
export function reapOrphans() {
  try {
    execSync('pkill -f "@qvac/sdk/dist/server"', { stdio: "ignore" });
  } catch {
    /* exit 1 == nothing to kill */
  }
  try {
    execSync(`rm -f "${WORKER_LOCK}"`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

export class QvacManager {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.warm = new Map(); // role -> modelId
    this.loading = new Map(); // role -> Promise<modelId> (dedupe concurrent loads)
    installGuards();
  }

  // Clean any orphan worker/lock before the first load of the run.
  async init() {
    reapOrphans();
    this.log({ phase: "qvac", msg: "reaped orphan worker + cleared stale lock" });
    return this;
  }

  // Load-on-demand + keep-warm. Returns the modelId for a role.
  async get(role) {
    if (this.warm.has(role)) return this.warm.get(role);
    if (this.loading.has(role)) return this.loading.get(role);

    const cfg = MODELS[role];
    if (!cfg) throw new Error(`qvac: unknown model role "${role}"`);

    const t0 = Date.now();
    this.log({ phase: "qvac", msg: `loading ${role}`, modelType: cfg.modelType });
    const p = loadModel({
      modelSrc: cfg.modelSrc,
      modelType: cfg.modelType,
      modelConfig: cfg.modelConfig,
    })
      .then((modelId) => {
        this.warm.set(role, modelId);
        this.loading.delete(role);
        this.log({
          phase: "qvac",
          msg: `loaded ${role}`,
          modelId,
          ms: Date.now() - t0,
        });
        return modelId;
      })
      .catch((e) => {
        this.loading.delete(role);
        throw e;
      });
    this.loading.set(role, p);
    return p;
  }

  // Guarded unload — never let a flaky unload throw past us.
  async unload(role) {
    const id = this.warm.get(role);
    if (id == null) return;
    this.warm.delete(role);
    try {
      await unloadModel(id);
      this.log({ phase: "qvac", msg: `unloaded ${role}` });
    } catch (e) {
      this.log({ phase: "qvac", msg: `unload ${role} threw (ignored)`, err: String(e?.message ?? e) });
    }
  }

  // Unload everything, guarded, on clean shutdown.
  async shutdown() {
    for (const role of [...this.warm.keys()]) {
      await this.unload(role);
    }
    this.log({ phase: "qvac", msg: "shutdown complete" });
  }
}
