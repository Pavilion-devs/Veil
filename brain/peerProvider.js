// peerProvider.js — run this on the TEAMMATE'S machine (the "big brain" peer).
// It starts a QVAC provider; our brain then delegates hard steps to it by its
// public key. The provider serves whatever model the consumer requests in its
// loadModel({delegate}) call (e.g. our QWEN3_8B / GPT_OSS_20B plannerBig), so
// this entrypoint just needs to be online and reachable.
//
//   node peerProvider.js                 # random identity (new key each run)
//   node peerProvider.js <64-hex-seed>   # deterministic identity (stable key)
//   node peerProvider.js <seed> <our-consumer-public-key>   # firewall to us only
//
// Share the printed public key with the brain (set VEIL_PEER_KEY=<key>).
// Holds the single QVAC worker on this machine; uses no GPU until we delegate.
import { startQVACProvider, stopQVACProvider } from "@qvac/sdk";
import { reapOrphans } from "./qvac.js";

async function main() {
  reapOrphans(); // clear any stale worker/lock before listening

  const seed = process.argv[2];
  const allowedConsumerKey = process.argv[3];
  if (seed) process.env.QVAC_HYPERSWARM_SEED = seed; // deterministic identity

  console.log("🚀 starting QVAC provider…");
  const res = await startQVACProvider({
    firewall: allowedConsumerKey ? { mode: "allow", publicKeys: [allowedConsumerKey] } : undefined,
  });
  if (!res.success) {
    console.error("❌ provider failed to start:", res.error);
    process.exit(1);
  }

  console.log("✅ provider online");
  console.log(`   public key:  ${res.publicKey}`);
  console.log(`   share it:    VEIL_PEER_KEY=${res.publicKey} node brainMain.js`);
  if (allowedConsumerKey) console.log(`   firewall:    allowing only ${allowedConsumerKey}`);
  console.log("📡 running — Ctrl-C to stop");

  const shutdown = async () => {
    try {
      await stopQVACProvider();
    } catch {
      /* ignore */
    }
    console.log("\n🛑 provider stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.resume(); // stay alive
}

main();
