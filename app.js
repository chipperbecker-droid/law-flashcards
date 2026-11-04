/* Law Flashcards — a dependency-free static flashcard app.
 * Decks are listed in decks/decks.json; each points at a CSV in decks/.
 * CSV format (Anki "Notes in Plain Text" export works as-is):
 *   front, back, tags   (back may contain HTML; tags are space-separated)
 */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const DECKS_URL = "decks/decks.json";
  let deckList = [];
  const cache = {};        // deckId -> { cards, error }
  let session = null;      // active study session

  /* ---------- storage (safe) ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const progressKey = id => "lf:progress:" + id;
  const prefsKey = id => "lf:prefs:" + id;

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const savedTheme = store.get("lf:theme", null);
  if (savedTheme) root.dataset.theme = savedTheme;
  document.getElementById("themeBtn").addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("lf:theme", root.dataset.theme);
  });

  /* ---------- helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stripHtml = s => { const d = document.createElement("div"); d.innerHTML = s; return d.textContent || ""; };
  function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function prettyTag(t) {
    return t.replace(/_/g, " ").replace(/^Part(?=[A-Z])/, "Part ").replace(/\bArt (I+)\b/, "Art. $1");
  }

  /* ---------- CSV ---------- */
  function parseCSV(text, sep) {
    const rows = []; let row = []; let field = ""; let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"' && field === "") q = true;
      else if (c === sep) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseDeck(text) {
    text = text.replace(/^﻿/, "");
    // Anki header lines like "#separator:Comma", "#tags column:3"
    const meta = {};
    const lines = text.split(/\r?\n/);
    let skip = 0;
    while (skip < lines.length && lines[skip].startsWith("#")) {
      const m = lines[skip].match(/^#([^:]+):(.*)$/);
      if (m) meta[m[1].trim().toLowerCase()] = m[2].trim();
      skip++;
    }
    const body = lines.slice(skip).join("\n");
    const sepName = (meta.separator || "").toLowerCase();
    let sep = { tab: "\t", comma: ",", semicolon: ";", pipe: "|", space: " " }[sepName] || meta.separator;
    if (!sep || sep.length !== 1) {
      const first = lines[skip] || "";
      sep = first.includes("\t") && !first.includes(",") ? "\t" : ",";
    }
    const special = {};
    ["tags", "notetype", "deck", "guid"].forEach(k => { if (meta[k + " column"]) special[k] = parseInt(meta[k + " column"], 10) - 1; });
    const rows = parseCSV(body, sep).filter(r => r.some(f => f.trim() !== ""));
    if (rows.length && /^front$/i.test(rows[0][0].trim()) && /^back$/i.test((rows[0][1] || "").trim())) rows.shift();

    const skipCols = new Set(Object.values(special));
    const cards = [];
    const seen = {};
    rows.forEach(r => {
      const fields = r.filter((_, i) => !skipCols.has(i));
      const front = (fields[0] || "").trim();
      const back = (fields[1] || "").trim();
      if (!front) return;
      const tagStr = special.tags != null ? r[special.tags] : (fields[2] || "");
      const tags = (tagStr || "").split(/\s+/).filter(Boolean);
      let id = hash(front + "\u0000" + back);
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1) id += "-" + seen[id];
      cards.push({ id, front, back, tags, text: (stripHtml(front) + " " + stripHtml(back)).toLowerCase() });
    });

    // Drop a tag that every card shares (e.g. the class tag "AdminLaw").
    if (cards.length > 1) {
      const common = cards[0].tags.filter(t => cards.every(c => c.tags.includes(t)));
      cards.forEach(c => { c.tags = c.tags.filter(t => !common.includes(t)); });
    }
    return cards;
  }

  const TYPE_TAGS = new Set(["case", "doctrine", "test", "statute", "rule", "concept", "definition", "element", "elements", "hypo", "policy", "factor", "factors"]);
  function groupFor(tag) {
    if (/^part/i.test(tag) || /^(unit|chapter|week|module)/i.test(tag)) return "Part";
    if (TYPE_TAGS.has(tag.toLowerCase())) return "Type";
    return "Topic";
  }
  function tagGroups(cards) {
    const groups = { Part: new Map(), Type: new Map(), Topic: new Map() };
    cards.forEach(c => c.tags.forEach(t => { const g = groups[groupFor(t)]; g.set(t, (g.get(t) || 0) + 1); }));
    return groups;
  }

  async function loadDeck(deck) {
    if (cache[deck.id]) return cache[deck.id];
    try {
      const res = await fetch("decks/" + deck.file, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status === 404 ? "missing" : "HTTP " + res.status);
      const cards = parseDeck(await res.text());
      cache[deck.id] = { cards };
    } catch (e) {
      cache[deck.id] = { cards: [], error: e.message };
    }
    return cache[deck.id];
  }

  /* ---------- progress ---------- */
  function getProgress(id) { return store.get(progressKey(id), {}); }
  function statusOf(prog, card) { return prog[card.id] ? prog[card.id].s : "new"; }
  function counts(cards, prog) {
    const c = { known: 0, learning: 0, new: 0 };
    cards.forEach(card => c[statusOf(prog, card)]++);
    return c;
  }
  function progressBar(c, total) {
    const k = total ? (c.known / total) * 100 : 0, l = total ? (c.learning / total) * 100 : 0;
    return `<div class="bar"><span class="k" style="width:${k}%"></span><span class="l" style="width:${l}%"></span></div>`;
  }

  /* ---------- views ---------- */
  async function viewHome() {
    session = null;
    const loaded = await Promise.all(deckList.map(loadDeck));
    app.innerHTML = `
      <h1>Study</h1>
      <p class="muted">Pick a class. Your progress is saved in this browser.</p>
      <div class="decks">
        ${deckList.map((d, i) => {
          const { cards } = loaded[i];
          if (!cards.length) return `
            <div class="deck empty">
              <h2>${esc(d.name)}</h2>
              <span class="count">No cards yet</span>
              <span class="muted" style="font-size:.85rem">Add <code>decks/${esc(d.file)}</code> to the repo to fill this deck.</span>
            </div>`;
          const c = counts(cards, getProgress(d.id));
          return `
            <a class="deck" href="#/deck/${encodeURIComponent(d.id)}">
              <h2>${esc(d.name)}</h2>
              <span class="count">${cards.length} cards</span>
              ${progressBar(c, cards.length)}
              <div class="legend">
                <span><i class="dot" style="background:var(--good)"></i>${c.known} known</span>
                <span><i class="dot" style="background:var(--again)"></i>${c.learning} learning</span>
                <span>${c.new} new</span>
              </div>
            </a>`;
        }).join("")}
      </div>`;
  }

  function defaultPrefs() { return { sel: {}, mode: "unknown", shuffle: true }; }

  async function viewDeck(deck) {
    session = null;
    const { cards } = await loadDeck(deck);
    if (!cards.length) {
      app.innerHTML = `<a class="back" href="#/">← All classes</a><h1>${esc(deck.name)}</h1>
        <div class="notice"><p>No cards yet. Upload a CSV named <code>${esc(deck.file)}</code> into the <code>decks/</code> folder of the repo
        (columns: front, back, tags). An Anki “Notes in Plain Text” export works as-is.</p></div>`;
      return;
    }
    const prefs = Object.assign(defaultPrefs(), store.get(prefsKey(deck.id), {}));
    const groups = tagGroups(cards);

    function selected() {
      return cards.filter(c => ["Part", "Type", "Topic"].every(g => {
        const s = prefs.sel[g];
        return !s || !s.length || c.tags.some(t => s.includes(t));
      }));
    }
    function pool() {
      const prog = getProgress(deck.id);
      const sel = selected();
      if (prefs.mode === "unknown") return sel.filter(c => statusOf(prog, c) !== "known");
      if (prefs.mode === "learning") return sel.filter(c => statusOf(prog, c) === "learning");
      return sel;
    }

    function render() {
      const prog = getProgress(deck.id);
      const sel = selected();
      const c = counts(sel, prog);
      const n = pool().length;
      const all = counts(cards, prog);
      app.innerHTML = `
        <a class="back" href="#/">← All classes</a>
        <h1>${esc(deck.name)}</h1>
        <p class="muted">${cards.length} cards · ${all.known} known · ${all.learning} still learning · ${all.new} new</p>

        <div class="panel">
          ${["Part", "Type", "Topic"].filter(g => groups[g].size).map(g => `
            <div class="group">
              <div class="group-label">${g}</div>
              <div class="chips">
                ${[...groups[g]].map(([t, num]) => `<button class="chip" data-g="${g}" data-t="${esc(t)}" aria-pressed="${(prefs.sel[g] || []).includes(t)}">${esc(prettyTag(t))}<span class="n">${num}</span></button>`).join("")}
              </div>
            </div>`).join("")}
          <div class="group">
            <div class="group-label">Cards to study</div>
            <div class="row">
              <div class="seg" role="group">
                <button data-mode="unknown" aria-pressed="${prefs.mode === "unknown"}">Not yet known (${c.new + c.learning})</button>
                <button data-mode="learning" aria-pressed="${prefs.mode === "learning"}">Still learning (${c.learning})</button>
                <button data-mode="all" aria-pressed="${prefs.mode === "all"}">All (${sel.length})</button>
              </div>
              <label class="toggle"><input type="checkbox" id="shuf" ${prefs.shuffle ? "checked" : ""}> Shuffle</label>
            </div>
          </div>
        </div>

        <div class="actions">
          <button class="btn primary" id="start" ${n ? "" : "disabled"}>Study ${n} card${n === 1 ? "" : "s"}</button>
          <a class="btn" href="#/deck/${encodeURIComponent(deck.id)}/browse">Browse &amp; search</a>
          ${Object.values(prefs.sel).some(s => s && s.length) ? `<button class="btn link" id="clear">Clear filters</button>` : ""}
          <button class="btn link" id="reset" style="margin-left:auto">Reset progress</button>
        </div>
        ${!n && sel.length ? `<p class="muted">Nothing left in this selection. Switch to “All” to review everything.</p>` : ""}`;

      app.querySelectorAll(".chip").forEach(b => b.onclick = () => {
        const g = b.dataset.g, t = b.dataset.t;
        const s = new Set(prefs.sel[g] || []);
        s.has(t) ? s.delete(t) : s.add(t);
        prefs.sel[g] = [...s]; save(); render();
      });
      app.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { prefs.mode = b.dataset.mode; save(); render(); });
      app.querySelector("#shuf").onchange = e => { prefs.shuffle = e.target.checked; save(); };
      const clear = app.querySelector("#clear");
      if (clear) clear.onclick = () => { prefs.sel = {}; save(); render(); };
      app.querySelector("#reset").onclick = () => {
        if (confirm(`Reset all progress for ${deck.name}? Every card goes back to “new”.`)) { store.del(progressKey(deck.id)); render(); }
      };
      app.querySelector("#start").onclick = () => {
        let q = pool().slice();
        if (prefs.shuffle) shuffle(q);
        session = { deck, queue: q, total: q.length, done: 0, flipped: false, gotIt: 0, again: 0, history: [] };
        location.hash = "#/deck/" + encodeURIComponent(deck.id) + "/study";
      };
    }
    function save() { store.set(prefsKey(deck.id), prefs); }
    render();
  }

  function viewStudy(deck) {
    if (!session || session.deck.id !== deck.id) { location.replace("#/deck/" + encodeURIComponent(deck.id)); return; }
    const s = session;
    const deckHref = "#/deck/" + encodeURIComponent(deck.id);

    if (!s.queue.length) {
      app.innerHTML = `
        <a class="back" href="${deckHref}">← ${esc(deck.name)}</a>
        <div class="panel done">
          <div class="big">✓</div>
          <h1>Session complete</h1>
          <p class="muted">${s.total} card${s.total === 1 ? "" : "s"} reviewed · ${s.gotIt} got it · ${s.again} marked again</p>
          <div class="actions" style="justify-content:center">
            <a class="btn primary" href="${deckHref}">Back to ${esc(deck.short || deck.name)}</a>
            <a class="btn" href="#/">All classes</a>
          </div>
        </div>`;
      return;
    }

    const card = s.queue[0];
    const prog = getProgress(deck.id);
    const st = statusOf(prog, card);
    const pct = s.total ? (s.done / s.total) * 100 : 0;
    app.innerHTML = `
      <div class="study-head">
        <a class="back" href="${deckHref}">← ${esc(deck.name)}</a>
        <div class="progress">
          <div class="bar"><span style="width:${pct}%"></span></div>
          <small>${s.done} of ${s.total} done · ${s.queue.length} left</small>
        </div>
      </div>
      <div class="card ${s.flipped ? "flipped" : ""}" id="card" tabindex="0" aria-live="polite">
        ${st !== "new" ? `<span class="status-pill ${st}">${st === "known" ? "Known" : "Learning"}</span>` : ""}
        <div class="tags">${card.tags.map(t => `<span class="tag">${esc(prettyTag(t))}</span>`).join("")}</div>
        <div class="front">${card.front}</div>
        <div class="answer">${card.back}</div>
        <div class="hint">Tap the card or press Space to reveal</div>
      </div>
      ${s.flipped ? `
        <div class="grade">
          <button class="btn again" id="again">Again</button>
          <button class="btn good" id="good">Got it</button>
        </div>` : `
        <div class="grade"><button class="btn primary" id="reveal" style="grid-column:1/-1">Show answer</button></div>`}
      <div class="navrow">
        <button class="btn link" id="undo" ${s.history.length ? "" : "disabled"}>↶ Undo</button>
        <button class="btn link" id="skip">Skip →</button>
      </div>
      <div class="keys"><kbd>Space</kbd> flip · <kbd>1</kbd> again · <kbd>2</kbd> got it · <kbd>S</kbd> skip · <kbd>U</kbd> undo</div>`;

    const flip = () => { s.flipped = !s.flipped; viewStudy(deck); };
    app.querySelector("#card").onclick = e => { if (!getSelection().toString()) flip(); };
    const r = app.querySelector("#reveal"); if (r) r.onclick = flip;
    const g = app.querySelector("#good"); if (g) g.onclick = () => grade(deck, true);
    const a = app.querySelector("#again"); if (a) a.onclick = () => grade(deck, false);
    app.querySelector("#skip").onclick = () => skip(deck);
    app.querySelector("#undo").onclick = () => undo(deck);
  }

  function grade(deck, good) {
    const s = session; const card = s.queue[0];
    const prog = getProgress(deck.id);
    s.history.push({ queue: s.queue.slice(), done: s.done, gotIt: s.gotIt, again: s.again, prev: prog[card.id] || null, id: card.id });
    const prev = prog[card.id] || { n: 0 };
    prog[card.id] = { s: good ? "known" : "learning", n: (prev.n || 0) + 1, t: Date.now() };
    store.set(progressKey(deck.id), prog);
    s.queue.shift();
    if (good) { s.done++; s.gotIt++; }
    else {
      s.again++;
      // bring it back a few cards later in this session
      const pos = Math.min(s.queue.length, 4 + Math.floor(Math.random() * 3));
      s.queue.splice(pos, 0, card);
    }
    s.flipped = false;
    viewStudy(deck);
  }
  function skip(deck) {
    const s = session; if (s.queue.length < 2) return;
    s.queue.push(s.queue.shift()); s.flipped = false; viewStudy(deck);
  }
  function undo(deck) {
    const s = session; const h = s.history.pop(); if (!h) return;
    const prog = getProgress(deck.id);
    if (h.prev) prog[h.id] = h.prev; else delete prog[h.id];
    store.set(progressKey(deck.id), prog);
    Object.assign(s, { queue: h.queue, done: h.done, gotIt: h.gotIt, again: h.again, flipped: true });
    viewStudy(deck);
  }

  async function viewBrowse(deck) {
    session = null;
    const { cards } = await loadDeck(deck);
    const prog = getProgress(deck.id);
    app.innerHTML = `
      <a class="back" href="#/deck/${encodeURIComponent(deck.id)}">← ${esc(deck.name)}</a>
      <h1>Browse</h1>
      <input class="search" id="q" type="search" placeholder="Search ${cards.length} cards (case names, doctrines, statutes…)" autocomplete="off">
      <p class="muted" id="cnt"></p>
      <div class="list" id="list"></div>`;
    const list = app.querySelector("#list"), cnt = app.querySelector("#cnt");
    function draw(q) {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = cards.filter(c => terms.every(t => c.text.includes(t) || c.tags.some(x => x.toLowerCase().includes(t))));
      cnt.textContent = `${hits.length} card${hits.length === 1 ? "" : "s"}`;
      list.innerHTML = hits.map(c => {
        const st = statusOf(prog, c);
        return `<details><summary>${c.front}${st !== "new" ? ` <small class="status-pill ${st}" style="position:static">· ${st === "known" ? "Known" : "Learning"}</small>` : ""}</summary>
          <div class="answer">${c.back}</div>
          <div class="tags" style="display:flex;gap:6px;flex-wrap:wrap">${c.tags.map(t => `<span class="tag">${esc(prettyTag(t))}</span>`).join("")}</div></details>`;
      }).join("");
    }
    const input = app.querySelector("#q");
    input.oninput = () => draw(input.value);
    draw("");
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", e => {
    if (!session || !/\/study$/.test(location.hash)) return;
    if (e.target.matches("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const deck = session.deck;
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); session.flipped = !session.flipped; viewStudy(deck); }
    else if (session.flipped && (e.key === "1" || e.key === "ArrowLeft")) grade(deck, false);
    else if (session.flipped && (e.key === "2" || e.key === "ArrowRight")) grade(deck, true);
    else if (e.key.toLowerCase() === "s") skip(deck);
    else if (e.key.toLowerCase() === "u") undo(deck);
  });

  /* ---------- router ---------- */
  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    window.scrollTo(0, 0);
    if (parts[0] === "deck") {
      const deck = deckList.find(d => d.id === parts[1]);
      if (!deck) return viewHome();
      if (parts[2] === "study") return viewStudy(deck);
      if (parts[2] === "browse") return viewBrowse(deck);
      return viewDeck(deck);
    }
    return viewHome();
  }

  (async function init() {
    try {
      const res = await fetch(DECKS_URL, { cache: "no-cache" });
      deckList = await res.json();
    } catch (e) {
      app.innerHTML = `<p>Couldn't load <code>${DECKS_URL}</code>. If you opened index.html directly from your computer, run a local server instead (see README).</p>`;
      return;
    }
    window.addEventListener("hashchange", route);
    route();
  })();
})();
