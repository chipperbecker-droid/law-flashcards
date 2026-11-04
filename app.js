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
  let session = null;      // active flashcard session

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
        tags = (tagStr || "").split(/\s+/).filter(Boolean);
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

  const TYPE_TAGS = new Set(["case", "doctrine", "test", "statute", "rule", "concept", "definition", "element", "elements", "hypo", "policy", "factor", "factors"]);
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

  function filtered(cards, filter) {
    if (!filter) return cards;
    return cards.filter(c => c.tags.includes(filter));
  }
  function filterLabel(filter) { return filter ? prettyTag(filter) : "All cards"; }
  const deckHref = (deck, sub) => "#/deck/" + encodeURIComponent(deck.id) + (sub ? "/" + sub : "");

  const ICON = {
    cards: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="14" height="14" rx="2.5"/><path d="M7 3h11.5A2.5 2.5 0 0 1 21 5.5V17"/></svg>',
    quiz: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.3a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2.2-2.5 3.7M12 17.2v.1"/></svg>',
    redo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  };

  function ring(pct, size) {
    const r = 15.9, c = 2 * Math.PI * r;
    return `<svg class="ring" style="width:${size}px;height:${size}px" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="${r}" class="ring-bg"/>
      <circle cx="18" cy="18" r="${r}" class="ring-fg" stroke-dasharray="${(pct / 100) * c} ${c}"/>
    </svg>`;
  }

  /* ---------- Home ---------- */
  async function viewHome() {
    session = null; quiz = null;
    const loaded = await Promise.all(deckList.map(loadDeck));
    app.innerHTML = `
      <section class="hero">
        <h1>What are we studying?</h1>
        <p class="muted">Pick a class to start. Your progress saves automatically on this device.</p>
      </section>
      <div class="decks">
        ${deckList.map((d, i) => {
          const { cards } = loaded[i];
          const color = `style="--deck:${d.color || "var(--accent)"}"`;
          if (!cards.length) return `
            <div class="deck empty" ${color}>
              <div class="deck-top"><span class="deck-abbr">${esc(d.short || d.name[0])}</span></div>
              <h2>${esc(d.name)}</h2>
              <p class="muted small">No cards yet. Add <code>decks/${esc(d.file)}</code> to the repo.</p>
            </div>`;
          const c = counts(cards, getProgress(d.id));
          const pct = Math.round((c.known / cards.length) * 100);
          return `
            <a class="deck" href="${deckHref(d)}" ${color}>
              <div class="deck-top">
                <span class="deck-abbr">${esc(d.short || d.name[0])}</span>
                <span class="deck-ring">${ring(pct, 44)}<b>${pct}%</b></span>
              </div>
              <h2>${esc(d.name)}</h2>
              <p class="muted small">${cards.length} cards · ${c.known} known${c.learning ? ` · ${c.learning} still learning` : ""}</p>
              <span class="deck-cta">${c.known || c.learning ? "Continue studying" : "Start studying"} →</span>
            </a>`;
        }).join("")}
      </div>`;
  }

  /* ---------- Deck page ---------- */
  async function viewDeck(deck) {
    session = null; quiz = null;
    const { cards } = await loadDeck(deck);
    const color = deck.color || "var(--accent)";
    if (!cards.length) {
      app.innerHTML = `<a class="back" href="#/">${ICON.back} All classes</a><h1>${esc(deck.name)}</h1>
        <div class="notice"><p>No cards yet. Upload a CSV named <code>${esc(deck.file)}</code> into the <code>decks/</code> folder of the repo
        (columns: front, back, tags). An Anki “Notes in Plain Text” export works as-is.</p></div>`;
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
      const pct = sel.length ? Math.round((c.known / sel.length) * 100) : 0;
      app.innerHTML = `
        <div style="--deck:${color}">
        <a class="back" href="#/">${ICON.back} All classes</a>
        <h1>${esc(deck.name)}</h1>

        <label class="select-wrap">
          <span class="sr">Choose which cards to study</span>
          <select id="filter">
            <option value="">All cards (${cards.length})</option>
            ${["Part", "Topic", "Type"].filter(g => groups[g].size).map(g => `
              <optgroup label="${g === "Type" ? "Card type" : g}">
                ${[...groups[g]].map(([t, n]) => `<option value="${esc(t)}" ${prefs.filter === t ? "selected" : ""}>${esc(prettyTag(t))} (${n})</option>`).join("")}
              </optgroup>`).join("")}
          </select>
        </label>

        <div class="stats">
          <div class="stat-ring">${ring(pct, 64)}<b>${pct}%</b></div>
          <div class="stat"><b class="known">${c.known}</b><span>Know</span></div>
          <div class="stat"><b class="learning">${c.learning}</b><span>Still learning</span></div>
          <div class="stat"><b>${c.new}</b><span>Not studied</span></div>
        </div>

        <div class="modes">
          <a class="mode primary" href="${deckHref(deck, "cards")}">
            <span class="mode-icon">${ICON.cards}</span>
            <span><b>Flashcards</b><small>Flip, then swipe right if you know it</small></span>
          </a>
          <a class="mode" href="${deckHref(deck, "quiz")}" ${sel.length < 4 ? 'aria-disabled="true"' : ""}>
            <span class="mode-icon">${ICON.quiz}</span>
            <span><b>Quiz</b><small>Multiple choice, ${Math.min(10, sel.length)} questions</small></span>
          </a>
          <a class="mode" href="${deckHref(deck, "missed")}" ${c.learning ? "" : 'aria-disabled="true"'}>
            <span class="mode-icon">${ICON.redo}</span>
            <span><b>Review missed</b><small>${c.learning ? `${c.learning} card${c.learning === 1 ? "" : "s"} you're still learning` : "Nothing missed yet"}</small></span>
          </a>
        </div>

        <div class="terms-head">
          <h2>Cards in this set <span class="muted">(${sel.length})</span></h2>
          <button class="btn-text" id="reset">Reset progress</button>
        </div>
        <label class="search">${ICON.search}<input id="q" type="search" placeholder="Search cards" value="${esc(query)}" autocomplete="off"></label>
        <div class="terms" id="terms"></div>
        </div>`;

      const termsEl = app.querySelector("#terms");
      function drawTerms() {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = sel.filter(c => terms.every(t => c.text.includes(t) || c.tags.some(x => x.toLowerCase().includes(t))));
        termsEl.innerHTML = hits.length ? hits.map(card => {
          const st = statusOf(prog, card);
          return `<div class="term">
            <div class="term-front"><span class="dot ${st}" title="${st === "known" ? "Know" : st === "learning" ? "Still learning" : "Not studied"}"></span>${card.front}</div>
            <div class="term-back rich">${card.back}</div>
          </div>`;
        }).join("") : `<p class="muted">No cards match “${esc(query)}”.</p>`;
      }
      drawTerms();

      app.querySelector("#filter").onchange = e => { prefs.filter = e.target.value; setPrefs(deck.id, prefs); render(); };
      const q = app.querySelector("#q");
      q.oninput = () => { query = q.value; drawTerms(); };
      app.querySelector("#reset").onclick = () => {
        if (confirm(`Reset your progress for ${deck.name}? Every card goes back to “not studied”.`)) { store.del(progressKey(deck.id)); render(); }
      };
      app.querySelectorAll('.mode[aria-disabled="true"]').forEach(a => a.addEventListener("click", e => e.preventDefault()));
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
    return { deck, all: cards, missedOnly, queue: q, total: q.length, idx: 0, flipped: false, know: 0, learning: 0, history: [], missed: [] };
  }

  async function viewCards(deck, missedOnly) {
    quiz = null;
    const { cards } = await loadDeck(deck);
    if (!cards.length) return viewDeck(deck);
    if (!session || session.deck.id !== deck.id || session.missedOnly !== missedOnly) session = newSession(deck, cards, missedOnly);
    if (!session.total) { location.replace(deckHref(deck)); return; }
    renderCards();
  }

  function renderCards() {
    const s = session, deck = s.deck;
    const color = deck.color || "var(--accent)";
    if (s.idx >= s.queue.length) return renderCardsDone();
    const card = s.queue[s.idx];
    const prefs = getPrefs(deck.id);
    const pct = (s.idx / s.total) * 100;
    app.innerHTML = `
      <div class="player" style="--deck:${color}">
        <div class="player-top">
          <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close">${ICON.close}</a>
          <div class="player-title"><b>${s.idx + 1} / ${s.total}</b><small>${esc(deck.short || deck.name)}${s.missedOnly ? " · Missed cards" : prefs.filter ? " · " + esc(prettyTag(prefs.filter)) : ""}</small></div>
          <button class="icon-btn ${prefs.shuffle ? "on" : ""}" id="shuf" aria-pressed="${prefs.shuffle}" title="Shuffle" aria-label="Shuffle">${ICON.shuffle}</button>
        </div>
        <div class="track"><span style="width:${pct}%"></span></div>
        <div class="tally">
          <span class="pill learning"><b>${s.learning}</b> Still learning</span>
          <span class="pill known">Know <b>${s.know}</b></span>
        </div>

        <div class="stage">
          <div class="flip ${s.flipped ? "is-flipped" : ""}" id="flip" role="button" tabindex="0" aria-label="Flashcard. Tap to flip.">
            <div class="badge badge-learning">Still learning</div>
            <div class="badge badge-known">Know</div>
            <div class="face front">
              <div class="face-tags">${card.tags.map(t => `<span>${esc(prettyTag(t))}</span>`).join("")}</div>
              <div class="face-body"><div class="term-text">${card.front}</div></div>
              <div class="face-hint">Tap to flip</div>
            </div>
            <div class="face back">
              <div class="face-tags"><span>Answer</span></div>
              <div class="face-body scroll"><div class="rich">${card.back}</div></div>
            </div>
          </div>
        </div>

        <div class="controls">
          <button class="round learning" id="no" aria-label="Still learning">${ICON.close}<span>Still learning</span></button>
          <button class="round ghost" id="undo" aria-label="Undo" ${s.history.length ? "" : "disabled"}>${ICON.undo}</button>
          <button class="round known" id="yes" aria-label="Know it">${ICON.check}<span>Know it</span></button>
        </div>
        <p class="keys">Tap card or <kbd>Space</kbd> to flip · <kbd>←</kbd> still learning · <kbd>→</kbd> know it · <kbd>Z</kbd> undo</p>
      </div>`;

    const flip = app.querySelector("#flip");
    attachSwipe(flip, {
      tap: () => { s.flipped = !s.flipped; flip.classList.toggle("is-flipped", s.flipped); },
      left: () => grade(false),
      right: () => grade(true),
    });
    app.querySelector("#no").onclick = () => fling(false);
    app.querySelector("#yes").onclick = () => fling(true);
    app.querySelector("#undo").onclick = undo;
    app.querySelector("#shuf").onclick = () => {
      const p = getPrefs(deck.id); p.shuffle = !p.shuffle; setPrefs(deck.id, p);
      // reshuffle (or restore order of) the cards not yet seen
      const rest = s.queue.slice(s.idx);
      if (p.shuffle) shuffle(rest);
      else { const order = new Map(s.all.map((c, i) => [c.id, i])); rest.sort((a, b) => order.get(a.id) - order.get(b.id)); }
      s.queue.splice(s.idx, rest.length, ...rest);
      s.flipped = false;
      renderCards();
    };
  }

  function fling(good) {
    const el = app.querySelector("#flip");
    if (!el) return grade(good);
    el.classList.add(good ? "fly-right" : "fly-left");
    setTimeout(() => grade(good), 180);
  }

  function grade(good) {
    const s = session; if (!s) return;
    const card = s.queue[s.idx];
    if (!card) return;
    const prog = getProgress(s.deck.id);
    s.history.push({ idx: s.idx, prev: prog[card.id] || null, id: card.id, good });
    prog[card.id] = { s: good ? "known" : "learning", n: ((prog[card.id] || {}).n || 0) + 1, t: Date.now() };
    setProgress(s.deck.id, prog);
    if (good) s.know++; else { s.learning++; s.missed.push(card); }
    s.idx++; s.flipped = false;
    renderCards();
  }

  function undo() {
    const s = session; const h = s && s.history.pop(); if (!h) return;
    const prog = getProgress(s.deck.id);
    if (h.prev) prog[h.id] = h.prev; else delete prog[h.id];
    setProgress(s.deck.id, prog);
    if (h.good) s.know--; else { s.learning--; s.missed.pop(); }
    s.idx = h.idx; s.flipped = false;
    renderCards();
  }

  function renderCardsDone() {
    const s = session, deck = s.deck;
    const pct = s.total ? Math.round((s.know / s.total) * 100) : 0;
    app.innerHTML = `
      <div class="player" style="--deck:${deck.color || "var(--accent)"}">
        <div class="player-top">
          <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close">${ICON.close}</a>
          <div class="player-title"><b>Done</b><small>${esc(deck.short || deck.name)}</small></div>
          <span style="width:40px"></span>
        </div>
        <div class="track"><span style="width:100%"></span></div>
        <div class="done">
          <div class="done-ring">${ring(pct, 140)}<b>${pct}%</b></div>
          <h1>${pct === 100 ? "You know every card here." : pct >= 70 ? "Nice work. Almost there." : "Good round. Keep going."}</h1>
          <div class="done-stats">
            <span class="pill known">Know <b>${s.know}</b></span>
            <span class="pill learning"><b>${s.learning}</b> Still learning</span>
          </div>
          <div class="done-actions">
            ${s.missed.length ? `<button class="btn primary" id="again">Keep reviewing ${s.missed.length} missed card${s.missed.length === 1 ? "" : "s"}</button>` : ""}
            <button class="btn" id="restart">Restart flashcards</button>
            <a class="btn" href="${deckHref(deck, "quiz")}">Take a quiz</a>
            <a class="btn-text" href="${deckHref(deck)}">Back to ${esc(deck.name)}</a>
          </div>
        </div>
      </div>`;
    const again = app.querySelector("#again");
    if (again) again.onclick = () => {
      const q = s.missed.slice(); if (getPrefs(deck.id).shuffle) shuffle(q);
      Object.assign(s, { queue: q, total: q.length, idx: 0, know: 0, learning: 0, history: [], missed: [], flipped: false });
      renderCards();
    };
    app.querySelector("#restart").onclick = () => { session = newSession(deck, s.all, s.missedOnly); if (!session.total) location.hash = deckHref(deck); else renderCards(); };
  }

  /* swipe / drag on the card */
  function attachSwipe(el, h) {
    let x0 = 0, y0 = 0, dx = 0, dragging = false, decided = false, horizontal = false, id = null;
    const TH = Math.min(110, window.innerWidth * 0.25);
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
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
      el.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
      el.style.setProperty("--tint", Math.min(1, Math.abs(dx) / TH));
      el.classList.toggle("toward-right", dx > 0);
      el.classList.toggle("toward-left", dx < 0);
    });
    const end = e => {
      if (!dragging || e.pointerId !== id) return;
      dragging = false;
      el.classList.remove("dragging");
      if (horizontal && Math.abs(dx) > TH) {
        el.classList.add(dx > 0 ? "fly-right" : "fly-left");
        setTimeout(() => (dx > 0 ? h.right() : h.left()), 160);
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

  function buildQuiz(deck, cards) {
    const prefs = getPrefs(deck.id);
    const prog = getProgress(deck.id);
    const pool = filtered(cards, prefs.filter);
    // favor cards you don't know yet
    const rank = c => ({ learning: 0, new: 1, known: 2 }[statusOf(prog, c)]) + Math.random() * 1.5;
    const picked = pool.slice().sort((a, b) => rank(a) - rank(b)).slice(0, Math.min(10, pool.length));
    shuffle(picked);
    const typeOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Type");
    const topicOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Topic");
    const qs = picked.map(card => {
      const others = cards.filter(c => c.id !== card.id && preview(c.back, 400) !== preview(card.back, 400));
      const score = c => (typeOf(c) && typeOf(c) === typeOf(card) ? 2 : 0) + (topicOf(c) && topicOf(c) === topicOf(card) ? 1 : 0) + Math.random();
      const distractors = others.sort((a, b) => score(b) - score(a)).slice(0, 3);
      const choices = shuffle([card, ...distractors]);
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
    app.innerHTML = `
      <div class="player" style="--deck:${deck.color || "var(--accent)"}">
        <div class="player-top">
          <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close">${ICON.close}</a>
          <div class="player-title"><b>${z.i + 1} / ${z.qs.length}</b><small>${esc(deck.short || deck.name)} · Quiz</small></div>
          <span class="pill known" style="min-width:40px;justify-content:center"><b>${z.score}</b></span>
        </div>
        <div class="track"><span style="width:${(z.i / z.qs.length) * 100}%"></span></div>

        <div class="q-card">
          <div class="face-tags">${q.card.tags.map(t => `<span>${esc(prettyTag(t))}</span>`).join("")}</div>
          <div class="term-text">${q.card.front}</div>
        </div>
        <p class="q-prompt muted">${answered ? (q.picked === q.answer ? "<b class='known'>Correct!</b>" : "<b class='learning'>Not quite.</b> The right answer is highlighted.") : "Choose the matching answer"}</p>
        <div class="choices">
          ${q.choices.map((c, i) => {
            let cls = "";
            if (answered) { if (i === q.answer) cls = "right"; else if (i === q.picked) cls = "wrong"; else cls = "dim"; }
            return `<button class="choice ${cls}" data-i="${i}" ${answered ? "disabled" : ""}><span class="choice-n">${i + 1}</span><span class="choice-t">${esc(preview(c.back, 260))}</span></button>`;
          }).join("")}
        </div>
        ${answered ? `
          <details class="full-answer"><summary>See the full answer</summary><div class="rich">${q.card.back}</div></details>
          <button class="btn primary wide" id="next">${z.i + 1 < z.qs.length ? "Continue" : "See results"}</button>` : ""}
        <p class="keys"><kbd>1</kbd>–<kbd>4</kbd> to answer · <kbd>Enter</kbd> to continue</p>
      </div>`;
    app.querySelectorAll(".choice").forEach(b => b.onclick = () => answerQuiz(+b.dataset.i));
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
    const pct = Math.round((z.score / z.qs.length) * 100);
    const missed = z.qs.filter(q => q.picked !== q.answer);
    app.innerHTML = `
      <div class="player" style="--deck:${deck.color || "var(--accent)"}">
        <div class="player-top">
          <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close">${ICON.close}</a>
          <div class="player-title"><b>Results</b><small>${esc(deck.short || deck.name)} · Quiz</small></div>
          <span style="width:40px"></span>
        </div>
        <div class="track"><span style="width:100%"></span></div>
        <div class="done">
          <div class="done-ring">${ring(pct, 140)}<b>${z.score}/${z.qs.length}</b></div>
          <h1>${pct === 100 ? "Perfect score!" : pct >= 70 ? "Solid. Review the misses below." : "Keep at it. Review the misses below."}</h1>
          <div class="done-actions">
            <button class="btn primary" id="newquiz">New quiz</button>
            ${missed.length ? `<a class="btn" href="${deckHref(deck, "missed")}">Flashcards for missed cards</a>` : ""}
            <a class="btn-text" href="${deckHref(deck)}">Back to ${esc(deck.name)}</a>
          </div>
        </div>
        ${missed.length ? `<h2 class="section-h">Review these</h2><div class="terms">${missed.map(q => `
          <div class="term"><div class="term-front"><span class="dot learning"></span>${q.card.front}</div><div class="term-back rich">${q.card.back}</div></div>`).join("")}</div>` : ""}
      </div>`;
    app.querySelector("#newquiz").onclick = () => { quiz = buildQuiz(deck, z.all); renderQuiz(); };
  }

  /* ---------- keyboard ---------- */
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const route = location.hash;
    if (session && /\/(cards|missed)$/.test(route) && session.idx < session.queue.length) {
      if (e.key === " " || e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault(); session.flipped = !session.flipped;
        const f = app.querySelector("#flip"); if (f) f.classList.toggle("is-flipped", session.flipped);
      } else if (e.key === "ArrowRight") fling(true);
      else if (e.key === "ArrowLeft") fling(false);
      else if (e.key.toLowerCase() === "z" || e.key === "Backspace") undo();
    } else if (quiz && /\/quiz$/.test(route) && quiz.i < quiz.qs.length) {
      const q = quiz.qs[quiz.i];
      if (q.picked === null && /^[1-4]$/.test(e.key)) answerQuiz(+e.key - 1);
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
      app.innerHTML = `<p>Couldn't load <code>${DECKS_URL}</code>. If you opened index.html directly from your computer, run a local server instead (see README).</p>`;
      return;
    }
    window.addEventListener("hashchange", route);
    route();
  })();
})();
