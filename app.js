/* Issue Spotter: a dependency-free static study app for law school issue-spotter exams.
 * decks/decks.json lists classes. Each class has:
 *   - a CSV of flashcards (Anki "Notes in Plain Text" export works as-is), and
 *   - an issue map (decks/<id>.issues.json): topics -> issues, each with a trigger,
 *     a rule statement, elements, exceptions, authorities, and an exam tip.
 * Modes: attack outline (with self-test), rule drill, issue spotting, flashcards, quiz.
 */
(function () {
  "use strict";

  const app = document.getElementById("app");
  const DECKS_URL = "decks/decks.json";
  let deckList = [];
  const cache = {};        // deckId -> { cards, topics, issues, error }
  let session = null;      // flashcard session
  let drill = null;        // rule drill session
  let spot = null;         // issue spotting session
  let quiz = null;         // multiple-choice quiz

  /* ---------- storage ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  const progressKey = id => "lf:progress:" + id;   // card progress
  const issueKey = id => "lf:issues:" + id;        // issue progress
  const prefsKey = id => "lf:prefs:" + id;

  /* ---------- theme ---------- */
  const root = document.documentElement;
  const savedTheme = store.get("lf:theme", null);
  if (savedTheme) root.dataset.theme = savedTheme;
  document.getElementById("themeBtn").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("lf:theme", root.dataset.theme);
  });

  /* ---------- helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stripHtml = s => { const d = document.createElement("div"); d.innerHTML = s; return d.textContent || ""; };
  function hash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function prettyTag(t) { return t.replace(/_/g, " ").replace(/^Part(?=[A-Z])/, "Part ").replace(/\bArt (I+)\b/, "Art. $1").replace(/ 11-5 reading$/, ""); }
  const deckHref = (deck, sub) => "#/deck/" + encodeURIComponent(deck.id) + (sub ? "/" + sub : "");

  // Italicize case names ("A v. B", "In re X", "Matter of X") in plain text. Escapes & < > first.
  function legalize(text) {
    let s = String(text).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const tok = "(?:[A-Z][\\w.'\\-]*(?:&amp;[\\w.'\\-]*)?|&amp;)";
    const party = `${tok}(?:\\s(?:of|the|and|for|de|&amp;)\\s${tok}|\\s${tok}){0,5}`;
    s = s.replace(new RegExp(`\\b(${party}\\s+v\\.\\s+${party})`, "g"), "<i>$1</i>");
    s = s.replace(/\b(In re [A-Z][\w.'\-]*(?: [A-Z][\w.'\-]*){0,3}|Matter of [A-Z][\w.'\-]*(?: [A-Z][\w.'\-]*){0,2})/g, "<i>$1</i>");
    s = s.replace(/<i>(<i>)+/g, "<i>").replace(/(<\/i>)+/g, "</i>");
    return s;
  }

  const ICON = {
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  };

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
    let header = null;
    if (rows.length && /^(front|question|term)$/i.test(rows[0][0].trim())) header = rows.shift().map(h => h.trim().toLowerCase());
    const GROUP_COLS = { part: "Part", unit: "Part", type: "Type", topic: "Topic", subject: "Topic", category: "Topic" };
    const skipCols = new Set(Object.values(special));
    const cards = []; const seen = {};
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
        tags = (tagStr || "").split(/\s+/).filter(Boolean).map(t => (t.includes("::") ? t.split("::").slice(1).join(" / ") : t));
      }
      if (!front) return;
      // Strip the Anki "Outline x.y" source footers from the back; keep them as a source note.
      let source = "";
      back = back.replace(/<div style="font-size:smaller;color:gray">(.*?)<\/div>/i, (_, s) => { source = stripHtml(s); return ""; });
      let id = hash(front + "\u0000" + back);
      seen[id] = (seen[id] || 0) + 1;
      if (seen[id] > 1) id += "-" + seen[id];
      cards.push({ id, front, back, source, tags, gmap, text: (stripHtml(front) + " " + stripHtml(back)).toLowerCase() });
    });
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
  const typeOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Type");
  const topicTagOf = c => c.tags.find(t => (c.gmap[t] || groupFor(t)) === "Topic");

  /* ---------- issue maps ---------- */
  // Flatten topics -> issues and link each card to a topic and (best-effort) an issue.
  function linkIssues(cards, map) {
    const topics = (map && map.topics) || [];
    const issues = [];
    topics.forEach((t, ti) => {
      t.order = ti;
      t.issues.forEach((is, ii) => { is.topic = t; is.order = ii; issues.push(is); });
    });
    const byTag = new Map();
    topics.forEach(t => (t.tags || []).forEach(tag => byTag.set(tag.toLowerCase(), t)));
    const STOP = new Set(["the", "and", "for", "its", "own", "not", "who", "what", "when", "does", "under", "with", "from", "that", "this", "than", "into", "rule", "case", "law", "act", "test", "of", "or"]);
    const words = s => stripHtml(s).toLowerCase().replace(/[^a-z0-9§ ]+/g, " ").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    // Keywords per issue: its name counts double, its authorities once; words every issue in the
    // topic shares (e.g. a case cited by all of them) are dropped so they don't decide the match.
    issues.forEach(is => {
      is.keys = new Map();
      words(is.name).forEach(w => is.keys.set(w, 2));
      (is.authorities || []).forEach(a => words(a).forEach(w => { if (!is.keys.has(w)) is.keys.set(w, 1); }));
    });
    topics.forEach(t => {
      if (t.issues.length < 2) return;
      const shared = [...t.issues[0].keys.keys()].filter(w => t.issues.every(is => is.keys.has(w)));
      shared.forEach(w => t.issues.forEach(is => is.keys.delete(w)));
    });
    cards.forEach(c => {
      const tt = c.tags.map(t => t.toLowerCase());
      // Prefer a topic tag match; fall back to any tag.
      let topic = null;
      for (const t of tt) { if (byTag.has(t)) { topic = byTag.get(t); break; } }
      c.topic = topic;
      if (!topic) { c.issue = null; return; }
      const cw = new Set(words(c.front + " " + c.back));
      let best = null, bestScore = 0;
      topic.issues.forEach(is => {
        let s = 0; is.keys.forEach((wt, k) => { if (cw.has(k)) s += wt; });
        if (s > bestScore) { bestScore = s; best = is; }
      });
      c.issue = best || topic.issues[0];
    });
    topics.forEach(t => { t.cards = cards.filter(c => c.topic === t); });
    issues.forEach(is => { is.cards = cards.filter(c => c.issue === is); });
    return { topics, issues };
  }

  async function loadDeck(deck) {
    if (cache[deck.id]) return cache[deck.id];
    const out = { cards: [], topics: [], issues: [], intro: "" };
    try {
      const res = await fetch("decks/" + deck.file, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status === 404 ? "missing" : "HTTP " + res.status);
      out.cards = parseDeck(await res.text());
    } catch (e) { out.error = e.message; }
    if (deck.issues) {
      try {
        const res = await fetch("decks/" + deck.issues, { cache: "no-cache" });
        if (res.ok) { const map = await res.json(); out.intro = map.intro || ""; Object.assign(out, linkIssues(out.cards, map)); }
      } catch (e) { /* no issue map */ }
    }
    cache[deck.id] = out;
    return out;
  }

  /* ---------- progress ---------- */
  function getProgress(id) { return store.get(progressKey(id), {}); }
  function setProgress(id, p) { store.set(progressKey(id), p); }
  function statusOf(prog, card) { return prog[card.id] ? prog[card.id].s : "new"; }
  function counts(cards, prog) { const c = { known: 0, learning: 0, new: 0 }; cards.forEach(card => c[statusOf(prog, card)]++); return c; }
  function getIssueProg(id) { return store.get(issueKey(id), {}); }
  function setIssueProg(id, p) { store.set(issueKey(id), p); }
  const issueStatus = (ip, is) => (ip[is.id] ? ip[is.id].s : "new");   // solid | shaky | blank | new
  function issueCounts(issues, ip) { const c = { solid: 0, shaky: 0, blank: 0, new: 0 }; issues.forEach(is => c[issueStatus(ip, is)]++); return c; }
  function markIssue(deckId, is, s) {
    const ip = getIssueProg(deckId);
    ip[is.id] = { s, n: ((ip[is.id] || {}).n || 0) + 1, t: Date.now() };
    setIssueProg(deckId, ip);
  }
  function getPrefs(id) { return Object.assign({ filter: "", topic: "", shuffle: true, selfTest: false }, store.get(prefsKey(id), {})); }
  function setPrefs(id, p) { store.set(prefsKey(id), p); }
  const filtered = (cards, f) => (f ? cards.filter(c => c.tags.includes(f)) : cards);
  const scopedIssues = (data, topicId) => (topicId ? data.issues.filter(is => is.topic.id === topicId) : data.issues);
  const scopedCards = (data, prefs) => {
    let cards = data.cards;
    if (prefs.topic) { const t = data.topics.find(x => x.id === prefs.topic); if (t) cards = t.cards; }
    return filtered(cards, prefs.filter);
  };

  function issueMeter(c, total) {
    const pct = n => (total ? (n / total) * 100 : 0);
    return `<div class="meter" role="img" aria-label="${c.solid} solid, ${c.shaky} shaky, ${c.blank} blank, out of ${total}">
      <span class="m-known" style="width:${pct(c.solid)}%"></span><span class="m-shaky" style="width:${pct(c.shaky)}%"></span><span class="m-learning" style="width:${pct(c.blank)}%"></span></div>`;
  }
  function cardMeter(c, total) {
    const k = total ? (c.known / total) * 100 : 0, l = total ? (c.learning / total) * 100 : 0;
    return `<div class="meter" role="img" aria-label="${c.known} known, ${c.learning} still learning, out of ${total}"><span class="m-known" style="width:${k}%"></span><span class="m-learning" style="width:${l}%"></span></div>`;
  }

  /* ---------- rendering pieces shared by outline, drill, spot, cards ---------- */
  function issueBody(is, opts) {
    opts = opts || {};
    const els = (is.elements || []).length ? `<ol class="elements">${is.elements.map(e => `<li>${legalize(e)}</li>`).join("")}</ol>` : "";
    const exc = (is.exceptions || []).length ? `<span class="rule-lbl">Exceptions and limits</span><ul class="exceptions">${is.exceptions.map(e => `<li>${legalize(e)}</li>`).join("")}</ul>` : "";
    const auth = (is.authorities || []).length ? `<p class="authorities">${is.authorities.map(a => `<span>${esc(a)}</span>`).join("")}</p>` : "";
    const tip = is.tip && !opts.noTip ? `<p class="tip"><span class="lbl">On the exam</span>${legalize(is.tip)}</p>` : "";
    return `<div class="reveal-wrap ${opts.shown ? "shown" : ""}">
      <p class="rule"><span class="rule-lbl">Rule</span>${legalize(is.rule)}</p>
      ${els}${exc}${auth}
    </div>${tip}`;
  }
  const triggerLine = (is, marked) => `<p class="issue-trigger"><span class="lbl">Watch for</span>${marked ? `<mark>${esc(is.trigger)}</mark>` : esc(is.trigger)}</p>`;

  /* ---------- Home ---------- */
  async function viewHome() {
    session = drill = spot = quiz = null;
    const loaded = await Promise.all(deckList.map(loadDeck));
    app.innerHTML = `
      <section class="home-head">
        <h1>Your exams, issue by issue</h1>
        <p class="lede">Each class is an attack outline: the issues a fact pattern can raise, what facts trigger them, the rule with its elements, and the exceptions that earn the extra points.</p>
      </section>
      <ul class="classes">
        ${deckList.map((d, i) => {
          const data = loaded[i];
          const ic = issueCounts(data.issues, getIssueProg(d.id));
          const cc = counts(data.cards, getProgress(d.id));
          const started = ic.solid + ic.shaky + ic.blank;
          return `<li><a class="class-row" href="${deckHref(d)}">
            <h2>${esc(d.name)}</h2>
            <div class="class-stats">
              <span><b>${data.issues.length}</b> issues in ${plural(data.topics.length, "topic")}</span>
              <span><b>${data.cards.length}</b> cards</span>
              <span>${started ? `<b>${ic.solid}</b> solid, ${ic.shaky} shaky, ${ic.blank} blank` : "Not drilled yet"}${cc.known ? ` · ${cc.known} cards known` : ""}</span>
            </div>
            ${issueMeter(ic, data.issues.length)}
          </a></li>`;
        }).join("")}
      </ul>
      <section class="how">
        <h3>How to use this before an exam</h3>
        <ol>
          <li><b>Read the outline</b> once, top to bottom, so the order of issues is in your head.</li>
          <li><b>Drill the rules</b> out loud. Say the rule and its elements before you reveal them, then grade yourself honestly.</li>
          <li><b>Spot issues</b> from triggering facts until the facts themselves call up the rule.</li>
          <li><b>Flashcards and quizzes</b> for the case names, section numbers, and lists that fill in the application.</li>
        </ol>
      </section>`;
  }

  /* ---------- Class page: attack outline + cards ---------- */
  async function viewDeck(deck, tab) {
    session = drill = spot = quiz = null;
    const data = await loadDeck(deck);
    const prefs = getPrefs(deck.id);
    if (prefs.topic && !data.topics.some(t => t.id === prefs.topic)) prefs.topic = "";
    if (prefs.filter && !data.cards.some(c => c.tags.includes(prefs.filter))) prefs.filter = "";
    tab = tab === "cards" ? "cards" : "outline";
    let query = "";

    if (!data.cards.length && !data.issues.length) {
      app.innerHTML = `
        <a class="back" href="#/">${ICON.back}All classes</a>
        <h1 class="class-title">${esc(deck.name)}</h1>
        <div class="empty">
          <p class="empty-lead">This class has nothing to study yet.</p>
          <p class="muted">Upload a CSV named <code>${esc(deck.file)}</code> to the <code>decks</code> folder on GitHub. Columns are front, back, and optional tags.</p>
        </div>`;
      return;
    }

    function render() {
      const ip = getIssueProg(deck.id);
      const prog = getProgress(deck.id);
      const scopeTopic = prefs.topic ? data.topics.find(t => t.id === prefs.topic) : null;
      const issues = scopedIssues(data, prefs.topic);
      const cards = scopedCards(data, prefs);
      const ic = issueCounts(issues, ip);
      const cc = counts(cards, prog);
      const sub = scopeTopic ? scopeTopic.id : "";
      const sfx = sub ? "/" + encodeURIComponent(sub) : "";
      app.innerHTML = `
        <a class="back" href="#/">${ICON.back}All classes</a>
        <h1 class="class-title">${esc(deck.name)}</h1>
        ${data.intro ? `<p class="class-sub">${esc(data.intro)}</p>` : ""}
        <div class="study-bar">
          ${issues.length ? `<a class="btn primary" href="${deckHref(deck, "drill")}${sfx}">Drill rules</a>` : ""}
          ${issues.length >= 4 || data.issues.length >= 4 ? `<a class="btn" href="${deckHref(deck, "spot")}${sfx}">Spot issues</a>` : ""}
          ${cards.length ? `<a class="btn" href="${deckHref(deck, "cards")}">Flashcards</a>` : ""}
          ${cards.length >= 4 ? `<a class="btn" href="${deckHref(deck, "quiz")}">Quiz</a>` : ""}
          <span class="spacer"></span>
          <span class="scope">${scopeTopic ? `<b>${esc(scopeTopic.name)}</b> <button id="clearScope">All topics</button>` : `All topics`}</span>
        </div>
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="outline" aria-selected="${tab === "outline"}">Attack outline</button>
          <button class="tab" role="tab" data-tab="cards" aria-selected="${tab === "cards"}">Cards <span class="muted">${cards.length}</span></button>
        </div>
        <div id="panel"></div>`;

      const panel = app.querySelector("#panel");
      if (tab === "outline") renderOutline(panel, issues, ic, ip);
      else renderCardsList(panel, cards, cc, prog);

      app.querySelectorAll(".tab").forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
      const clear = app.querySelector("#clearScope");
      if (clear) clear.onclick = () => { prefs.topic = ""; setPrefs(deck.id, prefs); render(); };
    }

    function renderOutline(panel, issues, ic, ip) {
      const topics = prefs.topic ? data.topics.filter(t => t.id === prefs.topic) : data.topics;
      if (!issues.length) { panel.innerHTML = `<p class="muted">No issue map for this class yet.</p>`; return; }
      panel.innerHTML = `
        <div class="outline-tools">
          <span>${ic.solid} of ${issues.length} solid${ic.shaky ? `, ${ic.shaky} shaky` : ""}${ic.blank ? `, ${ic.blank} blank` : ""}</span>
          <label><input type="checkbox" id="selfTest" ${prefs.selfTest ? "checked" : ""}> Hide rules until tapped</label>
          <button class="link-btn" id="expandAll">Expand all</button>
          <button class="link-btn" id="printBtn">Print</button>
        </div>
        <div class="${prefs.selfTest ? "self-test" : ""}" id="outline">
          ${topics.map(t => {
            const tc = issueCounts(t.issues, ip);
            return `<section class="topic">
              <div class="topic-head">
                <h2>${esc(t.name)}</h2>
                ${t.part ? `<span class="part">${esc(t.part)}</span>` : ""}
                ${!prefs.topic && data.topics.length > 1 ? `<button class="focus" data-topic="${esc(t.id)}">Study only this topic</button>` : ""}
                ${issueMeter(tc, t.issues.length)}
              </div>
              ${t.issues.map(is => `
                <details class="issue" data-issue="${esc(is.id)}">
                  <summary>
                    <span class="status ${issueStatus(ip, is)}" title="${issueStatus(ip, is)}"></span>
                    <span class="issue-name">${legalize(is.name)}</span>
                    ${triggerLine(is)}
                  </summary>
                  <div class="issue-body">${issueBody(is, { shown: !prefs.selfTest })}</div>
                </details>`).join("")}
            </section>`;
          }).join("")}
        </div>`;
      panel.querySelector("#selfTest").onchange = e => { prefs.selfTest = e.target.checked; setPrefs(deck.id, prefs); render(); };
      panel.querySelector("#expandAll").onclick = () => {
        const all = [...panel.querySelectorAll("details.issue")];
        const open = all.some(d => !d.open);
        all.forEach(d => d.open = open);
      };
      panel.querySelector("#printBtn").onclick = () => { panel.querySelectorAll("details.issue").forEach(d => d.open = true); window.print(); };
      panel.querySelectorAll(".focus").forEach(b => b.onclick = () => { prefs.topic = b.dataset.topic; setPrefs(deck.id, prefs); render(); window.scrollTo(0, 0); });
      panel.querySelectorAll(".reveal-wrap").forEach(w => w.addEventListener("click", () => w.classList.add("shown")));
    }

    function renderCardsList(panel, cards, cc, prog) {
      const groups = { Part: new Map(), Type: new Map(), Topic: new Map() };
      const base = prefs.topic ? (data.topics.find(t => t.id === prefs.topic) || {}).cards || data.cards : data.cards;
      base.forEach(c => c.tags.forEach(t => { const g = groups[c.gmap[t] || groupFor(t)]; g.set(t, (g.get(t) || 0) + 1); }));
      panel.innerHTML = `
        <div class="list-head">
          <span class="select"><select id="filter" aria-label="Narrow the cards">
            <option value="">All cards (${base.length})</option>
            ${["Part", "Topic", "Type"].filter(g => groups[g].size).map(g => `<optgroup label="${g === "Type" ? "Card type" : g}">
              ${[...groups[g]].map(([t, n]) => `<option value="${esc(t)}" ${prefs.filter === t ? "selected" : ""}>${esc(prettyTag(t))} (${n})</option>`).join("")}
            </optgroup>`).join("")}
          </select></span>
          <label class="search">${ICON.search}<input id="q" type="search" placeholder="Search cards" autocomplete="off" aria-label="Search cards"></label>
        </div>
        <p class="muted" style="margin:4px 0 10px">${cc.known} of ${cards.length} known${cc.learning ? `, ${cc.learning} still learning` : ""}. ${cc.learning ? `<a href="${deckHref(deck, "missed")}">Review the missed ones.</a>` : ""}</p>
        <ol class="rows" id="rows"></ol>
        <button class="link-btn" id="reset">Reset progress for this class</button>`;
      const rowsEl = panel.querySelector("#rows");
      function drawRows() {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = cards.filter(c => terms.every(t => c.text.includes(t) || c.tags.some(x => x.toLowerCase().includes(t))));
        rowsEl.innerHTML = hits.length ? hits.map(card => {
          const st = statusOf(prog, card);
          return `<li class="row"><div class="row-front"><span class="dot ${st}" title="${st === "known" ? "Known" : st === "learning" ? "Still learning" : "Not studied yet"}"></span><span>${card.front}</span></div><div class="row-back rich">${card.back}</div></li>`;
        }).join("") : `<li class="row muted">No cards match “${esc(query)}”.</li>`;
      }
      drawRows();
      panel.querySelector("#filter").onchange = e => { prefs.filter = e.target.value; setPrefs(deck.id, prefs); render(); };
      const q = panel.querySelector("#q"); q.value = query;
      q.oninput = () => { query = q.value; drawRows(); };
      panel.querySelector("#reset").onclick = () => {
        if (confirm(`Reset progress for ${deck.name}? Every card and issue goes back to not studied.`)) { store.del(progressKey(deck.id)); store.del(issueKey(deck.id)); render(); }
      };
    }
    render();
  }

  function playerTop(deck, title, right) {
    return `<div class="player-top">
      <a class="icon-btn" href="${deckHref(deck)}" aria-label="Close and go back to ${esc(deck.name)}">${ICON.close}</a>
      <div class="player-title">${title}</div>
      ${right || '<span class="icon-spacer"></span>'}
    </div>`;
  }

  /* ---------- Rule drill ---------- */
  // Order: blank and shaky issues first, then new, then solid; light randomness so repeats vary.
  function drillOrder(issues, ip) {
    const rank = { blank: 0, shaky: 1, new: 2, solid: 3 };
    return issues.slice().sort((a, b) => (rank[issueStatus(ip, a)] + Math.random() * 1.2) - (rank[issueStatus(ip, b)] + Math.random() * 1.2));
  }
  async function viewDrill(deck, topicId) {
    session = spot = quiz = null;
    const data = await loadDeck(deck);
    const issues = scopedIssues(data, topicId);
    if (!issues.length) { location.replace(deckHref(deck)); return; }
    if (!drill || drill.deck.id !== deck.id || drill.topicId !== topicId) {
      drill = { deck, topicId, queue: drillOrder(issues, getIssueProg(deck.id)), idx: 0, shown: false, results: [], all: issues };
    }
    renderDrill();
  }
  function renderDrill() {
    const d = drill, deck = d.deck;
    if (d.idx >= d.queue.length) return renderDrillDone();
    const is = d.queue[d.idx];
    const scope = d.topicId ? is.topic.name : deck.name;
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>${d.idx + 1} of ${d.queue.length}</b><small>Rule drill · ${esc(scope)}</small>`)}
        <div class="track"><span style="width:${(d.idx / d.queue.length) * 100}%"></span></div>
        <div class="sheet">
          <p class="crumb">${esc(is.topic.name)}</p>
          <h2>${legalize(is.name)}</h2>
          ${triggerLine(is, true)}
          ${d.shown ? `<div class="answer">${issueBody(is, { shown: true })}</div>
            <div class="grade">
              <button class="btn g-blank" id="g0">Blank<small>Couldn't state it</small></button>
              <button class="btn g-shaky" id="g1">Shaky<small>Missed elements</small></button>
              <button class="btn g-solid" id="g2">Solid<small>Rule and elements</small></button>
            </div>`
          : `<p class="prompt">Say the rule out loud, with its elements and the main exception. Then check.</p>
             <button class="btn primary big wide reveal-btn" id="reveal">Show the rule</button>`}
        </div>
        <p class="keys"><kbd>Space</kbd> show rule <kbd>1</kbd> blank <kbd>2</kbd> shaky <kbd>3</kbd> solid</p>
      </div>`;
    const r = app.querySelector("#reveal");
    if (r) r.onclick = revealDrill;
    ["g0", "g1", "g2"].forEach((id, i) => { const b = app.querySelector("#" + id); if (b) b.onclick = () => gradeDrill(["blank", "shaky", "solid"][i]); });
  }
  function revealDrill() { if (!drill || drill.shown) return; drill.shown = true; renderDrill(); }
  function gradeDrill(s) {
    const d = drill; if (!d || !d.shown) return;
    const is = d.queue[d.idx];
    markIssue(d.deck.id, is, s);
    d.results.push({ is, s });
    d.idx++; d.shown = false;
    renderDrill(); window.scrollTo(0, 0);
  }
  function renderDrillDone() {
    const d = drill, deck = d.deck;
    const solid = d.results.filter(r => r.s === "solid").length;
    const weak = d.results.filter(r => r.s !== "solid");
    const line = !weak.length ? "Every rule came out clean." : weak.length <= 2 ? "Nearly there. Run the weak ones again." : "Good. The weak ones are listed below; drill them again before moving on.";
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Drill finished</b><small>${esc(deck.name)}</small>`)}
        <div class="track"><span style="width:100%"></span></div>
        <div class="result">
          <p class="result-num">${solid}<span>of ${d.results.length} solid</span></p>
          <p class="result-line">${line}</p>
          <div class="result-actions">
            ${weak.length ? `<button class="btn primary big" id="again">Drill the ${plural(weak.length, "weak issue")} again</button>` : ""}
            <button class="btn ${weak.length ? "" : "primary big"}" id="restart">Start the drill over</button>
            <a class="btn" href="${deckHref(deck, "spot")}${d.topicId ? "/" + encodeURIComponent(d.topicId) : ""}">Spot issues instead</a>
            <a class="link-btn" href="${deckHref(deck)}">Back to the outline</a>
          </div>
        </div>
        ${weak.length ? `<h2 class="list-title">Weak issues</h2><ul class="result-list">${weak.map(r => `<li><span class="status ${r.s}"></span><span>${legalize(r.is.name)} <span class="muted">· ${esc(r.is.topic.name)}</span></span></li>`).join("")}</ul>` : ""}
      </div>`;
    const again = app.querySelector("#again");
    if (again) again.onclick = () => { Object.assign(d, { queue: shuffle(weak.map(r => r.is)), idx: 0, shown: false, results: [] }); renderDrill(); };
    app.querySelector("#restart").onclick = () => { Object.assign(d, { queue: drillOrder(d.all, getIssueProg(deck.id)), idx: 0, shown: false, results: [] }); renderDrill(); };
  }

  /* ---------- Issue spotting ---------- */
  const LETTERS = ["A", "B", "C", "D"];
  function buildSpot(deck, data, topicId) {
    const ip = getIssueProg(deck.id);
    const pool = scopedIssues(data, topicId);
    const picked = drillOrder(pool, ip).slice(0, Math.min(10, pool.length));
    const qs = picked.map(is => {
      const same = data.issues.filter(x => x !== is && x.topic === is.topic);
      const other = data.issues.filter(x => x !== is && x.topic !== is.topic);
      const distractors = shuffle(same).slice(0, 3);
      if (distractors.length < 3) distractors.push(...shuffle(other).slice(0, 3 - distractors.length));
      const choices = shuffle([is, ...distractors]);
      return { is, choices, answer: choices.indexOf(is), picked: null };
    });
    return { deck, topicId, qs, i: 0, score: 0 };
  }
  async function viewSpot(deck, topicId) {
    session = drill = quiz = null;
    const data = await loadDeck(deck);
    if (data.issues.length < 4) { location.replace(deckHref(deck)); return; }
    if (!spot || spot.deck.id !== deck.id || spot.topicId !== topicId) spot = buildSpot(deck, data, topicId);
    renderSpot();
  }
  function renderSpot() {
    const z = spot, deck = z.deck;
    if (z.i >= z.qs.length) return renderSpotDone();
    const q = z.qs[z.i];
    const answered = q.picked !== null;
    const right = answered && q.picked === q.answer;
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>${z.i + 1} of ${z.qs.length}</b><small>Spot the issue · ${z.score} right so far</small>`)}
        <div class="track"><span style="width:${(z.i / z.qs.length) * 100}%"></span></div>
        <div class="sheet">
          <p class="crumb">The facts</p>
          <p class="issue-trigger" style="font-size:1.2rem"><mark>${esc(q.is.trigger)}</mark></p>
          <p class="prompt">Which issue do these facts raise?</p>
          <div class="options">
            ${q.choices.map((c, i) => {
              let cls = "";
              if (answered) cls = i === q.answer ? "is-right" : i === q.picked ? "is-wrong" : "is-dim";
              return `<button class="option ${cls}" data-i="${i}" ${answered ? "disabled" : ""}><span class="opt-key">${LETTERS[i]}</span><span>${legalize(c.name)}</span></button>`;
            }).join("")}
          </div>
          <p class="q-prompt ${answered ? (right ? "t-known" : "t-learning") : "muted"}" aria-live="polite">${answered ? (right ? "Right." : "Not that one. The right issue is marked.") : ""}</p>
          ${answered ? `<div class="answer">${issueBody(q.is, { shown: true, noTip: true })}</div>
            <button class="btn primary big wide" id="next" style="margin-top:16px">${z.i + 1 < z.qs.length ? "Next facts" : "See results"}</button>` : ""}
        </div>
        <p class="keys"><kbd>A</kbd>–<kbd>D</kbd> answer <kbd>Enter</kbd> next</p>
      </div>`;
    app.querySelectorAll(".option").forEach(b => b.onclick = () => answerSpot(+b.dataset.i));
    const next = app.querySelector("#next");
    if (next) { next.onclick = nextSpot; }
  }
  function answerSpot(i) {
    const z = spot, q = z.qs[z.i];
    if (!q || q.picked !== null) return;
    q.picked = i;
    const good = i === q.answer;
    if (good) z.score++;
    else { const ip = getIssueProg(z.deck.id); if (issueStatus(ip, q.is) !== "blank") markIssue(z.deck.id, q.is, "shaky"); }
    renderSpot();
  }
  function nextSpot() { if (!spot) return; spot.i++; renderSpot(); window.scrollTo(0, 0); }
  function renderSpotDone() {
    const z = spot, deck = z.deck;
    const missed = z.qs.filter(q => q.picked !== q.answer);
    const pct = z.score / z.qs.length;
    const line = pct === 1 ? "You saw every issue." : pct >= 0.7 ? "Solid. The ones you missed are below." : "The missed issues are below and marked shaky in the outline.";
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Results</b><small>${esc(deck.name)}</small>`)}
        <div class="track"><span style="width:100%"></span></div>
        <div class="result">
          <p class="result-num">${z.score}<span>of ${z.qs.length}</span></p>
          <p class="result-line">${line}</p>
          <div class="result-actions">
            <button class="btn primary big" id="again">Spot another set</button>
            <a class="btn" href="${deckHref(deck, "drill")}${z.topicId ? "/" + encodeURIComponent(z.topicId) : ""}">Drill the rules</a>
            <a class="link-btn" href="${deckHref(deck)}">Back to the outline</a>
          </div>
        </div>
        ${missed.length ? `<h2 class="list-title">Issues you missed</h2><ul class="result-list">${missed.map(q => `<li><span class="status shaky"></span><span>${legalize(q.is.name)} <span class="muted">· ${esc(q.is.topic.name)}</span></span></li>`).join("")}</ul>` : ""}
      </div>`;
    app.querySelector("#again").onclick = async () => { spot = buildSpot(deck, await loadDeck(deck), z.topicId); renderSpot(); window.scrollTo(0, 0); };
  }

  /* ---------- Flashcards ---------- */
  function newSession(deck, data, missedOnly) {
    const prefs = getPrefs(deck.id);
    const prog = getProgress(deck.id);
    let pool = scopedCards(data, prefs);
    if (missedOnly) pool = pool.filter(c => statusOf(prog, c) === "learning");
    const q = pool.slice();
    if (prefs.shuffle) shuffle(q);
    return { deck, all: data.cards, missedOnly, queue: q, total: q.length, idx: 0, flipped: false, know: 0, learning: 0, history: [], missed: [], enter: false };
  }
  async function viewCards(deck, missedOnly) {
    drill = spot = quiz = null;
    const data = await loadDeck(deck);
    if (!data.cards.length) return viewDeck(deck);
    if (!session || session.deck.id !== deck.id || session.missedOnly !== missedOnly) session = newSession(deck, data, missedOnly);
    if (!session.total) { location.replace(deckHref(deck)); return; }
    renderCards();
  }
  function renderCards() {
    const s = session, deck = s.deck;
    if (s.idx >= s.queue.length) return renderCardsDone();
    const card = s.queue[s.idx];
    const prefs = getPrefs(deck.id);
    const left = s.queue.length - s.idx;
    const depth = Math.min(2, left - 1);
    const sub = s.missedOnly ? "Missed cards" : prefs.topic && card.topic ? card.topic.name : prefs.filter ? prettyTag(prefs.filter) : deck.name;
    const chips = [card.issue ? card.issue.name : topicTagOf(card) ? prettyTag(topicTagOf(card)) : null, typeOf(card) ? prettyTag(typeOf(card)) : null].filter(Boolean);
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>${s.idx + 1} of ${s.total}</b><small>${esc(sub)}</small>`,
          `<button class="icon-btn ${prefs.shuffle ? "on" : ""}" id="shuf" aria-pressed="${prefs.shuffle}" title="${prefs.shuffle ? "Shuffle is on" : "Shuffle is off"}" aria-label="Shuffle">${ICON.shuffle}</button>`)}
        <div class="track"><span style="width:${(s.idx / s.total) * 100}%"></span></div>
        <div class="tally"><span class="t-learning">Still learning <b>${s.learning}</b></span><span class="t-known">Know it <b>${s.know}</b></span></div>
        <div class="stage" data-depth="${depth}">
          <span class="under u1" aria-hidden="true"></span>
          <span class="under u2" aria-hidden="true"></span>
          <div class="drag ${s.enter && !reduceMotion() ? "enter" : ""}" id="flip" role="button" tabindex="0" aria-label="Flashcard. Press to flip.">
            <div class="lift">
              <div class="spin ${s.flipped ? "is-flipped" : ""}">
                <div class="face blank">
                  ${chips.length ? `<div class="face-tags">${chips.map(t => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
                  <div class="face-q"><div class="q-text">${card.front}</div></div>
                  <div class="face-hint">Tap to flip</div>
                </div>
                <div class="face lined" aria-hidden="${!s.flipped}">
                  <div class="lined-head">${card.front}</div>
                  <div class="lined-body rich">${card.back}
                    ${card.issue ? `<details class="lined-rule"><summary>The rule this goes with: ${legalize(card.issue.name)}</summary><p class="rule">${legalize(card.issue.rule)}</p></details>` : ""}
                  </div>
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
    const ruleDetails = app.querySelector(".lined-rule");
    if (ruleDetails) ruleDetails.addEventListener("pointerdown", e => e.stopPropagation());
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
    app.querySelector("#restart").onclick = async () => {
      session = newSession(deck, await loadDeck(deck), s.missedOnly);
      if (!session.total) location.hash = deckHref(deck); else renderCards();
    };
  }
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

  /* ---------- Quiz (multiple choice over cards) ---------- */
  const preview = (html, n) => { const t = stripHtml(html.replace(/<br\s*\/?>/gi, " ").replace(/<\/(p|li)>/gi, " ")).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
  function buildQuiz(deck, data) {
    const prefs = getPrefs(deck.id);
    const prog = getProgress(deck.id);
    const pool = scopedCards(data, prefs);
    const cards = data.cards;
    const rank = c => ({ learning: 0, new: 1, known: 2 }[statusOf(prog, c)]) + Math.random() * 1.5;
    const picked = pool.slice().sort((a, b) => rank(a) - rank(b)).slice(0, Math.min(10, pool.length));
    shuffle(picked);
    const qs = picked.map(card => {
      const others = cards.filter(c => c.id !== card.id && preview(c.back, 400) !== preview(card.back, 400));
      const score = c => (typeOf(c) && typeOf(c) === typeOf(card) ? 2 : 0) + (c.topic && c.topic === card.topic ? 1 : 0) + Math.random();
      const choices = shuffle([card, ...others.sort((a, b) => score(b) - score(a)).slice(0, 3)]);
      return { card, choices, answer: choices.indexOf(card), picked: null };
    });
    return { deck, qs, i: 0, score: 0 };
  }
  async function viewQuiz(deck) {
    session = drill = spot = null;
    const data = await loadDeck(deck);
    const pool = scopedCards(data, getPrefs(deck.id));
    if (pool.length < 4 || data.cards.length < 4) { location.replace(deckHref(deck)); return; }
    if (!quiz || quiz.deck.id !== deck.id) quiz = buildQuiz(deck, data);
    renderQuiz();
  }
  function renderQuiz() {
    const z = quiz, deck = z.deck;
    if (z.i >= z.qs.length) return renderQuizDone();
    const q = z.qs[z.i];
    const answered = q.picked !== null;
    const right = answered && q.picked === q.answer;
    const chips = [q.card.issue ? q.card.issue.name : topicTagOf(q.card) ? prettyTag(topicTagOf(q.card)) : null].filter(Boolean);
    app.innerHTML = `
      <div class="player">
        ${playerTop(deck, `<b>Question ${z.i + 1} of ${z.qs.length}</b><small>${z.score} right so far</small>`)}
        <div class="track"><span style="width:${(z.i / z.qs.length) * 100}%"></span></div>
        <div class="q-card">
          ${chips.length ? `<div class="face-tags">${chips.map(t => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
          <div class="q-text">${q.card.front}</div>
        </div>
        <p class="q-prompt ${answered ? (right ? "t-known" : "t-learning") : "muted"}" aria-live="polite">${answered ? (right ? "Correct." : "Not this one. The right answer is marked.") : "Pick the answer that matches."}</p>
        <div class="options">
          ${q.choices.map((c, i) => {
            let cls = "";
            if (answered) cls = i === q.answer ? "is-right" : i === q.picked ? "is-wrong" : "is-dim";
            return `<button class="option ${cls}" data-i="${i}" ${answered ? "disabled" : ""}><span class="opt-key">${LETTERS[i]}</span><span>${esc(preview(c.back, 260))}</span></button>`;
          }).join("")}
        </div>
        ${answered ? `
          <details class="full"><summary>Show the full card</summary><div class="rich">${q.card.back}</div></details>
          <button class="btn primary big wide" id="next" style="margin-top:14px">${z.i + 1 < z.qs.length ? "Next question" : "See results"}</button>` : ""}
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
    const line = pct === 1 ? "A perfect quiz." : pct >= 0.7 ? "Solid. The ones you missed are below." : "The ones you missed are below and in Review missed.";
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
          <li class="row"><div class="row-front"><span class="dot learning"></span><span>${q.card.front}</span></div><div class="row-back rich">${q.card.back}</div></li>`).join("")}</ol>` : ""}
      </div>`;
    app.querySelector("#newquiz").onclick = async () => { quiz = buildQuiz(deck, await loadDeck(deck)); renderQuiz(); window.scrollTo(0, 0); };
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
    } else if (drill && /\/drill(\/|$)/.test(route) && drill.idx < drill.queue.length) {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!drill.shown) revealDrill(); }
      else if (drill.shown && /^[1-3]$/.test(e.key)) gradeDrill(["blank", "shaky", "solid"][+e.key - 1]);
    } else if (spot && /\/spot(\/|$)/.test(route) && spot.i < spot.qs.length) {
      const q = spot.qs[spot.i];
      const k = e.key.toUpperCase();
      const idx = LETTERS.indexOf(k) >= 0 ? LETTERS.indexOf(k) : /^[1-4]$/.test(e.key) ? +e.key - 1 : -1;
      if (q.picked === null && idx >= 0 && idx < q.choices.length) answerSpot(idx);
      else if (q.picked !== null && (e.key === "Enter" || e.key === " " || e.key === "ArrowRight")) { e.preventDefault(); nextSpot(); }
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
    const inPlayer = parts[0] === "deck" && ["cards", "missed", "quiz", "drill", "spot"].includes(parts[2]);
    document.body.classList.toggle("in-player", inPlayer);
    if (parts[0] === "deck") {
      const deck = deckList.find(d => d.id === parts[1]);
      if (!deck) return viewHome();
      if (parts[2] === "cards") return viewCards(deck, false);
      if (parts[2] === "missed") return viewCards(deck, true);
      if (parts[2] === "quiz") return viewQuiz(deck);
      if (parts[2] === "drill") return viewDrill(deck, parts[3] || "");
      if (parts[2] === "spot") return viewSpot(deck, parts[3] || "");
      return viewDeck(deck, parts[2]);
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
