// p2p.js — tiered intelligence (PLAN §6). A small model runs locally; "hard"
// steps delegate to a BIG model hosted on a teammate's peer over QVAC's
// encrypted P2P (no cloud). `fallbackToLocal` keeps the agent alive if the peer
// drops — the demo's resilience beat.
//
// Topology: the teammate runs `peerProvider.js` (startQVACProvider), hosting a
// big model, and shares its 64-hex public key. We point a PeerLink at that key;
// the brain registers a delegated "plannerBig" model that runs on the peer.
//
// Cross-machine offload needs the teammate's box. On a single machine this
// module is still fully exercised via the fallback/offline paths (see
// p2pAcceptance.js).
import { heartbeat, QWEN3_8B_INST_Q4_K_M } from "@qvac/sdk";

export const HEX64 = /^[0-9a-fA-F]{64}$/;

export class PeerLink {
  constructor({
    qvac,
    providerPublicKey,
    bigModel = QWEN3_8B_INST_Q4_K_M, // peer hosts this (GPT_OSS_20B for more muscle)
    role = "plannerBig",
    timeout = 60_000, // generous: first DHT connect is 15–45s
    healthCheckTimeout = 8_000,
    log = () => {},
  }) {
    if (!HEX64.test(providerPublicKey)) {
      throw new Error("PeerLink: providerPublicKey must be a 64-char hex string (32-byte ed25519 key)");
    }
    this.qvac = qvac;
    this.providerPublicKey = providerPublicKey;
    this.bigModel = bigModel;
    this.role = role;
    this.timeout = timeout;
    this.healthCheckTimeout = healthCheckTimeout;
    this.log = log;
    // Register the delegated big planner now (cheap — just a spec; loads lazily).
    this.qvac.registerModel(this.role, {
      modelSrc: this.bigModel,
      modelType: "llamacpp-completion",
      modelConfig: { ctx_size: 4096, tools: true },
      delegate: this.delegate(),
    });
  }

  delegate() {
    return {
      providerPublicKey: this.providerPublicKey,
      timeout: this.timeout,
      healthCheckTimeout: this.healthCheckTimeout,
      fallbackToLocal: true, // peer down → run locally, don't stall the agent
    };
  }

  // Is the peer reachable right now? (heartbeat round-trip; never throws)
  async online(timeout = 3_000) {
    try {
      await heartbeat({ delegate: { providerPublicKey: this.providerPublicKey, timeout } });
      return true;
    } catch {
      return false;
    }
  }

  // Establish the DHT connection ahead of the demo so the first delegated call
  // isn't paying the 15–45s cold-connect. Returns { online, ms }.
  async prewarm() {
    const t0 = Date.now();
    const ok = await this.online(this.timeout);
    this.log({
      phase: "p2p",
      msg: ok ? "peer online (prewarmed)" : "peer offline — hard steps will fall back to local",
      providerPublicKey: this.providerPublicKey.slice(0, 12) + "…",
      ms: Date.now() - t0,
    });
    return { online: ok, ms: Date.now() - t0 };
  }
}
