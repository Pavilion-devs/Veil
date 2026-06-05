// skills/wallet.js — the hero "money" skill (PLAN §7, §10). Drive a wallet's
// send form by grounding, then submit ONLY after a mandatory voice-confirm gate.
// DEVNET only, no real funds; keys never leave the device. The confirm gate is
// the safety-critical piece: nothing is ever sent without an explicit spoken
// "confirm" from the user.
//
// `confirm(phrase)` is injected by the orchestrator and performs the gate:
// speak the phrase, capture the user's yes/no, return a boolean. If no confirm
// capability is wired, the gate FAILS CLOSED (deny) — we never auto-send.

// Demo address book so the user can say "send to Alex" instead of dictating a
// 44-char base58 address (which STT and an LLM would both mangle).
const ADDRESS_BOOK = {
  alex: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  sam: "5FHwkrdxntdK24hgQU8qgBjn35Y1zwhz1GZwCkP2UJnM",
  treasury: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Resolve a recipient name or raw address → { address, name } or null.
export function resolveRecipient(to) {
  const raw = String(to ?? "").trim();
  const key = raw.toLowerCase();
  if (ADDRESS_BOOK[key]) return { address: ADDRESS_BOOK[key], name: raw };
  if (BASE58.test(raw)) return { address: raw, name: null };
  return null;
}

// Classify a spoken response. Returns true (proceed), false (cancel), or null
// (ambiguous). Ambiguous is treated as "do not send" by the gate.
export function parseConfirmation(text) {
  const t = String(text ?? "").toLowerCase();
  if (/\b(yes|yeah|yep|confirm|confirmed|proceed|approve|approved|go ahead|do it|send it)\b/.test(t)) return true;
  if (/\b(no|nope|cancel|cancelled|stop|abort|don'?t|do not|never ?mind)\b/.test(t)) return false;
  return null;
}

const shorten = (addr) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;

// Send `amount` `asset` to `to` on `network`. Returns a result object; never
// throws on a declined/invalid send (returns submitted:false with a reason).
export async function walletSend({ hands, amount, asset = "SOL", to, network = "devnet", confirm, log = () => {} }) {
  const amt = Number(String(amount ?? "").replace(/[^0-9.]/g, ""));
  if (!(amt > 0)) {
    return { submitted: false, confirmed: false, reason: "invalid amount", spoken: "I couldn't read the amount, so I didn't send anything." };
  }
  const r = resolveRecipient(to);
  if (!r) {
    return {
      submitted: false,
      confirmed: false,
      reason: `unknown recipient "${to}"`,
      spoken: `I don't recognize the recipient ${to}, so I didn't send anything.`,
    };
  }

  // Ground + fill the send form via the Hands API.
  const tree = await hands.getAXTree();
  const recipientEl = tree.find((e) => /recipient|address|to\b/i.test(e.label) && /textfield|textarea/.test(e.role));
  const amountEl = tree.find((e) => /amount/i.test(e.label) && /textfield|textarea/.test(e.role));
  if (recipientEl) {
    await hands.clickElement({ id: recipientEl.id });
    await hands.type({ text: r.address });
  }
  if (amountEl) {
    await hands.clickElement({ id: amountEl.id });
    await hands.type({ text: String(amt) });
  }
  log({ phase: "wallet", msg: "filled form", to: r.address, amount: amt, network });

  // ---- MANDATORY voice-confirm gate ----
  const phrase =
    `Please confirm: send ${amt} ${asset} to ${r.name ? `${r.name}, ` : ""}${shorten(r.address)} on ${network}. ` +
    `Say "confirm" to proceed, or "cancel".`;
  const approved = confirm ? (await confirm(phrase)) === true : false; // fail closed
  if (!approved) {
    log({ phase: "wallet", msg: "declined at confirm gate", to: r.address, amount: amt });
    return {
      submitted: false,
      confirmed: false,
      phrase,
      to: r.address,
      recipient: r.name,
      amount: amt,
      asset,
      network,
      reason: "not confirmed",
      spoken: `Cancelled — I did not send any ${asset}.`,
    };
  }

  // Confirmed → submit (click Send).
  const sendBtn = (await hands.getAXTree()).find((e) => e.role === "button" && /send|confirm|approve/i.test(e.label));
  const res = sendBtn ? await hands.clickElement({ id: sendBtn.id }) : { ok: false, reason: "no send button" };
  log({ phase: "wallet", msg: res.ok ? "submitted" : "submit failed", to: r.address, amount: amt, reason: res.reason });
  return {
    submitted: !!res.ok,
    confirmed: true,
    phrase,
    to: r.address,
    recipient: r.name,
    amount: amt,
    asset,
    network,
    reason: res.ok ? "submitted" : res.reason,
    spoken: res.ok
      ? `Sent ${amt} ${asset} to ${r.name ?? shorten(r.address)} on ${network}.`
      : `I couldn't complete the send (${res.reason}).`,
  };
}
