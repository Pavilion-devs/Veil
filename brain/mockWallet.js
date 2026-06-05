// mockWallet.js — a scripted Phantom-style Solana send form implementing the
// Hands API (PLAN §3.2), for testing the wallet skill without a real browser.
// In production the wallet is a Chrome extension grounded OCR-first (§9); here
// the form is exposed via AX so the flow is deterministic. DEVNET only — the
// skill's voice-confirm gate is what we're really exercising.
//
// Fields: [1] Recipient address · [2] Amount (SOL) · [3] Send button.
// clickElement(Send) only submits when both fields are filled — and the skill
// must pass its confirm gate BEFORE it ever clicks Send.
export class MockWallet {
  constructor() {
    this.reset();
  }

  reset() {
    this.recipient = "";
    this.amount = "";
    this.network = "devnet";
    this.focusedId = null;
    this.submitted = false;
    this.lastTx = null; // { to, amount, network } once submitted
    this.lastOverlay = null;
    this.played = [];
  }

  async captureScreen() {
    return { pngPath: null, width: 1440, height: 900, scale: 2 };
  }

  async getAXTree() {
    return [
      {
        id: 4,
        role: "image",
        label: `Phantom — ${this.network}`,
        value: "",
        bounds: { x: 40, y: 20, w: 380, h: 80 },
        enabled: true,
        focused: false,
      },
      {
        id: 1,
        role: "textfield",
        label: "Recipient address",
        value: this.recipient,
        bounds: { x: 40, y: 120, w: 380, h: 36 },
        enabled: true,
        focused: this.focusedId === 1,
      },
      {
        id: 2,
        role: "textfield",
        label: "Amount (SOL)",
        value: this.amount,
        bounds: { x: 40, y: 180, w: 380, h: 36 },
        enabled: true,
        focused: this.focusedId === 2,
      },
      {
        id: 3,
        role: "button",
        label: "Send",
        value: "",
        bounds: { x: 40, y: 240, w: 380, h: 44 },
        enabled: true,
        focused: false,
      },
    ];
  }

  async clickElement({ id }) {
    if (id === 1) {
      this.focusedId = 1;
      return { ok: true };
    }
    if (id === 2) {
      this.focusedId = 2;
      return { ok: true };
    }
    if (id === 3) {
      // The actual on-chain submit. Refuses an incomplete form.
      if (this.recipient && this.amount) {
        this.submitted = true;
        this.lastTx = { to: this.recipient, amount: this.amount, network: this.network };
        return { ok: true };
      }
      return { ok: false, reason: "form incomplete" };
    }
    return { ok: false, reason: `no element with id ${id}` };
  }

  async type({ text }) {
    if (this.focusedId === 1) {
      this.recipient += text;
      return { ok: true };
    }
    if (this.focusedId === 2) {
      this.amount += text;
      return { ok: true };
    }
    return { ok: false, reason: "nothing focused to type into" };
  }

  async key() {
    return { ok: true, noop: true };
  }
  async scroll() {
    return { ok: true, noop: true };
  }
  async openApp() {
    return { ok: true };
  }
  async showOverlay(o) {
    this.lastOverlay = o;
    return { ok: true };
  }
  async playAudio({ wavPath }) {
    this.played.push(wavPath);
    return { ok: true };
  }
}
