// mockHands.js — a scripted, in-memory "eyes & hands" implementing the Hands API
// (PLAN §3.2) against a fake Notes app. clickElement/type/key mutate real state
// so the verifier's AX-diff observes genuine change. Swappable later for the
// real Unix-socket client to the Swift app — same method surface.
//
// Fake screen layout (logical points, scale 2):
//   [New Note]  [ Search______ ]                top bar
//   ┌ note list ┐  ┌──── editor (selected note body) ────┐
//   │ row 0     │  │                                     │
//   │ row 1     │  │                                     │
//   └───────────┘  └─────────────────────────────────────┘
//
// Stable element ids: 1 = New Note button, 2 = Search field, 3 = Editor.
// Note-list rows get ids 100 + visibleIndex (dynamic; reflect filtered list).

const NEW_NOTE = 1;
const SEARCH = 2;
const EDITOR = 3;

export class MockHands {
  constructor() {
    this.reset();
  }

  reset() {
    // Neutral seed titles — deliberately avoid words that collide with the
    // demo commands (e.g. "groceries"), so "search for X" maps to the Search
    // field rather than a same-named note row.
    this.notes = [
      { title: "Welcome", body: "thanks for trying Veil" },
      { title: "Ideas", body: "ship the demo" },
    ];
    this.selected = 0; // index into this.notes
    this.searchQuery = "";
    this.focusedId = null; // nothing focused until the agent clicks a field
    this.frontApp = "Notes";
    this.document = null; // an open doc in "Preview" (image with no AX content)
    this.lastOverlay = null;
    this.played = []; // record of playAudio calls (artifact for the demo)
  }

  // Simulate opening a document (e.g. a lab PDF) in Preview. The content has no
  // accessibility text — exactly the case where the agent must OCR the screen.
  showDocument(pngPath, title = "Document") {
    this.document = { path: pngPath, title };
    this.frontApp = "Preview";
    this.focusedId = null;
  }

  // ---- internal helpers ----
  _visibleNotes() {
    const q = this.searchQuery.trim().toLowerCase();
    // Each entry keeps its original index so selection/ids stay coherent.
    const all = this.notes.map((n, idx) => ({ ...n, idx }));
    if (!q) return all;
    return all.filter(
      (n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
    );
  }

  _selectedNote() {
    return this.notes[this.selected] ?? null;
  }

  // ---- Hands API (PLAN §3.2) ----

  // Returns the open document's image when one is shown (so the agent can OCR
  // it); otherwise a null-png stub (Phase 1 verify is AX-diff, not pixels).
  async captureScreen() {
    return { pngPath: this.document?.path ?? null, width: 1440, height: 900, scale: 2 };
  }

  // Grounded element list: [{id, role, label, value, bounds, enabled, focused}].
  // Rebuilt fresh each call from current state, so two snapshots diff cleanly.
  async getAXTree() {
    // Preview showing a document: the content has no AX text — the agent sees
    // only the document window and must OCR (query_health) to read it.
    if (this.document) {
      return [
        {
          id: 50,
          role: "image",
          label: `${this.document.title} (open in Preview)`,
          value: "",
          bounds: { x: 220, y: 120, w: 1000, h: 1300 },
          enabled: true,
          focused: true,
        },
      ];
    }
    const tree = [];
    tree.push({
      id: NEW_NOTE,
      role: "button",
      label: "New Note",
      value: "",
      bounds: { x: 20, y: 20, w: 120, h: 32 },
      enabled: true,
      focused: this.focusedId === NEW_NOTE,
    });
    tree.push({
      id: SEARCH,
      role: "textfield",
      label: "Search",
      value: this.searchQuery,
      bounds: { x: 160, y: 20, w: 300, h: 32 },
      enabled: true,
      focused: this.focusedId === SEARCH,
    });
    const sel = this._selectedNote();
    tree.push({
      id: EDITOR,
      role: "textarea",
      label: sel ? `Editor: ${sel.title}` : "Editor",
      value: sel ? sel.body : "",
      bounds: { x: 480, y: 70, w: 900, h: 780 },
      enabled: true,
      focused: this.focusedId === EDITOR,
    });
    // Visible (filtered) note rows.
    this._visibleNotes().forEach((n, i) => {
      tree.push({
        id: 100 + i,
        role: "row",
        label: n.title,
        value: n.idx === this.selected ? "selected" : "",
        bounds: { x: 20, y: 70 + i * 48, w: 430, h: 44 },
        enabled: true,
        focused: false,
        // hidden field so click can map a visible row back to a note index:
        _noteIndex: n.idx,
      });
    });
    return tree;
  }

  async clickElement({ id }) {
    if (id === NEW_NOTE) {
      this.notes.push({ title: "New Note", body: "" });
      this.selected = this.notes.length - 1;
      this.searchQuery = ""; // clearing the filter reveals the fresh note
      this.focusedId = EDITOR;
      return { ok: true };
    }
    if (id === SEARCH) {
      this.focusedId = SEARCH;
      return { ok: true };
    }
    if (id === EDITOR) {
      this.focusedId = EDITOR;
      return { ok: true };
    }
    // A note row: select that note.
    const rows = await this.getAXTree();
    const row = rows.find((e) => e.id === id && e.role === "row");
    if (row) {
      this.selected = row._noteIndex;
      this.focusedId = EDITOR;
      return { ok: true };
    }
    // Unknown id — nothing happens (this is how the verifier catches a
    // wrong/hallucinated target: no AX change + ok:false).
    return { ok: false, reason: `no element with id ${id}` };
  }

  async type({ text }) {
    if (this.focusedId === SEARCH) {
      this.searchQuery += text;
      return { ok: true };
    }
    if (this.focusedId === EDITOR) {
      const note = this._selectedNote();
      if (!note) return { ok: false, reason: "no note open" };
      note.body += text;
      // Title tracks the first non-empty line, like a real notes app.
      const firstLine = note.body.split("\n").find((l) => l.trim()) ?? "";
      if (firstLine) note.title = firstLine.slice(0, 40);
      return { ok: true };
    }
    return { ok: false, reason: "nothing focused to type into" };
  }

  async key({ keys }) {
    const k = String(keys).toLowerCase().replace(/\s+/g, "");
    if (k === "cmd+n") return this.clickElement({ id: NEW_NOTE });
    if (k === "cmd+f") {
      this.focusedId = SEARCH;
      return { ok: true };
    }
    // Unrecognized combo: no-op (no observable change).
    return { ok: true, noop: true };
  }

  async scroll() {
    // Nothing scrollable in the fixture — deliberate no-op so a misfired
    // scroll yields zero AX-diff (exercised by the self-correction test).
    return { ok: true, noop: true };
  }

  async openApp({ name }) {
    const changed = this.frontApp !== name;
    this.frontApp = name;
    return { ok: true, changed };
  }

  async showOverlay({ x, y, label }) {
    this.lastOverlay = { x, y, label };
    return { ok: true };
  }

  async playAudio({ wavPath }) {
    this.played.push(wavPath);
    return { ok: true };
  }
}
