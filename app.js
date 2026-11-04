/* Law Flashcards — a dependency-free static flashcard app.
 * Decks are listed in decks/decks.json; each points at a CSV in decks/.
 * CSV format (Anki "Notes in Plain Text" export works as-is):
 *   front, back, tags   (back may contain HTML; tags are space-separated)
 * or with a header row:  Front,Back,Topic,Type  (Part/Topic/Type/Tags columns)
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

    // Optional header row, e.g. "Front,Back,Topic,Type" or "front,back,tags".
    let header = null;
    if (rows.length && /^(front|question|term)$/i.test(rows[0][0].trim())) {
      header = rows.shift().map(h => h.trim().toLowerCase());
    }
    const GROUP_COLS = { part: "Part", unit: "Part", type: "Type", topic: "Topic", subject: "Topic", category: "Topic" };

    const skipCols = new Set(Object.values(special));
    const cards = [];
    const seen = {};
    rows.forEach(r => {
      let front, back, tags = [], gmap = {};
      if (header) {
        front = (r[0] || "").trim(); back = (r[1] || "").trim();
        header.forEach((h, i) => {
          if (i < 2 || !r[i] || !r[i].trim()) return;
          if (GROUP_COLS[h]) { const t = r[i].trim(); tags.push(t); gmap[t] = GROUP_COLS[h]; }
          else if (h === "tags") r[i].split(/\s+/).filter(Boolean).forEach(t => tags.push(t));
        });
      } else {
        const fields = r.filter((_, i) => !skipCols.has(i));
        front = (fields[0] || "").trim(); back = (fields[1] || "").trim();
        const tagStr = special.tags != null ? r[special.tags] : (fields[2] || "");
        tags = (tagStr || "").split(/\s+/).filter(Boolean)
          // Anki hierarchical tags: "BA::Agency" -> "Agency"
          .map(t => (t.includes("::") ? t.split("::").slice(1).join(" / ") : t));
      }
      if (!front) return;
      let id = hash(front + "\u0000" + back);
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1) id += "-" + seen[id];
      cards.push({ id, front, back, tags, gmap, text: (stripHtml(front) + " " + stripHtml(back)).toLowerCase() });
    });

    // Drop a tag that every card shares (e.g. the class tag "AdminLaw").
    if (cards.length > 1) {
      const common = cards[0].tags.filter(t => cards.every(c => c.tags.includes(t)));
      cards.forEach(c => { c.tags = c.tags.filter(t => !common.includes(t)); });
    }
    return cards;
  }

  const TYPE_TAGS = new Set(["case", "doctrine", "test", "statute", "rule", "concept", "definition", "element", "elements", "hypo", "policy", "factor", "factors", "list", "why", "compare", "cloze"]);
  function groupFor(tag) {
    if (/^part/i.test(tag) || /^(unit|chapter|week|module)/i.test(tag)) return "Part";
    if (TYPE_TAGS.has(tag.toLowerCase())) return "Type";
    return "Topic";
  }
  function tagGroups(cards) {
    const groups = { Part: new Map(), Type: new Map(), Topic: new Map() };
    cards.forEach(c => c.tags.forEach(t => { const g = groups[c.gmap[t] || groupFor(t)]; g.set(t, (g.get(t) || 0) + 1); }));
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
  function setProgress(id, p) { store.set(progressKey(id), p); }
  function statusOf(prog, card) { return prog[card.id] ? prog[card.id].s : "new"; }
  function counts(cards, prog) {
    const c = { known: 0, learning: 0, new: 0 };
    cards.forEach(card => c[statusOf(prog, card)]++);
    return c;
  }
  function getPrefs(id) { return Object.assign({ filter: "", shuffle: true }, store.get(prefsKey(id), {})); }
  function setPrefs(id, p) { store.set(prefsKey(id), p); }
  const filtered = (cards, f) => (f ? cards.filter(c => c.tags.includes(f)) : cards);
  const deckHref = (deck, sub) => "#/deck/" + encodeURIComponent(deck.id) + (sub ? "/" + sub : "");
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const UPLOAD_URL = "https://github.com/chipperbecker-droid/law-flashcards/upload/main/decks";
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  const ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  };

  function meter(c, total) {
    const k = total ? (c.known / total) * 100 : 0, l = total ? (c.learning / total) * 100 : 0;
    return `<div class="meter" role="img" aria-label="${c.known} known, ${c.learning} still learning, out of ${total}">
      <span class="m-known" style="width:${k}%"></span><span class="m-learning" style="width:${l}%"></span></div>`;
  }

  /* ---------- Home ---------- */
  async function viewHome() {
    session = null; quiz = null;
    const loaded = await Promise.all(deckList.map(loadDeck));
    app.innerHTML = `
      <section class="intro">
        <h1>Your classes</h1>
        <p class="muted">Pick one to study. Progress is saved on this device.</p>
      </section>
      <div class="shelf">
        ${deckList.map((d, i) => {
          const { cards } = loaded[i];
          if (!cards.length) return `
            <a class="file-card is-empty" href="${deckHref(d)}">
              <div class="fc-face">
                <div class="fc-head"><h2>${esc(d.name)}</h2></div>
                <div class="fc-lines"><p class="fc-meta">No cards yet</p></div>
              </div>
            </a>`;
          const c = counts(cards, getProgress(d.id));
          return `
            <a class="file-card" href="${deckHref(d)}">
              <span class="fc-stack" aria-hidden="true"></span>
              <div class="fc-face">
                <div class="fc-head"><h2>${esc(d.name)}</h2></div>
                <div class="fc-lines">
                  <p class="fc-meta">${plural(cards.length, "card")}</p>
                  <p class="fc-meta">${c.known ? `${c.known} known${c.learning ? `, ${c.learning} still learning` : ""}` : "Not started"}</p>
                  ${meter(c, cards.length)}
                </div>
              </div>
            </a>`;
        }).join("")}
      </div>`;
  }

  /* ---------- Class page ---------- */
  async function viewDeck(deck) {
    session = null; quiz = null;
    const { cards } = await loadDeck(deck);
    if (!cards.length) {
      app.innerHTML = `
        <a class="back" href="#/">${ICON.back}All classes</a>
        <h1 class="class-title">${esc(deck.name)}</h1>
        <div class="empty">
          <p class="empty-lead">This class has no cards yet.</p>
          <p class="muted">Upload a CSV named <code>${esc(deck.file)}</code> to the <code>decks</code> folder on GitHub. Columns are front, back, and optional tags. An Anki “Notes in Plain Text” export works as it is.</p>
          <a class="btn primary" href="${UPLOAD_URL}" target="_blank" rel="noopener">Upload cards on GitHub</a>
        </div>`;
      return;
    }
    const prefs = getPrefs(deck.id);
    if (prefs.filter && !cards.some(c => c.tags.includes(prefs.filter))) prefs.filter = "";
    const groups = tagGroups(cards);
    let query = "";

    function render() {
      const prog = getProgress(deck.id);
      const sel = filtered(cards, prefs.filter);
      const c = counts(sel, prog);
      app.innerHTML = `
        <a class="back" href="#/">${ICON.back}All classes</a>
        <h1 class="class-title">${esc(deck.name)}</h1>

        <div class="summary">
          <p><b>${c.known}</b> of ${sel.length} known${c.learning ? `, <b class="t-learning">${c.learning}</b> still learning` : ""}</p>
          ${meter(c, sel.length)}
        </div>

        <label class="field">
          <span class="field-label">Cards to study</span>
          <span class="select">
            <select id="filter">
              <option value="">All cards (${cards.length})</option>
              ${["Part", "Topic", "Type"].filter(g => groups[g].size).map(g => `
                <optgroup label="${g === "Type" ? "Card type" : g}">
                  ${[...groups[g]].map(([t, n]) => `<option value="${esc(t)}" ${prefs.filter === t ? "selected" : ""}>${esc(prettyTag(t))} (${n})</option>`).join("")}
                </optgroup>`).join("")}
            </select>
          </span>
        </label>

        <div class="actions">
          <a class="btn primary big" href="${deckHref(deck, "cards")}">Study flashcards</a>
          <a class="btn" href="${deckHref(deck, "quiz")}" ${sel.length < 4 ? 'aria-disabled="true"' : ""}>Take a quiz</a>
          <a class="btn" href="${deckHref(deck, "missed")}" ${c.learning ? "" : 'aria-disabled="true"'}>Review missed${c.learning ? ` (${c.learning})` : ""}</a>
        </div>

        <div class="list-head">
          <h2>All cards</h2>
          <label class="search">${ICON.search}<input id="q" type="search" placeholder="Search" value="${esc(query)}" autocomplete="off" aria-label="Search cards"></label>
        </div>
        <ol class="rows" id="rows"></ol>
        <button class="link-btn" id="reset">Reset progress for this class</button>`;

      const rowsEl = app.querySelector("#rows");
      function drawRows() {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = sel.filter(c => terms.every(t => c.text.includes(t) || c.tags.some(x => x.toLowerCase().includes(t))));
        rowsEl.innerHTML = hits.length ? hits.map(card => {
          const st = statusOf(prog, card);
          return `<li class="row">
            <div class="row-front"><span class="dot ${st}" title="${st === "known" ? "Known" : st === "learning" ? "Still learning" : "Not studied yet"}"></span>${card.front}</div>
            <div class="row-back rich">${card.back}</div>
          </li>`;
        }).join("") : `<li class="row muted">No cards match “${esc(query)}”.</li>`;
      }
      drawRows();

      app.querySelector("#filter").onchange = e => { prefs.filter = e.target.value; setPrefs(deck.id, prefs); render(); };
      const q = app.querySelector("#q");
      q.oninput = () => { query = q.value; drawRows(); };
      app.querySelector("#reset").onclick = () => {
        if (confirm(`Reset progress for ${deck.name}? Every card goes back to not studied.`)) { store.del(progressKey(deck.id)); render(); }
      };
      app.querySelectorAll('[aria-disabled="true"]').forEach(a => a.addEventListener("click", e => e.preventDefault()));
    }
    render();
  }

  /* ---------- Flashcards ---------- */
  function newSession(deck, cards, missedOnly) {
    const prefs = getPrefs(deck.id);
    const prog = getProgress(deck.id);
    let pool = filtered(cards, prefs.filter);
    if (missedOnly) pool = pool.filter(c => statusOf(prog, c) === "learning");
    const q = pool.slice();
    if (prefs.shuffle) shuffle(q);
    return { deck, all: cards, missedOnly, queue: q, total: q.length, idx: 0, flipped: false, know: 0, learning: 0, history: [], missed: [], enter: false };
  }

  async function viewCards(deck, missedOnly) {
    quiz = null;
    const { cards } = await loadDeck(deck);
    if (!cards.length) return viewDeck(deck);
    if (!session || session.deck.id !== deck.id || session.missedOnly !== missedOnly) session = newSession(deck, cards, missedOnly);
    if (!session.total) { location.replace(deckHref(deck)); return; }
    renderCards();
  }

  function playerTop(deck, title, right) {
    return `<div class="player-top">
      <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close and go back to ${esc(deck.name)}">${ICON.close}</a>
      <div class="player-title">${title}</div>
      ${right || '<span class="icon-spacer"></span>'}
    </div>`;
  }

  function renderCards() {
    const s = session, deck = s.deck;
    if (s.idx >= s.queue.length) return renderCardsDone();
    const card = s.queue[s.idx];
    const prefs = getPrefs(deck.id);
    const left = s.queue.length - s.idx;
    const depth = Math.min(2, left - 1);
    const sub = s.missedOnly ? "Missed cards" : prefs.filter ? prettyTag(prefs.filter) : deck.name;
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>${s.idx + 1} of ${s.total}</b><small>${esc(sub)}</small>`,
          `<button class="icon-btn ${prefs.shuffle ? "on" : ""}" id="shuf" aria-pressed="${prefs.shuffle}" title="${prefs.shuffle ? "Shuffle is on" : "Shuffle is off"}" aria-label="Shuffle">${ICON.shuffle}</button>`)}
        <div class="track"><span style="width:${(s.idx / s.total) * 100}%"></span></div>
        <div class="tally">
          <span class="t-learning">Still learning <b>${s.learning}</b></span>
          <span class="t-known">Know it <b>${s.know}</b></span>
        </div>

        <div class="stage" data-depth="${depth}">
          <span class="under u1" aria-hidden="true"></span>
          <span class="under u2" aria-hidden="true"></span>
          <div class="drag ${s.enter && !reduceMotion() ? "enter" : ""}" id="flip" role="button" tabindex="0" aria-label="Flashcard. Press to flip.">
            <div class="lift">
              <div class="spin ${s.flipped ? "is-flipped" : ""}">
                <div class="face blank">
                  ${card.tags.length ? `<div class="face-tags">${card.tags.map(t => `<span>${esc(prettyTag(t))}</span>`).join("")}</div>` : ""}
                  <div class="face-q"><div class="q-text">${card.front}</div></div>
                  <div class="face-hint">Tap to flip</div>
                </div>
                <div class="face lined" aria-hidden="${!s.flipped}">
                  <div class="lined-head">${card.front}</div>
                  <div class="lined-body rich">${card.back}</div>
                </div>
              </div>
            </div>
            <span class="stamp stamp-learning" aria-hidden="true">Still learning</span>
            <span class="stamp stamp-known" aria-hidden="true">Know it</span>
          </div>
        </div>

        <div class="controls">
          <button class="choice-btn learning" id="no">${ICON.close}<span>Still learning</span></button>
          <button class="icon-btn undo" id="undo" aria-label="Undo last card" title="Undo" ${s.history.length ? "" : "disabled"}>${ICON.undo}</button>
          <button class="choice-btn known" id="yes">${ICON.check}<span>Know it</span></button>
        </div>
        <p class="keys"><kbd>Space</kbd> flip <kbd>←</kbd> still learning <kbd>→</kbd> know it <kbd>Z</kbd> undo</p>
      </div>`;
    s.enter = false;

    const drag = app.querySelector("#flip");
    attachSwipe(drag, { tap: flipCard, left: () => grade(false), right: () => grade(true) });
    app.querySelector("#no").onclick = () => fling(false);
    app.querySelector("#yes").onclick = () => fling(true);
    app.querySelector("#undo").onclick = undo;
    app.querySelector("#shuf").onclick = () => {
      const p = getPrefs(deck.id); p.shuffle = !p.shuffle; setPrefs(deck.id, p);
      const rest = s.queue.slice(s.idx);
      if (p.shuffle) shuffle(rest);
      else { const order = new Map(s.all.map((c, i) => [c.id, i])); rest.sort((a, b) => order.get(a.id) - order.get(b.id)); }
      s.queue.splice(s.idx, rest.length, ...rest);
      s.flipped = false;
      renderCards();
    };
  }

  function flipCard() {
    const s = session; if (!s) return;
    s.flipped = !s.flipped;
    const spin = app.querySelector(".spin"), lift = app.querySelector(".lift");
    if (!spin) return;
    spin.classList.toggle("is-flipped", s.flipped);
    const lined = app.querySelector(".face.lined"); if (lined) lined.setAttribute("aria-hidden", String(!s.flipped));
    if (lift && !reduceMotion()) { lift.classList.remove("lifting"); void lift.offsetWidth; lift.classList.add("lifting"); }
  }

  let flinging = false;
  function fling(good) {
    const el = app.querySelector("#flip");
    if (!el || flinging) return;
    if (reduceMotion()) return grade(good);
    flinging = true;
    el.classList.add(good ? "fly-right" : "fly-left");
    setTimeout(() => { flinging = false; grade(good); }, 260);
  }

  function grade(good) {
    const s = session; if (!s) return;
    const card = s.queue[s.idx]; if (!card) return;
    const prog = getProgress(s.deck.id);
    s.history.push({ idx: s.idx, prev: prog[card.id] || null, id: card.id, good });
    prog[card.id] = { s: good ? "known" : "learning", n: ((prog[card.id] || {}).n || 0) + 1, t: Date.now() };
    setProgress(s.deck.id, prog);
    if (good) s.know++; else { s.learning++; s.missed.push(card); }
    s.idx++; s.flipped = false; s.enter = true;
    renderCards();
  }

  function undo() {
    const s = session; const h = s && s.history.pop(); if (!h) return;
    const prog = getProgress(s.deck.id);
    if (h.prev) prog[h.id] = h.prev; else delete prog[h.id];
    setProgress(s.deck.id, prog);
    if (h.good) s.know--; else { s.learning--; s.missed.pop(); }
    s.idx = h.idx; s.flipped = false; s.enter = true;
    renderCards();
  }

  function renderCardsDone() {
    const s = session, deck = s.deck;
    const pct = s.total ? s.know / s.total : 0;
    const line = pct === 1 ? "You knew every card in this round." : pct >= 0.7 ? "Most of these are sticking." : "Another pass on the missed cards will help.";
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Round finished</b><small>${esc(deck.name)}</small>`)}
        <div class="track"><span style="width:100%"></span></div>
        <div class="result">
          <p class="result-num">${s.know}<span>of ${s.total}</span></p>
          <p class="result-line">${line}</p>
          <div class="result-actions">
            ${s.missed.length ? `<button class="btn primary big" id="again">Study the ${plural(s.missed.length, "missed card")}</button>` : ""}
            <button class="btn ${s.missed.length ? "" : "primary big"}" id="restart">Start the round over</button>
            <a class="btn" href="${deckHref(deck, "quiz")}">Take a quiz</a>
            <a class="link-btn" href="${deckHref(deck)}">Back to ${esc(deck.name)}</a>
          </div>
        </div>
      </div>`;
    const again = app.querySelector("#again");
    if (again) again.onclick = () => {
      const q = s.missed.slice(); if (getPrefs(deck.id).shuffle) shuffle(q);
      Object.assign(s, { queue: q, total: q.length, idx: 0, know: 0, learning: 0, history: [], missed: [], flipped: false, enter: true });
      renderCards();
    };
    app.querySelector("#restart").onclick = () => {
      session = newSession(deck, s.all, s.missedOnly);
      if (!session.total) location.hash = deckHref(deck); else renderCards();
    };
  }

  /* swipe / drag on the card */
  function attachSwipe(el, h) {
    let x0 = 0, y0 = 0, dx = 0, dragging = false, decided = false, horizontal = false, id = null;
    const TH = Math.min(110, window.innerWidth * 0.25);
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0 || flinging) return;
      id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = true; decided = false; horizontal = false;
    });
    el.addEventListener("pointermove", e => {
      if (!dragging || e.pointerId !== id) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!decided && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
        decided = true; horizontal = Math.abs(mx) > Math.abs(my);
        if (horizontal) { try { el.setPointerCapture(id); } catch (_) {} el.classList.add("dragging"); }
      }
      if (!horizontal) return;
      dx = mx;
      el.style.transform = `translateX(${dx}px) rotate(${dx / 24}deg)`;
      el.style.setProperty("--tint", Math.min(1, Math.abs(dx) / TH).toFixed(2));
      el.classList.toggle("toward-right", dx > 0);
      el.classList.toggle("toward-left", dx < 0);
    });
    const end = e => {
      if (!dragging || e.pointerId !== id) return;
      dragging = false;
      el.classList.remove("dragging");
      if (horizontal && Math.abs(dx) > TH) {
        flinging = true;
        el.style.removeProperty("transform");
        el.classList.add(dx > 0 ? "fly-right" : "fly-left");
        setTimeout(() => { flinging = false; dx > 0 ? h.right() : h.left(); }, 220);
        return;
      }
      el.style.transform = ""; el.style.removeProperty("--tint");
      el.classList.remove("toward-right", "toward-left");
      if (!decided && e.type === "pointerup" && !String(getSelection())) h.tap();
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); h.tap(); } });
  }

  /* ---------- Quiz ---------- */
  let quiz = null;
  const preview = (html, n) => { const t = stripHtml(html.replace(/<br\s*\/?>/gi, " ").replace(/<\/(p|li)>/gi, " ")).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
  const LETTERS = ["A", "B", "C", "D"];

  function buildQuiz(deck, cards) {
    const prefs = getPrefs(deck.id);
    const prog = getProgress(deck.id);
    const pool = filtered(cards, prefs.filter);
    const rank = c => ({ learning: 0, new: 1, known: 2 }[statusOf(prog, c)]) + Math.random() * 1.5;
    const picked = pool.slice().sort((a, b) => rank(a) - rank(b)).slice(0, Math.min(10, pool.length));
    shuffle(picked);
    const typeOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Type");
    const topicOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Topic");
    const qs = picked.map(card => {
      const others = cards.filter(c => c.id !== card.id && preview(c.back, 400) !== preview(card.back, 400));
      const score = c => (typeOf(c) && typeOf(c) === typeOf(card) ? 2 : 0) + (topicOf(c) && topicOf(c) === topicOf(card) ? 1 : 0) + Math.random();
      const choices = shuffle([card, ...others.sort((a, b) => score(b) - score(a)).slice(0, 3)]);
      return { card, choices, answer: choices.indexOf(card), picked: null };
    });
    return { deck, all: cards, qs, i: 0, score: 0 };
  }

  async function viewQuiz(deck) {
    session = null;
    const { cards } = await loadDeck(deck);
    const pool = filtered(cards, getPrefs(deck.id).filter);
    if (pool.length < 4 || cards.length < 4) { location.replace(deckHref(deck)); return; }
    if (!quiz || quiz.deck.id !== deck.id) quiz = buildQuiz(deck, cards);
    renderQuiz();
  }

  function renderQuiz() {
    const z = quiz, deck = z.deck;
    if (z.i >= z.qs.length) return renderQuizDone();
    const q = z.qs[z.i];
    const answered = q.picked !== null;
    const right = answered && q.picked === q.answer;
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Question ${z.i + 1} of ${z.qs.length}</b><small>${z.score} right so far</small>`)}
        <div class="track"><span style="width:${(z.i / z.qs.length) * 100}%"></span></div>

        <div class="q-card">
          ${q.card.tags.length ? `<div class="face-tags">${q.card.tags.map(t => `<span>${esc(prettyTag(t))}</span>`).join("")}</div>` : ""}
          <div class="q-text">${q.card.front}</div>
        </div>
        <p class="q-prompt ${answered ? (right ? "t-known" : "t-learning") : "muted"}" aria-live="polite">${answered ? (right ? "Correct." : "Not this one. The right answer is marked.") : "Pick the answer that matches."}</p>
        <div class="options">
          ${q.choices.map((c, i) => {
            let cls = "";
            if (answered) cls = i === q.answer ? "is-right" : i === q.picked ? "is-wrong" : "is-dim";
            return `<button class="option ${cls}" data-i="${i}" ${answered ? "disabled" : ""}><span class="opt-key">${LETTERS[i]}</span><span class="opt-text">${esc(preview(c.back, 260))}</span></button>`;
          }).join("")}
        </div>
        ${answered ? `
          <details class="full"><summary>Show the full card</summary><div class="rich">${q.card.back}</div></details>
          <button class="btn primary big wide" id="next">${z.i + 1 < z.qs.length ? "Next question" : "See results"}</button>` : ""}
        <p class="keys"><kbd>A</kbd>–<kbd>D</kbd> answer <kbd>Enter</kbd> next</p>
      </div>`;
    app.querySelectorAll(".option").forEach(b => b.onclick = () => answerQuiz(+b.dataset.i));
    const next = app.querySelector("#next");
    if (next) { next.onclick = nextQuiz; next.focus({ preventScroll: true }); }
  }

  function answerQuiz(i) {
    const z = quiz, q = z.qs[z.i];
    if (!q || q.picked !== null) return;
    q.picked = i;
    const good = i === q.answer;
    if (good) z.score++;
    const prog = getProgress(z.deck.id);
    prog[q.card.id] = { s: good ? "known" : "learning", n: ((prog[q.card.id] || {}).n || 0) + 1, t: Date.now() };
    setProgress(z.deck.id, prog);
    renderQuiz();
  }
  function nextQuiz() { if (!quiz) return; quiz.i++; renderQuiz(); window.scrollTo(0, 0); }

  function renderQuizDone() {
    const z = quiz, deck = z.deck;
    const missed = z.qs.filter(q => q.picked !== q.answer);
    const pct = z.score / z.qs.length;
    const line = pct === 1 ? "A perfect quiz." : pct >= 0.7 ? "Solid. The ones you missed are below." : "The ones you missed are below. They're now in Review missed.";
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Quiz results</b><small>${esc(deck.name)}</small>`)}
        <div class="track"><span style="width:100%"></span></div>
        <div class="result">
          <p class="result-num">${z.score}<span>of ${z.qs.length}</span></p>
          <p class="result-line">${line}</p>
          <div class="result-actions">
            <button class="btn primary big" id="newquiz">Take another quiz</button>
            ${missed.length ? `<a class="btn" href="${deckHref(deck, "missed")}">Study missed cards</a>` : ""}
            <a class="link-btn" href="${deckHref(deck)}">Back to ${esc(deck.name)}</a>
          </div>
        </div>
        ${missed.length ? `<h2 class="list-title">Cards you missed</h2><ol class="rows">${missed.map(q => `
          <li class="row"><div class="row-front"><span class="dot learning"></span>${q.card.front}</div><div class="row-back rich">${q.card.back}</div></li>`).join("")}</ol>` : ""}
      </div>`;
    app.querySelector("#newquiz").onclick = () => { quiz = buildQuiz(deck, z.all); renderQuiz(); window.scrollTo(0, 0); };
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const route = location.hash;
    if (session && /\/(cards|missed)$/.test(route) && session.idx < session.queue.length) {
      if (e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); flipCard(); }
      else if (e.key === "ArrowRight") fling(true);
      else if (e.key === "ArrowLeft") fling(false);
      else if (e.key.toLowerCase() === "z" || e.key === "Backspace") undo();
    } else if (quiz && /\/quiz$/.test(route) && quiz.i < quiz.qs.length) {
      const q = quiz.qs[quiz.i];
      const k = e.key.toUpperCase();
      const idx = LETTERS.indexOf(k) >= 0 ? LETTERS.indexOf(k) : /^[1-4]$/.test(e.key) ? +e.key - 1 : -1;
      if (q.picked === null && idx >= 0 && idx < q.choices.length) answerQuiz(idx);
      else if (q.picked !== null && (e.key === "Enter" || e.key === " " || e.key === "ArrowRight")) { e.preventDefault(); nextQuiz(); }
    }
  });

  /* ---------- router ---------- */
  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    window.scrollTo(0, 0);
    document.body.classList.toggle("in-player", parts[0] === "deck" && !!parts[2]);
    if (parts[0] === "deck") {
      const deck = deckList.find(d => d.id === parts[1]);
      if (!deck) return viewHome();
      if (parts[2] === "cards") return viewCards(deck, false);
      if (parts[2] === "missed") return viewCards(deck, true);
      if (parts[2] === "quiz") return viewQuiz(deck);
      return viewDeck(deck);
    }
    return viewHome();
  }

  (async function init() {
    try {
      const res = await fetch(DECKS_URL, { cache: "no-cache" });
      deckList = await res.json();
    } catch (e) {
      app.innerHTML = `<p>The class list didn't load. If you opened index.html straight from your computer, start a local server instead (see the README).</p>`;
      return;
    }
    window.addEventListener("hashchange", route);
    route();
  })();
})();
