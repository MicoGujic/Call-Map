import * as vscode from "vscode";
import { ColoredLine, Highlighter } from "./highlight";
import { escapeRegExp, findDoc, isTestDecl, maskStringsAndComments, readArgs, readParams } from "./parse";
import { ApexBridge } from "./bridge";
import { WorkspaceIndex } from "./index";
import { HierarchySource, Incoming, Item, itemId, Outgoing, Source, UsagesSource } from "./sources";

/** What the webview draws. Plain JSON. */
export interface GraphNode {
  id: string;
  name: string;
  container: string;
  classId: string;
  file: string;
  line: number;
  params: string[];
  doc: string;
  /** A test method (@isTest, @Test, testMethod, or in a test file). */
  test: boolean;
}

export interface Graph {
  kind: "method";
  center: GraphNode & {
    code: string[];
    colors?: { colorMap: string[]; lines: ColoredLine[] };
    firstLine: number;
    calls: { node: GraphNode; args: string[]; line: number; count: number }[];
  };
  callers: { node: GraphNode; args: string[]; count: number }[];
  source: "hierarchy" | "usages";
}

export interface ClassGraph {
  kind: "class";
  id: string;
  name: string;
  file: string;
  line: number;
  doc: string;
  methods: { node: GraphNode; internal: string[]; internalTo: number[]; inCount: number; outCount: number }[];
  /** Methods outside the class that call into it. */
  callers: { node: GraphNode; targets: { method: number; args: string[] }[] }[];
  /** Methods outside the class that it calls. */
  calls: { node: GraphNode; froms: { method: number; args: string[] }[] }[];
  source: "hierarchy" | "usages";
}

export type AnyGraph = Graph | ClassGraph;

const MAX_PER_COLUMN = 30;
const MAX_CLASS_COLUMN = 40;
const MAX_CODE_LINES = 400;
const MAX_CLASS_METHODS = 60;

export class GraphBuilder {
  private hierarchy = new HierarchySource();
  private usages: UsagesSource;
  private bridge: ApexBridge;
  /** Which source and item belong to each id we have shown. */
  private known = new Map<string, { item: Item; source: Source }>();
  private classes = new Map<string, { uri: vscode.Uri; container: string; name: string }>();
  private cache = new Map<string, Promise<AnyGraph>>();

  constructor(index: WorkspaceIndex, private readonly forceUsages = false, private readonly highlighter?: Highlighter) {
    this.usages = new UsagesSource(index);
    this.bridge = new ApexBridge(this.usages);
  }

  /** Drop built graphs. File data stays: the index keeps itself current. */
  clear(): void {
    this.cache.clear();
  }

  item(id: string): Item | undefined {
    return this.known.get(id)?.item;
  }

  classLocation(id: string): { uri: vscode.Uri; container: string } | undefined {
    return this.classes.get(id);
  }

  private async skipHierarchy(uri: vscode.Uri): Promise<boolean> {
    if (this.forceUsages) return true;
    const doc = await vscode.workspace.openTextDocument(uri);
    const usagesFor = vscode.workspace.getConfiguration("callMap").get<string[]>("useUsagesFor", []);
    return usagesFor.includes(doc.languageId);
  }

  /** Turn an outline method into the item the best source understands. */
  private async resolve(outline: Item): Promise<{ item: Item; source: Source }> {
    if (!(await this.skipHierarchy(outline.uri))) {
      const h = await this.hierarchy.prepare(outline.uri, outline.selectionRange.start).catch(() => undefined);
      if (h) return { item: h, source: this.hierarchy };
    }
    return { item: outline, source: this.usages };
  }

  /** Find the method at a cursor position. */
  async prepare(uri: vscode.Uri, pos: vscode.Position): Promise<string | undefined> {
    // Resolve the method around the cursor first. Asking the call hierarchy at
    // the raw cursor would return the callee when the cursor is on a call,
    // and nothing when it is on whitespace.
    const enclosing = await this.usages.prepare(uri, pos);
    let entry: { item: Item; source: Source } | undefined;
    if (enclosing) entry = await this.resolve(enclosing);
    else if (!(await this.skipHierarchy(uri))) {
      const h = await this.hierarchy.prepare(uri, pos).catch(() => undefined);
      if (h) entry = { item: h, source: this.hierarchy };
    }
    if (!entry) return undefined;
    const id = itemId(entry.item);
    this.known.set(id, entry);
    return id;
  }

