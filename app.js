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

  // Italicize case names ("A v. B", "In re X", "Matter of X") and § references in plain text.
  function legalize(text) {
    let s = esc(text);
    s = s.replace(/((?:[A-Z][\w.'&\-]*\s){0,5}[A-Z][\w.'&\-]*(?:,? (?:Inc|Co|Corp|LLC|Ass'n|Dep't|Bros)\.?)?\s+v\.\s+(?:[A-Z][\w.'&\-]*(?:\s(?:of|the|&|and|for|de)\s)?\s?){1,5})/g, '<i>$1</i>');
    s = s.replace(/\b(In re [A-Z][\w.'&\-]*(?: [A-Z][\w.'&\-]*){0,3}|Matter of [A-Z][\w.'&\-]*(?: [A-Z][\w.'&\-]*){0,2})/g, '<i>$1</i>');
    s = s.replace(/<\/i>(\s*)<i>/g, "$1");
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
    const words = s => stripHtml(s).toLowerCase().replace(/[^a-z0-9§ ]+/g, " ").split(/\s+/).filter(w => w.length > 3);
    issues.forEach(is => {
      const keys = new Set();
      [is.name, ...(is.authorities || [])].forEach(a => words(a).forEach(w => keys.add(w)));
      is.keys = keys;
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
        let s = 0; is.keys.forEach(k => { if (cw.has(k)) s++; });
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
  const triggerLine = is => `<p class="issue-trigger"><span class="lbl">Watch for</span><mark>${esc(is.trigger)}</mark></p>`;

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
