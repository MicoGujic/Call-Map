import * as vscode from "vscode";
import { Entry, FileKind, kindOf, positionIn, WorkspaceIndex } from "./index";
import { declaredTypeOf, findCallCandidates, findMethodDecls, templateHandlers } from "./parse";

function baseName(uri: vscode.Uri): string {
  return (/([^/]+?)(\.[^./]+)?$/.exec(uri.path)?.[1] ?? "").toLowerCase();
}

/** A method, whichever source found it. Same shape as vscode.CallHierarchyItem. */
export interface Item {
  name: string;
  detail?: string;
  uri: vscode.Uri;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

export interface Incoming {
  from: Item;
  /** Call sites, in from.uri. */
  sites: vscode.Range[];
  /** Arguments, when the call site alone can't give them (JavaScript into Apex). */
  args?: string[];
}

export interface Outgoing {
  to: Item;
  /** Call sites, in the calling item's document. */
  sites: vscode.Range[];
  args?: string[];
}

export interface Source {
  readonly kind: "hierarchy" | "usages";
  prepare(uri: vscode.Uri, pos: vscode.Position): Promise<Item | undefined>;
  incoming(item: Item): Promise<Incoming[]>;
  outgoing(item: Item): Promise<Outgoing[]>;
}

export function itemId(item: Item): string {
  const s = item.selectionRange.start;
  return `${item.uri.toString()}#${s.line}:${s.character}`;
}

/** VS Code's call hierarchy: TypeScript, JavaScript, Java and most other languages. */
export class HierarchySource implements Source {
  readonly kind = "hierarchy" as const;
  private native = new Map<string, vscode.CallHierarchyItem>();

  private keep(item: vscode.CallHierarchyItem): Item {
    this.native.set(itemId(item), item);
    return item;
  }

  async prepare(uri: vscode.Uri, pos: vscode.Position): Promise<Item | undefined> {
    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
      "vscode.prepareCallHierarchy",
      uri,
      pos
    );
    return items && items.length ? this.keep(items[0]) : undefined;
  }

  private nativeOf(item: Item): vscode.CallHierarchyItem {
    return this.native.get(itemId(item)) ?? (item as vscode.CallHierarchyItem);
  }

  async incoming(item: Item): Promise<Incoming[]> {
    const calls =
      (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        "vscode.provideIncomingCalls",
        this.nativeOf(item)
      )) ?? [];
    return calls.map((c) => ({ from: this.keep(c.from), sites: c.fromRanges }));
  }

  async outgoing(item: Item): Promise<Outgoing[]> {
    const calls =
      (await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls",
        this.nativeOf(item)
      )) ?? [];
    return calls.map((c) => ({ to: this.keep(c.to), sites: c.fromRanges }));
  }
}

const METHOD_KINDS = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

/**
 * For languages without call hierarchy (Apex today): callers from
 * "find all references", calls from reading the method body and asking
 * "go to definition" for each one. Methods come from document symbols, or
 * from a rough parse of the file when the language server has none.
 */
export class UsagesSource implements Source {
  readonly kind = "usages" as const;
  private outlines = new Map<string, { version: number; items: Item[] }>();
  private lineages = new Map<string, Promise<string[]>>();

  constructor(readonly index: WorkspaceIndex) {
    // Class hierarchies can change with any file; outlines are kept per document version.
    index.onDidChange(() => this.lineages.clear());
  }

  /** File text with strings and comments blanked. */
  textOf(file: vscode.Uri): Promise<{ raw: string; masked: string }> {
    return this.index.text(file);
  }