  /** The method a call at `pos` goes to, for hovers. */
  async prepareCallTarget(uri: vscode.Uri, pos: vscode.Position): Promise<string | undefined> {
    const to = await this.usages.callTargetAt(uri, pos);
    if (!to) return undefined;
    const entry = await this.resolve(to);
    const id = itemId(entry.item);
    this.known.set(id, entry);
    return id;
  }

  /** The class declared or named at `pos`, for hovers and the class view. */
  async prepareClassAt(uri: vscode.Uri, pos: vscode.Position): Promise<string | undefined> {
    const found = await this.usages.classAt(uri, pos);
    return found ? this.registerClass(found.uri, found.name) : undefined;
  }

  /**
   * The class to show for a file: the one around `pos` when given, otherwise
   * the file's first (top-level) class. Files without classes (TS/JS modules)
   * get their top-level functions.
   */
  async prepareFileClass(uri: vscode.Uri, pos?: vscode.Position): Promise<string> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const masked = maskStringsAndComments(doc.getText());
    const at = pos ? doc.offsetAt(pos) : -1;
    const re = /\b(?:class|interface|enum|trigger)\s+([A-Za-z_$][\w$]*)/gi;
    let first: string | undefined;
    let around: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked))) {
      first ??= m[1];
      if (at < 0 || m.index > at) continue;
      const open = masked.indexOf("{", m.index);
      if (open < 0) continue;
      if (at <= closingBrace(masked, open)) around = m[1]; // later matches are nested deeper
    }
    return this.registerClass(uri, around ?? first ?? "");
  }

  private registerClass(uri: vscode.Uri, container: string): string {
    const id = `class:${uri.toString()}#${container}`;
    if (!this.classes.has(id)) {
      const base = /([^/]+?)(\.[^./]+)?$/.exec(uri.path)?.[1] ?? "";
      this.classes.set(id, { uri, container, name: container || base });
    }
    return id;
  }

  private async classIdOf(item: Item): Promise<string> {
    const outline = await this.usages.enclosing(item.uri, item.selectionRange.start);
    return this.registerClass(item.uri, outline?.detail ?? "");
  }

  build(id: string): Promise<AnyGraph> {
    let p = this.cache.get(id);
    if (!p) {
      p = id.startsWith("class:") ? this.buildClass(id) : this.buildMethod(id);
      this.cache.set(id, p);
      p.catch(() => this.cache.delete(id));
    }
    return p;
  }

  private async relations(entry: { item: Item; source: Source }): Promise<{ incoming: Incoming[]; outgoing: Outgoing[] }> {
    const [incomingOwn, outgoingOwn, incomingJs, outgoingApex] = await Promise.all([
      entry.source.incoming(entry.item).catch(() => []),
      entry.source.outgoing(entry.item).catch(() => []),
      this.bridge.incoming(entry.item).catch(() => []),
      this.bridge.outgoing(entry.item).catch(() => []),
    ]);
    // Frontend ↔ Apex links: let each end use the best source for its language.
    const adopt = async (item: Item): Promise<Item> => {
      const resolved = await this.resolve(item);
      const id = itemId(resolved.item);
      if (!this.known.has(id)) this.known.set(id, resolved);
      return resolved.item;
    };
    const incomingRaw = [...incomingOwn];
    for (const inc of incomingJs) incomingRaw.push({ ...inc, from: await adopt(inc.from) });
    const outgoingRaw = [...outgoingOwn];
    for (const out of outgoingApex) outgoingRaw.push({ ...out, to: await adopt(out.to) });
    return {
      incoming: incomingRaw.map((c) => ({ ...c, sites: distinctSites(c.sites) })),
      outgoing: outgoingRaw
        .map((c) => ({ ...c, sites: distinctSites(c.sites) }))
        .filter((o) => o.sites.length)
        .sort((a, b) => a.sites[0].start.compareTo(b.sites[0].start)),
    };
  }

  private async buildMethod(id: string): Promise<Graph> {
    const entry = this.known.get(id);
    if (!entry) throw new Error("That method is no longer available. Zoom out again from the editor.");
    const { item, source } = entry;
    const { incoming, outgoing } = await this.relations(entry);

    const doc = await vscode.workspace.openTextDocument(item.uri);
    const center = await this.node(item, source);
    const lines = docLines(doc);
    const { bodyStart } = findDoc(lines, item.range.start.line, item.selectionRange.start.line);
    const endLine = Math.min(item.range.end.line, bodyStart + MAX_CODE_LINES - 1);
    const code = lines.slice(bodyStart, endLine + 1);
    const indent = Math.min(...code.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length));
    const cut = indent > 0 && Number.isFinite(indent) ? indent : 0;
    if (cut) code.forEach((l, i) => (code[i] = l.slice(cut)));

    let colors: Graph["center"]["colors"];
    const all = await this.highlighter?.colorsFor(doc);
    if (all) {
      colors = {
        colorMap: all.colorMap,
        lines: code.map((_, i) => sliceRuns(all.lines[bodyStart + i] ?? [], cut)),
      };
    }
    if (endLine < item.range.end.line) {
      code.push("…");
      colors?.lines.push([]);
    }

    const text = doc.getText();
    const calls = [];
    for (const out of outgoing.slice(0, MAX_PER_COLUMN)) {
      const site = out.sites[0];
      calls.push({
        node: await this.node(out.to, source),
        args: out.args ?? readArgs(text, doc.offsetAt(site.end)) ?? [],
        line: Math.max(0, Math.min(code.length - 1, site.start.line - bodyStart)),
        count: out.sites.length,
      });
    }

    const callers = [];
    for (const inc of incoming.slice(0, MAX_PER_COLUMN)) {
      callers.push({ node: await this.node(inc.from, source), args: inc.args ?? (await argsAt(inc)), count: inc.sites.length });
    }

    return { kind: "method", center: { ...center, code, colors, firstLine: bodyStart + 1, calls }, callers, source: source.kind };
  }

  private async buildClass(id: string): Promise<ClassGraph> {
    const cls = this.classes.get(id);
    if (!cls) throw new Error("That class is no longer available. Zoom out again from the editor.");
    const doc = await vscode.workspace.openTextDocument(cls.uri);
    const outline = (await this.usages.methodsIn(cls.uri))
      .filter((m) => (m.detail ?? "") === cls.container)
      .slice(0, MAX_CLASS_METHODS);
    const entries = await mapLimit(outline, 6, (m) => this.resolve(m));
    entries.forEach((e) => this.known.set(itemId(e.item), e));
    const rels = await mapLimit(entries, 6, (e) => this.relations(e));
    const memberIds = new Set(entries.map((e) => itemId(e.item)));
    const indexOf = new Map(entries.map((e, i) => [itemId(e.item), i]));

    const methods: ClassGraph["methods"] = [];
    const callers = new Map<string, ClassGraph["callers"][number]>();
    const calls = new Map<string, ClassGraph["calls"][number]>();
    for (let i = 0; i < entries.length; i++) {
      const { item, source } = entries[i];
      const { incoming, outgoing } = rels[i];
      const internal: string[] = [];
      const internalTo: number[] = [];
      for (const out of outgoing) {
        const toId = itemId(out.to);
        if (memberIds.has(toId)) {
          if (toId !== itemId(item)) {
            internal.push(out.to.name.replace(/\(.*$/, ""));
            internalTo.push(indexOf.get(toId)!);
          }
          continue;
        }
        let c = calls.get(toId);
        if (!c) {
          if (calls.size >= MAX_CLASS_COLUMN) continue;
          c = { node: await this.node(out.to, source), froms: [] };
          calls.set(toId, c);
        }
        c.froms.push({ method: i, args: out.args ?? readArgs(doc.getText(), doc.offsetAt(out.sites[0].end)) ?? [] });
      }
      let external = 0;
      for (const inc of incoming) {
        const fromId = itemId(inc.from);
        if (memberIds.has(fromId) || indexOf.has(fromId)) continue;
        external++;
        let c = callers.get(fromId);
        if (!c) {
          if (callers.size >= MAX_CLASS_COLUMN) continue;
          c = { node: await this.node(inc.from, source), targets: [] };
          callers.set(fromId, c);
        }
        c.targets.push({ method: i, args: inc.args ?? (await argsAt(inc)) });
      }
      methods.push({
        node: await this.node(item, source),
        internal: [...new Set(internal)],
        internalTo: [...new Set(internalTo)],
        inCount: external,
        outCount: outgoing.filter((o) => !memberIds.has(itemId(o.to))).length,
      });
    }

    const decl = classDeclLine(doc.getText(), cls.container);
    const lines = docLines(doc);
    const docText = decl >= 0 ? findDoc(lines, decl, decl).text : "";
    // Callers in the order of the first method they call, so lines cross less.
    const sortedCallers = [...callers.values()].sort((a, b) => a.targets[0].method - b.targets[0].method);
    const sortedCalls = [...calls.values()].sort((a, b) => a.froms[0].method - b.froms[0].method);
    return {
      kind: "class",
      id,
      name: cls.name,
      file: vscode.workspace.asRelativePath(cls.uri, false),
      line: decl + 1,
      doc: docText,
      methods,
      callers: sortedCallers,
      calls: sortedCalls,
      source: entries.some((e) => e.source.kind === "hierarchy") ? "hierarchy" : "usages",
    };
  }

  private async node(item: Item, source: Source): Promise<GraphNode> {
    const id = itemId(item);
    if (!this.known.has(id)) this.known.set(id, { item, source });
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const lines = docLines(doc);
    const { text } = findDoc(lines, item.range.start.line, item.selectionRange.start.line);
    const classId = await this.classIdOf(item);
    return {
      id,
      name: item.name.replace(/\(.*$/, ""),
      container:
        containerOf(item) ||
        this.classes.get(classId)?.container ||
        (/\/aura\//i.test(item.uri.path) ? (/([^/]+)\.js$/i.exec(item.uri.path)?.[1] ?? "") : "") ||
        (/\/lwc\/.*\.html$/i.test(item.uri.path) ? (/([^/]+\.html)$/i.exec(item.uri.path)?.[1] ?? "") : ""),
      classId,
      file: vscode.workspace.asRelativePath(item.uri, false),
      line: item.selectionRange.start.line + 1,
      params: readParams(doc.getText(), doc.offsetAt(item.selectionRange.end)),
      doc: text,
      test: isTest(doc, item, this.classes.get(classId)?.container ?? ""),
    };
  }
}

async function argsAt(inc: Incoming): Promise<string[]> {
  const site = inc.sites[0];
  if (!site) return [];
  const fromDoc = await vscode.workspace.openTextDocument(inc.from.uri);
  return readArgs(fromDoc.getText(), fromDoc.offsetAt(site.end)) ?? [];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

/** Drop the first `cut` characters from a line's color runs. */
function sliceRuns(runs: ColoredLine, cut: number): ColoredLine {
  const out: ColoredLine = [];
  let skip = cut;
  for (const [len, fg, fs] of runs) {
    if (skip >= len) {
      skip -= len;
      continue;
    }
    out.push([len - skip, fg, fs]);
    skip = 0;
  }
  return out;
}

function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
}

export function classDeclLine(text: string, name: string): number {
  if (!name) return 0;
  const masked = maskStringsAndComments(text);
  const re = new RegExp(`\\b(class|interface|enum|trigger)\\s+${escapeRegExp(name)}\\b`, "i");
  const m = re.exec(masked);
  if (!m) return -1;
  // Start of the declaration line, including modifiers before the keyword.
  return masked.slice(0, m.index).split("\n").length - 1;
}

/** Some servers report one call as nested ranges (`this.save` and `save`). */
function distinctSites(sites: vscode.Range[]): vscode.Range[] {
  const out: vscode.Range[] = [];
  for (const r of [...sites].sort((a, b) => a.start.compareTo(b.start))) {
    if (!out.some((o) => o.intersection(r))) out.push(r);
  }
  return out;
}

const linesCache = new WeakMap<vscode.TextDocument, { version: number; lines: string[] }>();
function docLines(doc: vscode.TextDocument): string[] {
  const c = linesCache.get(doc);
  if (c && c.version === doc.version) return c.lines;
  const lines = doc.getText().split(/\r?\n/);
  linesCache.set(doc, { version: doc.version, lines });
  return lines;
}

const maskedCache = new WeakMap<vscode.TextDocument, { version: number; lines: string[]; text: string }>();
function maskedOf(doc: vscode.TextDocument): { lines: string[]; text: string } {
  const c = maskedCache.get(doc);
  if (c && c.version === doc.version) return c;
  const text = maskStringsAndComments(doc.getText());
  const entry = { version: doc.version, lines: text.split(/\r?\n/), text };
  maskedCache.set(doc, entry);
  return entry;
}

function isTest(doc: vscode.TextDocument, item: Item, container: string): boolean {
  if (/(\.(test|spec)\.[cm]?[jt]sx?$)|\/__tests__\/|\/src\/test\//i.test(doc.uri.path)) return true;
  const masked = maskedOf(doc);
  if (isTestDecl(masked.lines, item.selectionRange.start.line)) return true;
  const decl = container ? classDeclLine(masked.text, container) : -1;
  return decl >= 0 && isTestDecl(masked.lines, decl);
}

function containerOf(item: Item): string {
  // TS puts "ClassName" or a file path in detail; Java puts "pkg.Class".
  const d = (item.detail ?? "").trim();
  if (!d || d.includes("/") || d.includes("\\")) return "";
  return d.split(/[.\s]/).filter(Boolean).pop() ?? "";
}
