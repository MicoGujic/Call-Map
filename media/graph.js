// @ts-check
// Graph mode webview. The extension sends graphs (a method or a whole class);
// this file draws them and turns keys into navigation.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const gwrap = /** @type {HTMLElement} */ (document.getElementById("gwrap"));
  const crumbs = /** @type {HTMLElement} */ (document.getElementById("crumbs"));
  const status = /** @type {HTMLElement} */ (document.getElementById("status"));
  const zoomBtn = /** @type {HTMLButtonElement} */ (document.getElementById("zoom"));
  const testsBtn = /** @type {HTMLButtonElement} */ (document.getElementById("tests"));

  /**
   * @type {{cur: string|null, graph: any, hist: {id:string,name:string}[],
   *   col: "callers"|"center"|"calls", idx: number, row: number, focusId: string|null,
   *   full: any, hideTests: boolean, hidden: number, source: string, armed: boolean}}
   */
  const S = { cur: null, graph: null, hist: [], col: "center", idx: 0, row: 0, focusId: null, full: null, hideTests: false, hidden: 0, source: "", armed: false };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // Template elements ("<lightning-button> onclick") and @wire properties aren't called with parentheses.
  const sig = (n) => (/^[<@]/.test(n.name) ? n.name : n.name + "(" + n.params.join(", ") + ")");
  const dot = (n) => (/^[<@]/.test(n.name) ? " " : ".");
  const qual = (n) => (n.container ? n.container + dot(n) : "") + n.name;
  const mapping = (args, params) =>
    args.length ? args.map((a, k) => a + " → " + (params[k] || "…")).join(" · ") : "no arguments";
  const isClass = () => S.graph && S.graph.kind === "class";

  // ---------- test filter ----------

  /** The graph as drawn: the full graph, minus test methods when they are hidden. */
  function filtered(g) {
    S.hidden = 0;
    if (!g || !S.hideTests) return g;
    const keep = (list) => {
      const out = list.filter((e) => !e.node.test);
      S.hidden += list.length - out.length;
      return out;
    };
    if (g.kind === "method") return { ...g, callers: keep(g.callers), center: { ...g.center, calls: keep(g.center.calls) } };
    const callers = keep(g.callers), calls = keep(g.calls);
    const methods = g.methods.map((m, r) => ({
      ...m,
      inCount: callers.filter((c) => c.targets.some((t) => t.method === r)).length,
      outCount: calls.filter((c) => c.froms.some((f) => f.method === r)).length,
    }));
    return { ...g, callers, calls, methods };
  }

  function applyFilter() {
    S.graph = filtered(S.full);
    const g = S.graph;
    if (g) {
      const n = S.col === "callers" ? g.callers.length : S.col === "calls" ? (g.kind === "class" ? g.calls : g.center.calls).length : 1;
      if (!n) S.col = "center";
      else if (S.idx >= n) S.idx = n - 1;
    }
    testsBtn.textContent = S.hideTests ? "Show tests (T)" : "Hide tests (T)";
    testsBtn.setAttribute("aria-pressed", String(S.hideTests));
    showStatus();
  }

  /** The note next to the buttons; while Enter is waiting for its second press, it says what that press does. */
  function showStatus() {
    const notes = [];
    if (S.source === "usages") notes.push("Built from usages");
    if (S.hidden) notes.push(S.hidden === 1 ? "1 test hidden" : S.hidden + " tests hidden");
    status.textContent = notes.join(" · ");
    if (S.armed) status.insertAdjacentHTML("afterbegin", `<span class="hint">Enter again opens it in the editor</span>${notes.length ? " · " : ""}`);
  }

  function toggleTests() {
    S.hideTests = !S.hideTests;
    vscode.postMessage({ type: "hideTests", value: S.hideTests });
    applyFilter();
    render();
  }

  // ---------- method view ----------

  function sideNode(kind, n, i, map, extra) {
    const sel = S.col === kind && S.idx === i;
    const doc = sel && n.doc ? `<span class="doc">${esc(n.doc)}</span>` : "";
    return `<button class="node ${kind === "callers" ? "caller" : "callee"}${sel ? " sel" : ""}" data-col="${kind}" data-i="${i}" tabindex="-1">
      ${n.container ? `<span class="cls">${esc(n.container)}</span>` : ""}<span class="nm">${n.container && dot(n) === "." ? "." : ""}${esc(sig(n))}${extra || ""}</span>
      <span class="map">${esc(map)}</span>${doc}<span class="loc">${esc(n.file)} : ${n.line}</span></button>`;
  }

  function coloredLine(text, runs, colorMap) {
    if (!runs || !colorMap) return esc(text);
    let out = "", at = 0;
    for (const [len, fg, fs] of runs) {
      const part = text.slice(at, at + len);
      at += len;
      if (!part) continue;
      let style = colorMap[fg] ? `color:${colorMap[fg]};` : "";
      if (fs & 1) style += "font-style:italic;";
      if (fs & 2) style += "font-weight:bold;";
      if (fs & 4) style += "text-decoration:underline;";
      out += style ? `<span style="${style}">${esc(part)}</span>` : esc(part);
    }
    return out + esc(text.slice(at));
  }

  function renderMethod() {
    const g = S.graph, c = g.center;
    const callers =
      g.callers.map((e, i) => sideNode("callers", e.node, i, "passes " + (e.args.join(", ") || "nothing"), e.count > 1 ? ` <span class="count">×${e.count}</span>` : "")).join("") ||
      `<div class="empty">Nothing in this workspace calls this method.</div>`;
    const calls =
      c.calls.map((e, i) => sideNode("calls", e.node, i, mapping(e.args, e.node.params), e.count > 1 ? ` <span class="count">×${e.count}</span>` : "")).join("") ||
      `<div class="empty">Calls nothing else in this workspace.</div>`;
    const byLine = new Map();
    c.calls.forEach((e, i) => {
      if (!byLine.has(e.line)) byLine.set(e.line, []);
      byLine.get(e.line).push(i);
    });
    const colors = c.colors;
    const body = c.code
      .map((ln, li) => {
        const html = coloredLine(ln, colors && colors.lines[li], colors && colors.colorMap);
        const idxs = byLine.get(li);
        if (!idxs) return html + "\n";
        const sel = S.col === "calls" && idxs.includes(S.idx);
        return `<span class="cl${sel ? " sel" : ""}" data-line="${li}">${html}</span>\n`;
      })
      .join("");
    gwrap.innerHTML = `<div class="cols">
      <div class="colm side${S.col === "callers" ? " focus" : ""}"><div class="ch">Called from (${g.callers.length})</div>${callers}</div>
      <div class="colm"><div class="ch">You are here</div>
        <div class="node cur${S.armed ? " armed" : ""}" id="center">
          <span class="cls">${esc([c.container, c.file + " : " + c.line].filter(Boolean).join(" · "))}</span>
          <span class="nm">${esc(sig(c))}</span>
          ${c.doc ? `<span class="doc">${esc(c.doc)}</span>` : ""}
          <pre class="code">${body}</pre>
        </div></div>
      <div class="colm side${S.col === "calls" ? " focus" : ""}"><div class="ch">Calls (${c.calls.length})</div>${calls}</div>
    </div><svg class="edges" id="edges" aria-hidden="true"></svg>`;
  }

  // ---------- class view ----------

  /** Edges as [sideIndex, row] pairs. */
  function classEdges() {
    const g = S.graph;
    const left = [], right = [];
    g.callers.forEach((c, i) => c.targets.forEach((t) => left.push({ i, row: t.method, args: t.args })));
    g.calls.forEach((c, i) => c.froms.forEach((f) => right.push({ i, row: f.method, args: f.args })));
    return { left, right };
  }

  function edgeActive(side, e) {
    if (S.col === "center") return e.row === S.row;
    return S.col === side && S.idx === e.i;
  }

  /** Who calls a class method and what it calls, inside and outside the class. */
  function relations(r) {
    const g = S.graph;
    const name = (n) => (n.container && n.container !== g.name ? n.container + "." : "") + n.name;
    const inside = g.methods.filter((m) => m.internalTo.includes(r)).map((m) => m.node.name + "()");
    const outside = g.callers.filter((c) => c.targets.some((t) => t.method === r)).map((c) => name(c.node));
    const usesIn = g.methods[r].internalTo.map((t) => g.methods[t].node.name + "()");
    const usesOut = g.calls.filter((c) => c.froms.some((f) => f.method === r)).map((c) => name(c.node));
    const list = (a, b) =>
      [...a.map((x) => `<span class="mine">${esc(x)}</span>`), ...b.map((x) => esc(x))].join(", ") || `<span class="none">nothing</span>`;
    return `<span class="rel in"><b>Called from</b> ${list(inside, outside)}</span>
      <span class="rel out"><b>Calls</b> ${list(usesIn, usesOut)}</span>`;
  }

  function renderClass() {
    const g = S.graph;
    const { left, right } = classEdges();
    const activeRows = new Set();
    if (S.col === "callers") left.filter((e) => e.i === S.idx).forEach((e) => activeRows.add(e.row));
    if (S.col === "calls") right.filter((e) => e.i === S.idx).forEach((e) => activeRows.add(e.row));
    const linked = (side, i) => S.col === "center" && (side === "callers" ? left : right).some((e) => e.i === i && e.row === S.row);
    const callers =
      g.callers
        .map((c, i) => {
          const to = [...new Set(c.targets.map((t) => g.methods[t.method].node.name))].join(", ");
          return sideNode("callers", c.node, i, "calls " + to, "").replace('class="node', `class="node${linked("callers", i) ? " linked" : ""}`);
        })
        .join("") || `<div class="empty">Nothing outside this class calls into it.</div>`;
    const calls =
      g.calls
        .map((c, i) => {
          const from = [...new Set(c.froms.map((f) => g.methods[f.method].node.name))].join(", ");
          return sideNode("calls", c.node, i, "from " + from, "").replace('class="node', `class="node${linked("calls", i) ? " linked" : ""}`);
        })
        .join("") || `<div class="empty">Calls nothing outside this class.</div>`;
    const rows = g.methods
      .map((m, r) => {
        const sel = S.col === "center" && S.row === r;
        const hot = activeRows.has(r);
        const inner = !sel && m.internal.length ? `<span class="internal">uses ${esc(m.internal.join(", "))}</span>` : "";
        const doc = sel && m.node.doc ? `<span class="doc">${esc(m.node.doc)}</span>` : "";
        const rel = sel ? relations(r) : "";
        return `<div class="mrow${sel ? " sel" : ""}${hot ? " hot" : ""}" data-row="${r}">
          <span class="mname">${esc(sig(m.node))}</span>
          <span class="counts">${m.inCount ? "← " + m.inCount : ""}${m.inCount && m.outCount ? " · " : ""}${m.outCount ? m.outCount + " →" : ""}</span>
          ${inner}${rel}${doc}</div>`;
      })
      .join("");
    gwrap.innerHTML = `<div class="cols">
      <div class="colm side${S.col === "callers" ? " focus" : ""}"><div class="ch">Used by (${g.callers.length})</div>${callers}</div>
      <div class="colm"><div class="ch">Class</div>
        <div class="node cur klass" id="center">
          <span class="cls">${esc(g.file)} : ${g.line}</span>
          <span class="nm">${esc(g.name)}</span>
          ${g.doc ? `<span class="doc">${esc(g.doc)}</span>` : ""}
          <div class="rows">${rows || `<div class="empty">No methods found.</div>`}</div>
        </div></div>
      <div class="colm side${S.col === "calls" ? " focus" : ""}"><div class="ch">Uses (${g.calls.length})</div>${calls}</div>
    </div><svg class="edges" id="edges" aria-hidden="true"></svg><svg class="edges inner" id="iedges" aria-hidden="true"></svg>`;
  }

  // ---------- shared ----------

  function render(dir) {
    renderCrumbs();
    if (!S.graph) return;
    if (isClass()) renderClass();
    else renderMethod();
    zoomBtn.textContent = isClass() ? "Zoom in to method (Z)" : "Zoom out to class (Z)";
    zoomBtn.disabled = isClass() && !S.graph.methods.length;
    if (dir) {
      gwrap.classList.remove("go-right", "go-left", "go-out", "go-in");
      void gwrap.offsetWidth;
      gwrap.classList.add({ r: "go-right", l: "go-left", out: "go-out", in: "go-in" }[dir] || "go-left");
    }
    fitColumns();
    drawEdges();
    reveal(!!dir);
  }

  const main = /** @type {HTMLElement} */ (document.getElementById("main"));
  const motion = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  /** Side columns stay in view next to long code: cap them to the visible height (they scroll on their own). */
  function fitColumns() {
    document.documentElement.style.setProperty("--view-h", Math.max(200, main.clientHeight - 40) + "px");
  }

  /**
   * Bring what the keys point at into view: the selected box in its column,
   * and in the code the line that makes the call (or, in the class view, the
   * method rows the selected box is linked to).
   */
  function reveal(fresh) {
    const behavior = fresh ? "auto" : motion();
    const box = gwrap.querySelector(".node.sel");
    if (box) box.scrollIntoView({ block: "nearest", inline: "nearest", behavior });
    const target =
      gwrap.querySelector(".cl.sel") || // the call line in the method's code
      gwrap.querySelector(".mrow.sel") ||
      gwrap.querySelector(".mrow.hot");
    if (target) target.scrollIntoView({ block: S.col === "center" ? "nearest" : "center", inline: "nearest", behavior });
    else if (fresh) main.scrollTo({ top: 0 });
  }

  function renderCrumbs() {
    const parts = S.hist
      .map((h, i) => `<button data-h="${i}">${esc(h.name)}</button><span class="sep">›</span>`)
      .join("");
    crumbs.innerHTML = parts + `<span class="now">${esc(S.graph ? title(S.graph) : "…")}</span>`;
  }
  const title = (g) => (g.kind === "class" ? g.name + " (class)" : qual(g.center));

  /** Box of an element in the edge layer's coordinates (works for sticky and scrolled columns). */
  function off(el) {
    const r = el.getBoundingClientRect(), g = gwrap.getBoundingClientRect();
    const k = gwrap.offsetWidth ? g.width / gwrap.offsetWidth : 1; // zoom animations scale gwrap
    return { x: (r.left - g.left) / k, y: (r.top - g.top) / k, w: r.width / k, h: r.height / k };
  }

  /** A box scrolled out of its column: no line to it unless it is selected. */
  function hidden(el) {
    const col = el.closest(".colm.side");
    if (!col || el.classList.contains("sel")) return false;
    const r = el.getBoundingClientRect(), c = col.getBoundingClientRect();
    return r.bottom < c.top || r.top > c.bottom;
  }
  const NS = "http://www.w3.org/2000/svg";
  function add(svg, tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.appendChild(e);
    return e;
  }
  function pill(svg, x, y, label, cls, anchor, maxW) {
    if (!label) return;
    const t = add(svg, "text", { x, y: y + 4, class: "pt " + cls, "text-anchor": anchor });
    t.textContent = label;
    // Shorten the label until it fits in the gap between the columns.
    while (label.length > 2 && t.getComputedTextLength() + 14 > maxW) {
      label = label.slice(0, -2);
      t.textContent = label + "…";
    }
    const w = t.getComputedTextLength() + 14;
    const r = document.createElementNS(NS, "rect");
    const attrs = { x: anchor === "end" ? x - w + 7 : x - 7, y: y - 9, width: w, height: 18, rx: 9, class: "pill " + cls };
    for (const k in attrs) r.setAttribute(k, attrs[k]);
    svg.insertBefore(r, t);
  }
  const curve = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  };

  function drawEdges() {
    const svg = document.getElementById("edges");
    const center = document.getElementById("center");
    if (!svg || !center || !S.graph) return;
    svg.innerHTML = "";
    const cb = off(center);
    const callerEls = gwrap.querySelectorAll(".node.caller");
    const calleeEls = gwrap.querySelectorAll(".node.callee");
    if (isClass()) {
      const { left, right } = classEdges();
      const rowEls = gwrap.querySelectorAll(".mrow");
      const rowY = (r) => {
        const el = rowEls[r];
        if (!el) return cb.y + 20;
        const b = off(el);
        return b.y + Math.min(b.h, 26) / 2;
      };
      const anySel = true;
      // Calls between methods of the class: arcs in the gutter right of the rows.
      const inner = document.getElementById("iedges");
      if (inner) {
        inner.innerHTML = "";
        const rowsEl = gwrap.querySelector(".klass .rows");
        const gx = rowsEl ? off(rowsEl).x + off(rowsEl).w : cb.x + cb.w - 30;
        let k = 0;
        S.graph.methods.forEach((m, a) => {
          for (const t of m.internalTo) {
            const ya = rowY(a), yb = rowY(t);
            const on = S.col === "center" && (a === S.row || t === S.row);
            const bulge = 10 + Math.min(Math.abs(yb - ya) / 12, 16) + (k++ % 3) * 2;
            add(inner, "path", { d: `M${gx},${ya} C${gx + bulge},${ya} ${gx + bulge},${yb} ${gx + 2},${yb}`, class: "edge self" + (on ? " sel" : " dim") });
            add(inner, "circle", { cx: gx + 2, cy: yb, r: on ? 2.6 : 2, class: "dot self" + (on ? "" : " dim") });
          }
        });
      }
      for (const e of left) {
        const el = callerEls[e.i];
        if (!el || hidden(el)) continue;
        const b = off(el), x1 = b.x + b.w, y1 = b.y + b.h / 2, x2 = cb.x - 2, y2 = rowY(e.row);
        const on = edgeActive("callers", e);
        add(svg, "path", { d: curve(x1, y1, x2, y2), class: "edge in" + (on ? " sel" : anySel ? " dim" : "") });
        if (on) pill(svg, x1 + 9, y1 - 13, e.args.join(", "), "in", "start", x2 - x1 - 16);
      }
      for (const e of right) {
        const el = calleeEls[e.i];
        if (!el || hidden(el)) continue;
        const b = off(el), x1 = cb.x + cb.w, y1 = rowY(e.row), x2 = b.x - 2, y2 = b.y + b.h / 2;
        const on = edgeActive("calls", e);
        add(svg, "path", { d: curve(x1, y1, x2, y2), class: "edge out" + (on ? " sel" : anySel ? " dim" : "") });
        add(svg, "circle", { cx: x2, cy: y2, r: 3, class: "dot" });
        if (on) pill(svg, x2 - 9, y2 - 13, e.args.join(", "), "out", "end", x2 - x1 - 16);
      }
      return;
    }
    const g = S.graph;
    callerEls.forEach((el, i) => {
      if (hidden(el)) return;
      const b = off(el), x1 = b.x + b.w, y1 = b.y + b.h / 2, x2 = cb.x - 2;
      const y2 = cb.y + 22 + Math.min(i, 8) * 8;
      const sel = S.col === "callers" && S.idx === i;
      add(svg, "path", { d: curve(x1, y1, x2, y2), class: "edge in" + (sel ? " sel" : "") });
      pill(svg, x1 + 9, y1 - 13, g.callers[i].args.join(", "), "in", "start", x2 - x1 - 16);
    });
    calleeEls.forEach((el, i) => {
      if (hidden(el)) return;
      const e = g.center.calls[i];
      const line = center.querySelector(`[data-line="${e.line}"]`);
      const b = off(el);
      const lb = line ? off(line) : { y: cb.y + 30, h: 0 };
      const x1 = cb.x + cb.w, y1 = lb.y + lb.h / 2, x2 = b.x - 2, y2 = b.y + b.h / 2;
      const sel = S.col === "calls" && S.idx === i;
      add(svg, "path", { d: curve(x1, y1, x2, y2), class: "edge out" + (sel ? " sel" : "") });
      add(svg, "circle", { cx: x2, cy: y2, r: 3, class: "dot" });
      pill(svg, x2 - 9, y2 - 13, e.args.join(", "), "out", "end", x2 - x1 - 16);
    });
  }

  // ---------- navigation ----------

  function show(id, dir, focusId) {
    S.cur = id;
    S.col = "center";
    S.idx = 0;
    S.row = 0;
    S.focusId = focusId || null;
    S.armed = false;
    vscode.postMessage({ type: "show", id, dir });
  }
  function travel(id, dir, focusId) {
    if (!S.graph) return;
    S.hist.push({ id: S.cur, name: S.graph.kind === "class" ? S.graph.name : S.graph.center.name });
    show(id, dir, focusId);
  }
  function back() {
    const h = S.hist.pop();
    if (h) show(h.id, "l");
  }

  /** Method view → its class; class view → the selected method. */
  function zoom() {
    const g = S.graph;
    if (!g) return;
    if (g.kind === "class") {
      const m = g.methods[S.row];
      if (m) travel(m.node.id, "in");
    } else {
      travel(g.center.classId, "out", g.center.id);
    }
  }

  /** In the class view, moving into a side column starts at a box linked to the selected row. */
  function firstLinked(side) {
    const { left, right } = classEdges();
    const e = (side === "callers" ? left : right).find((x) => x.row === S.row);
    return e ? e.i : 0;
  }

  function sideTarget(side, i) {
    const g = S.graph;
    const n = g.kind === "class" ? (side === "calls" ? g.calls[i].node : g.callers[i].node) : side === "calls" ? g.center.calls[i].node : g.callers[i].node;
    // In the class view, travel keeps the zoom level: go to that method's class.
    return g.kind === "class" ? { id: n.classId, focus: n.id } : { id: n.id, focus: null };
  }

  function closeToCode() {
    const g = S.graph;
    let id = S.cur;
    if (g && g.kind === "class" && S.col === "center" && g.methods[S.row]) id = g.methods[S.row].node.id;
    if (id) vscode.postMessage({ type: "close", id });
  }

  function key(k) {
    const g = S.graph;
    if (k === "Escape") { closeToCode(); return true; }
    if (!g) return false;
    // Enter on the middle box of a method opens it in the editor, like a double-click: the first press asks, the second goes.
    const armed = S.armed;
    S.armed = false;
    if (armed) showStatus();
    const callers = g.callers;
    const calls = g.kind === "class" ? g.calls : g.center.calls;
    const n = S.col === "calls" ? calls.length : S.col === "callers" ? callers.length : 0;
    switch (k) {
      case "ArrowRight":
        if (S.col === "callers") S.col = "center";
        else if (S.col === "center") { if (calls.length) { S.col = "calls"; S.idx = g.kind === "class" ? firstLinked("calls") : 0; } }
        else { const t = sideTarget("calls", S.idx); travel(t.id, "r", t.focus); return true; }
        break;
      case "ArrowLeft":
        if (S.col === "calls") S.col = "center";
        else if (S.col === "center") { if (callers.length) { S.col = "callers"; S.idx = g.kind === "class" ? firstLinked("callers") : 0; } }
        else { const t = sideTarget("callers", S.idx); travel(t.id, "l", t.focus); return true; }
        break;
      case "ArrowDown":
        if (S.col === "center" && g.kind === "class" && g.methods.length) S.row = (S.row + 1) % g.methods.length;
        else if (n) S.idx = (S.idx + 1) % n;
        break;
      case "ArrowUp":
        if (S.col === "center" && g.kind === "class" && g.methods.length) S.row = (S.row - 1 + g.methods.length) % g.methods.length;
        else if (n) S.idx = (S.idx - 1 + n) % n;
        break;
      case "Enter":
        if (S.col === "calls" || S.col === "callers") {
          const t = sideTarget(S.col, S.idx);
          travel(t.id, S.col === "calls" ? "r" : "l", t.focus);
          return true;
        }
        if (g.kind === "class") { zoom(); return true; }
        if (armed) { closeToCode(); return true; }
        S.armed = true;
        showStatus();
        break;
      case "z": case "Z": case "-": case "+":
        zoom();
        return true;
      case "Backspace": if (armed) render(); back(); return true;
      case "t": case "T": toggleTests(); return true;
      default:
        if (armed) render();
        return false;
    }
    render();
    return true;
  }

  window.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (key(e.key)) e.preventDefault();
  });
  zoomBtn.addEventListener("click", () => { zoom(); document.body.focus(); });
  testsBtn.addEventListener("click", () => { toggleTests(); document.body.focus(); });
  crumbs.addEventListener("click", (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest("[data-h]");
    if (!b) return;
    const i = +(/** @type {HTMLElement} */ (b).dataset.h || 0);
    const h = S.hist[i];
    S.hist = S.hist.slice(0, i);
    show(h.id, "l");
  });
  gwrap.addEventListener("click", (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (S.armed) { S.armed = false; showStatus(); render(); }
    const row = target.closest(".mrow");
    if (row && S.graph) {
      const r = +(/** @type {HTMLElement} */ (row).dataset.row || 0);
      if (S.col === "center" && S.row === r) zoom();
      else { S.col = "center"; S.row = r; render(); }
      return;
    }
    const b = target.closest(".node[data-col]");
    if (!b || !S.graph) return;
    const col = /** @type {"callers"|"calls"} */ (/** @type {HTMLElement} */ (b).dataset.col);
    const i = +(/** @type {HTMLElement} */ (b).dataset.i || 0);
    if (S.col === col && S.idx === i) {
      const t = sideTarget(col, i);
      travel(t.id, col === "calls" ? "r" : "l", t.focus);
    } else {
      S.col = col;
      S.idx = i;
      render();
    }
  });
  gwrap.addEventListener("dblclick", (e) => {
    if (/** @type {HTMLElement} */ (e.target).closest("#center") && !isClass()) closeToCode();
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "start") {
      S.hist = [];
      S.graph = null;
      S.cur = m.id;
      S.col = "center";
      S.idx = 0;
      S.row = 0;
      gwrap.innerHTML = `<div class="message">Reading calls…</div>`;
    } else if (m.type === "options") {
      S.hideTests = !!m.hideTests;
      applyFilter();
      if (S.graph) render();
    } else if (m.type === "refresh") {
      if (S.cur) vscode.postMessage({ type: "show", id: S.cur });
    } else if (m.type === "loading" && m.id === S.cur) {
      status.textContent = "Reading calls…";
    } else if (m.type === "graph" && m.id === S.cur) {
      const keep = S.graph && S.graph.kind === m.graph.kind && m.dir === undefined;
      S.full = m.graph;
      S.source = m.graph.source;
      if (m.graph.kind === "class" && S.focusId) {
        const r = m.graph.methods.findIndex((x) => x.node.id === S.focusId);
        if (r >= 0) S.row = r;
        S.focusId = null;
      }
      if (!keep) S.col = S.col || "center";
      applyFilter();
      render(m.dir);
    } else if (m.type === "error") {
      status.textContent = "";
      gwrap.innerHTML = `<div class="message">${esc(m.message)}</div>`;
    }
  });
  // Lines follow the boxes and code while anything scrolls.
  let frame = 0;
  const redraw = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawEdges();
    });
  };
  main.addEventListener("scroll", redraw, { passive: true });
  gwrap.addEventListener("scroll", redraw, { passive: true, capture: true }); // side columns and code
  gwrap.addEventListener("animationend", redraw);
  window.addEventListener("resize", () => {
    fitColumns();
    redraw();
  });
  document.body.focus();
  vscode.postMessage({ type: "ready" });
})();