  /** The method a call at `pos` goes to (cursor on the called name). */
  async callTargetAt(uri: vscode.Uri, pos: vscode.Position): Promise<Item | undefined> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const word = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
    if (!word) return undefined;
    const after = doc.getText(new vscode.Range(word.end, word.end.translate(0, 200))).replace(/^\s*(<[^<>;(){}]*>)?\s*/, "");
    if (!after.startsWith("(")) return undefined;
    const name = doc.getText(word);
    const target = await this.definitionOf(uri, word.start);
    if (target) {
      const to = await this.enclosing(target.uri, target.range.start);
      if (to && (to.selectionRange.contains(target.range.start) || to.selectionRange.start.line === target.range.start.line)) return to;
    }
    return this.byName(uri, doc, name, doc.offsetAt(word.start));
  }

  /** The class declared at `pos`, or the class a name at `pos` refers to. */
  async classAt(uri: vscode.Uri, pos: vscode.Position): Promise<{ uri: vscode.Uri; name: string } | undefined> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const word = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
    if (!word) return undefined;
    const name = doc.getText(word);
    const before = doc.getText(new vscode.Range(word.start.with(undefined, 0), word.start));
    if (/\b(class|interface|enum|trigger)\s+$/i.test(before)) return { uri, name };
    const after = doc.getText(new vscode.Range(word.end, word.end.translate(0, 50)));
    if (/^\s*\(/.test(after) && !/\bnew\s+$/.test(before)) return undefined; // a call, not a class
    const declName = async (u: vscode.Uri) => {
      const { masked } = await this.textOf(u);
      const m = new RegExp(`\\b(?:class|interface|enum|trigger)\\s+(${name.replace(/[$]/g, "\\$")})\\b`, "i").exec(masked);
      return m?.[1];
    };
    const target = await this.definitionOf(uri, word.start);
    if (target) {
      const n = await declName(target.uri);
      if (n) return { uri: target.uri, name: n };
    }
    const kind = nameMatchKind(uri);
    const file = kind && (await this.index.fileFor(name, kind));
    if (file) {
      const n = await declName(file);
      if (n) return { uri: file, name: n };
    }
    return undefined;
  }

  /**
   * A class and everything it extends or implements, nearest first, lowercased.
   * A call through a variable of any of these types can reach the class's method.
   */
  private lineage(name: string, hint: vscode.Uri): Promise<string[]> {
    const key = name.toLowerCase();
    let p = this.lineages.get(key);
    if (!p) {
      p = (async () => {
        const out: string[] = [];
        const queue = [name];
        while (queue.length && out.length < 12) {
          const n = queue.shift()!;
          if (out.includes(n.toLowerCase())) continue;
          out.push(n.toLowerCase());
          queue.push(...(await this.index.supertypes(n, hint)));
        }
        return out;
      })();
      this.lineages.set(key, p);
    }
    return p;
  }

  /** The method a call resolves to, matched by class and method name. */
  private async byName(uri: vscode.Uri, doc: vscode.TextDocument, name: string, offset: number): Promise<Item | undefined> {
    const kind = nameMatchKind(uri);
    if (!kind) return undefined;
    const before = doc.getText(new vscode.Range(doc.positionAt(Math.max(0, offset - 120)), doc.positionAt(offset)));
    const qualifier = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before)?.[1]?.toLowerCase();
    const lname = name.toLowerCase();
    const pick = (methods: Item[], container?: string) =>
      methods.find(
        (m) => m.name.toLowerCase() === lname && (container === undefined || (m.detail ?? "").toLowerCase() === container)
      );
    if (!qualifier || qualifier === "this" || qualifier === "super") {
      return pick(await this.methodsIn(uri));
    }
    // Inner class in the same file, then a class file with that name.
    const own = pick(await this.methodsIn(uri), qualifier);
    if (own) return own;
    const file = await this.index.fileFor(qualifier, kind);
    if (file) return pick(await this.outlineOf(file));
    // A variable: go to its declared type, or the nearest supertype that has the method.
    const original = /([A-Za-z_]\w*)\s*\.\s*$/.exec(before)![1];
    const type = declaredTypeOf((await this.textOf(uri)).masked, offset, original);
    if (!type) return undefined;
    for (const t of await this.lineage(type, (await this.index.fileFor(type, kind)) ?? uri)) {
      const own2 = pick(await this.methodsIn(uri), t);
      if (own2) return own2;
      const f = await this.index.fileFor(t, kind);
      const hit = f && pick(await this.outlineOf(f));
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * Calls to `item` found by name, from the workspace index. Files are only
   * read when a call goes through a variable whose type has to be looked up.
   */
  private async callersByName(item: Item): Promise<Incoming[]> {
    const kind = nameMatchKind(item.uri);
    if (!kind) return [];
    const owner = ((item.detail || baseName(item.uri)) ?? "").toLowerCase();
    const groups = new Map<string, Incoming>();
    const types = new Set(await this.lineage(item.detail || baseName(item.uri), item.uri));
    for (const { entry, sites } of await this.index.callsTo(item.name, [kind])) {
      const file = entry.uri;
      const sameFile = file.toString() === item.uri.toString();
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
      let masked: string | undefined;
      for (const site of sites) {
        const q = site.q;
        let ok = q ? q === owner || (sameFile && q === "this") : sameFile;
        // A variable whose declared type is this class or one it extends or implements.
        if (!ok && q && q !== "this" && q !== "super") {
          masked ??= (await this.textOf(file)).masked;
          ok = types.has(declaredTypeOf(masked, site.o, q)?.toLowerCase() ?? "");
        }
        if (!ok) continue;
        const pos = open ? open.positionAt(site.o) : positionIn(entry, site.o);
        // An open file may have a language server's outline; otherwise use the index's.
        const from = open ? await this.enclosing(file, pos) : declAround(entry, site.o);
        if (!from || from.selectionRange.start.isEqual(pos)) continue; // a declaration, not a call
        if (itemId(from) === itemId(item) && item.selectionRange.contains(pos)) continue;
        const id = itemId(from);
        const g = groups.get(id) ?? { from, sites: [] };
        g.sites.push(new vscode.Range(pos, pos.translate(0, item.name.length)));
        groups.set(id, g);
      }
    }
    return [...groups.values()];
  }

  /** Methods of a file: the index's outline unless the file is open in an editor. */
  private async outlineOf(uri: vscode.Uri): Promise<Item[]> {
    const open = vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
    const entry = open ? undefined : await this.index.entry(uri);
    if (!entry?.decls.length) return this.methodsIn(uri);
    return entry.decls.map((d) => declItem(entry, d));
  }

  async methodsIn(uri: vscode.Uri): Promise<Item[]> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const key = uri.toString();
    const cached = this.outlines.get(key);
    if (cached && cached.version === doc.version) return cached.items;
    if (kindOf(uri) === "html") {
      const items = this.fromTemplate(doc);
      this.outlines.set(key, { version: doc.version, items });
      return items;
    }
    let items = await this.fromSymbols(doc);
    // TypeScript's server answers empty while it starts on a file that isn't open yet.
    for (let tries = 0; !items.length && /\.[cm]?[jt]sx?$/i.test(uri.path) && tries < 4; tries++) {
      await new Promise((r) => setTimeout(r, 750));
      items = await this.fromSymbols(doc);
    }
    if (!items.length) items = this.fromText(doc);
    if (items.length) this.outlines.set(key, { version: doc.version, items });
    return items;
  }

  private async fromSymbols(doc: vscode.TextDocument): Promise<Item[]> {
    let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
    } catch {
      symbols = undefined;
    }
    if (!symbols) return [];
    const out: Item[] = [];
    const walk = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], container: string) => {
      for (const s of list) {
        if ("children" in s) {
          // Anonymous functions ("then() callback", "<function>") belong to the method around them.
          if (METHOD_KINDS.has(s.kind) && !/ callback$|^</.test(s.name)) {
            out.push({
              name: s.name.replace(/\(.*$/, ""),
              detail: container,
              uri: doc.uri,
              range: s.range,
              selectionRange: s.selectionRange,
            });
          }
          walk(s.children, s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Interface ? s.name : container);
        } else if (METHOD_KINDS.has(s.kind)) {
          const name = s.name.replace(/\(.*$/, "");
          const text = doc.getText(s.location.range);
          const at = Math.max(0, text.indexOf(name + "("), text.indexOf(name));
          const start = doc.positionAt(doc.offsetAt(s.location.range.start) + at);
          out.push({
            name,
            detail: s.containerName,
            uri: doc.uri,
            range: s.location.range,
            selectionRange: new vscode.Range(start, start.translate(0, name.length)),
          });
        }
      }
    };
    walk(symbols, "");
    return out;
  }

  /** LWC template: each element with event handlers (`onclick={handleSave}`) is a caller. */
  private fromTemplate(doc: vscode.TextDocument): Item[] {
    return templateHandlers(doc.getText()).map((el) => {
      const tag = doc.positionAt(el.tagStart);
      return {
        name: `<${el.tag}> ${el.handlers.map((h) => "on" + h.event).join(" ")}`,
        detail: "",
        uri: doc.uri,
        range: new vscode.Range(doc.positionAt(el.start), doc.positionAt(el.end)),
        selectionRange: new vscode.Range(tag, tag.translate(0, el.tag.length)),
      };
    });
  }

  private fromText(doc: vscode.TextDocument): Item[] {
    return findMethodDecls(doc.getText()).map((d) => {
      const nameStart = doc.positionAt(d.nameOffset);
      return {
        name: d.name,
        detail: d.container,
        uri: doc.uri,
        range: new vscode.Range(doc.positionAt(d.start), doc.positionAt(d.end)),
        selectionRange: new vscode.Range(nameStart, nameStart.translate(0, d.name.length)),
      };
    });
  }

  /** Innermost method whose range contains pos. */
  async enclosing(uri: vscode.Uri, pos: vscode.Position): Promise<Item | undefined> {
    const methods = await this.methodsIn(uri);
    return methods
      .filter((m) => m.range.contains(pos))
      .sort((a, b) => b.range.start.compareTo(a.range.start))[0];
  }

  prepare(uri: vscode.Uri, pos: vscode.Position): Promise<Item | undefined> {
    return this.enclosing(uri, pos);
  }

  async incoming(item: Item): Promise<Incoming[]> {
    let refs: vscode.Location[] = [];
    try {
      refs =
        (await vscode.commands.executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          item.uri,
          item.selectionRange.start
        )) ?? [];
    } catch {
      refs = [];
    }
    const groups = new Map<string, Incoming>();
    if (!refs.length) return this.callersByName(item);
    for (const ref of refs.slice(0, 200)) {
      if (ref.uri.toString() === item.uri.toString() && ref.range.intersection(item.selectionRange)) continue;
      const from = await this.enclosing(ref.uri, ref.range.start);
      if (!from) continue;
      const id = itemId(from);
      const g = groups.get(id) ?? { from, sites: [] };
      g.sites.push(ref.range);
      groups.set(id, g);
    }
    return [...groups.values()];
  }

  async outgoing(item: Item): Promise<Outgoing[]> {
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const bodyStart = doc.offsetAt(item.selectionRange.end);
    const body = doc.getText(new vscode.Range(item.selectionRange.end, item.range.end));
    const candidates = findCallCandidates(body, bodyStart).slice(0, 60);
    const resolved = await Promise.all(
      candidates.map(async (c) => {
        const pos = doc.positionAt(c.offset);
        const site = new vscode.Range(pos, pos.translate(0, c.name.length));
        const target = await this.definitionOf(item.uri, pos);
        if (target) return { site, target, to: undefined as Item | undefined };
        const to = await this.byName(item.uri, doc, c.name, c.offset);
        return to ? { site, target: new vscode.Location(to.uri, to.selectionRange), to } : undefined;
      })
    );
    const groups = new Map<string, Outgoing>();
    for (const r of resolved) {
      if (!r) continue;
      const to = r.to ?? (await this.enclosing(r.target.uri, r.target.range.start));
      if (!to || itemId(to) === itemId(item)) continue;
      // The definition must be the method's own name, not something inside it.
      const at = r.target.range.start;
      if (!to.selectionRange.contains(at) && to.selectionRange.start.line !== at.line) continue;
      const id = itemId(to);
      const g = groups.get(id) ?? { to, sites: [] };
      g.sites.push(r.site);
      groups.set(id, g);
    }
    return [...groups.values()];
  }

  private async definitionOf(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.Location | undefined> {
    try {
      const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        pos
      );
      const d = defs?.[0];
      if (!d) return undefined;
      return "targetUri" in d
        ? new vscode.Location(d.targetUri, d.targetSelectionRange ?? d.targetRange)
        : d;
    } catch {
      return undefined;
    }
  }
}

/** Which indexed files can call methods declared in `uri`, matched by name. */
function nameMatchKind(uri: vscode.Uri): FileKind | undefined {
  const k = kindOf(uri);
  return k === "apex" || k === "java" ? k : undefined;
}

/** The innermost declared method around an offset, as an item. */
function declAround(entry: Entry, offset: number): Item | undefined {
  let best: Entry["decls"][number] | undefined;
  for (const d of entry.decls) if (d.start <= offset && offset < d.end && (!best || d.start > best.start)) best = d;
  return best && declItem(entry, best);
}

function declItem(entry: Entry, d: Entry["decls"][number]): Item {
  const name = positionIn(entry, d.nameOffset);
  return {
    name: d.name,
    detail: d.container,
    uri: entry.uri,
    range: new vscode.Range(positionIn(entry, d.start), positionIn(entry, d.end)),
    selectionRange: new vscode.Range(name, name.translate(0, d.name.length)),
  };
}
