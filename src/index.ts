import * as vscode from "vscode";
import { FlowInfo, parseFlow } from "./flowparse";
import {
  apexFlowStarts,
  apexImports,
  auraFlowStarts,
  findMethodDecls,
  firedEvents,
  maskStringsAndComments,
  MethodDecl,
  supertypesIn,
  tagBundle,
  templateElements,
} from "./parse";

/** Files Call Map matches by name: Apex, Java, Salesforce frontend bundles, and flows. */
const GLOB = "{**/*.cls,**/*.trigger,**/*.java,**/lwc/**/*.js,**/lwc/**/*.html,**/aura/**/*.js,**/*.flow-meta.xml}";
const EXCLUDE = "**/{node_modules,.sfdx,.sf,.git,target,build,out}/**";
const MAX_FILES = 20000;
const TEXT_CACHE = 120;

export type FileKind = "apex" | "java" | "js" | "html" | "flow";

export function kindOf(uri: vscode.Uri): FileKind | undefined {
  const ext = (/\.([^./]+)$/.exec(uri.path)?.[1] ?? "").toLowerCase();
  if (ext === "cls" || ext === "trigger") return "apex";
  if (ext === "java") return "java";
  if (ext === "js" && /\/(lwc|aura)\//i.test(uri.path)) return "js";
  if (ext === "html" && /\/lwc\//i.test(uri.path)) return "html";
  if (ext === "xml" && /\.flow-meta\.xml$/i.test(uri.path)) return "flow";
  return undefined;
}

/** The LWC bundle a file belongs to (`…/lwc/contactList/contactList.js` → `contactList`). */
export function bundleOf(uri: vscode.Uri): string | undefined {
  return /\/lwc\/([^/]+)\/[^/]+$/i.exec(uri.path)?.[1];
}

/** A flow's API name, from its file name. */
export function flowApiName(uri: vscode.Uri): string {
  const file = uri.path.slice(uri.path.lastIndexOf("/") + 1);
  const suffix = ".flow-meta.xml";
  return file.toLowerCase().endsWith(suffix) ? file.slice(0, -suffix.length) : "";
}

/** One call: where the called name starts, and the word before the dot (`Foo.bar(` → "foo"). */
export interface CallSite {
  o: number;
  q?: string;
}

/** What one file contributes, kept small: names and offsets, not the text. */
export interface Entry {
  uri: vscode.Uri;
  kind: FileKind;
  /** Lowercased called name → call sites. */
  calls: Map<string, CallSite[]>;
  /** Apex and Java: method declarations, so callers are found without opening the file. */
  decls: MethodDecl[];
  /** Offset where each line starts. */
  lines: number[];
  /** Aura JS: methods named in "c.method" strings. */
  aura: Set<string>;
  /** Lowercased class name → names it extends or implements. */
  supers: Map<string, string[]>;
  /** JS: imports from @salesforce/apex. */
  apex: { local: string; cls: string; method: string }[];
  /** Lowercased words that appear anywhere (for quick "does this file mention X"). */
  words: Set<string>;
  /**
   * What the file links to outside plain calls, lowercased: "apex:class" (a
   * flow's Apex action), "flow:name" (a subflow, or a flow started from
   * code), "lwc:bundle" (a child component or flow screen component), and
   * "fires:event" (a CustomEvent the component fires).
   */
  refs: Set<string>;
  /** Flows: the parsed flow. */
  flow?: FlowInfo;
}

/**
 * One pass over the workspace, then kept current file by file: on save, on
 * create and delete, and while typing in an open file. Replaces re-reading
 * every file for each lookup.
 */
export class WorkspaceIndex implements vscode.Disposable {
  private entries = new Map<string, Entry>();
  /** Lowercased file base name → file, per kind ("apex:foo"). */
  private byBase = new Map<string, vscode.Uri>();
  /** Lowercased LWC bundle name → the bundle's main JS file. */
  private bundles = new Map<string, vscode.Uri>();
  private building: Promise<void> | undefined;
  private texts = new Map<string, { raw: string; masked: string }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: vscode.Disposable[] = [];
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** Fires after a file's entry changed. */
  readonly onDidChange = this.changed.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    this.disposables.push(
      watcher,
      this.changed,
      watcher.onDidCreate((u) => void this.update(u)),
      watcher.onDidChange((u) => void this.update(u)),
      watcher.onDidDelete((u) => this.remove(u)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (!kindOf(e.document.uri) || !e.contentChanges.length) return;
        const key = e.document.uri.toString();
        this.texts.delete(key);
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => void this.update(e.document.uri), 400));
      })
    );
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  /** Index the workspace once; later calls wait for the same pass. */
  ensure(): Promise<void> {
    this.building ??= (async () => {
      const uris = await vscode.workspace.findFiles(GLOB, EXCLUDE, MAX_FILES);
      let next = 0;
      await Promise.all(
        Array.from({ length: 8 }, async () => {
          while (next < uris.length) await this.update(uris[next++], false);
        })
      );
    })();
    return this.building;
  }

  get size(): number {
    return this.entries.size;
  }

  async files(kind: FileKind): Promise<vscode.Uri[]> {
    await this.ensure();
    return [...this.entries.values()].filter((e) => e.kind === kind).map((e) => e.uri);
  }

  /** Files of a kind that call `name(`, with each call site. */
  async callsTo(name: string, kinds: FileKind[]): Promise<{ entry: Entry; sites: CallSite[] }[]> {
    await this.ensure();
    const key = name.toLowerCase();
    const out: { entry: Entry; sites: CallSite[] }[] = [];
    for (const e of this.entries.values()) {
      const sites = kinds.includes(e.kind) ? e.calls.get(key) : undefined;
      if (sites) out.push({ entry: e, sites });
    }
    return out;
  }

  async entry(uri: vscode.Uri): Promise<Entry | undefined> {
    await this.ensure();
    return this.entries.get(uri.toString());
  }

  /** The file named after a class (`Foo` → Foo.cls), case-insensitive. */
  async fileFor(name: string, kind: FileKind): Promise<vscode.Uri | undefined> {
    await this.ensure();
    return this.byBase.get(`${kind}:${name.toLowerCase()}`);
  }

  /** Aura JS files that name `c.method` in a string. */
  async auraCallers(method: string): Promise<vscode.Uri[]> {
    await this.ensure();
    const m = method.toLowerCase();
    return [...this.entries.values()].filter((e) => e.aura.has(m)).map((e) => e.uri);
  }

  /** JS files that import an Apex method. */
  async apexImporters(cls: string, method: string): Promise<{ uri: vscode.Uri; local: string }[]> {
    await this.ensure();
    const c = cls.toLowerCase(), m = method.toLowerCase();
    const out: { uri: vscode.Uri; local: string }[] = [];
    for (const e of this.entries.values()) {
      for (const imp of e.apex) if (imp.cls.toLowerCase() === c && imp.method.toLowerCase() === m) out.push({ uri: e.uri, local: imp.local });
    }
    return out;
  }

  /** Files whose entry lists a link (see Entry.refs), such as "lwc:contactlist". */
  async withRef(ref: string): Promise<Entry[]> {
    await this.ensure();
    const key = ref.toLowerCase();
    return [...this.entries.values()].filter((e) => e.refs.has(key));
  }

  /** The main JS file of an LWC bundle. */
  async bundleJs(bundle: string): Promise<vscode.Uri | undefined> {
    await this.ensure();
    return this.bundles.get(bundle.toLowerCase());
  }

  async mentions(uri: vscode.Uri, word: string): Promise<boolean> {
    await this.ensure();
    return this.entries.get(uri.toString())?.words.has(word.toLowerCase()) ?? true;
  }

  /** What a class extends or implements, from whichever indexed file declares it. */
  async supertypes(name: string, hint?: vscode.Uri): Promise<string[]> {
    await this.ensure();
    const key = name.toLowerCase();
    const own = hint && this.entries.get(hint.toString())?.supers.get(key);
    if (own) return own;
    for (const e of this.entries.values()) {
      const s = e.supers.get(key);
      if (s) return s;
    }
    return [];
  }

  /** Text of a file, with strings and comments blanked. Open editors win over disk. */
  async text(uri: vscode.Uri): Promise<{ raw: string; masked: string }> {
    const key = uri.toString();
    const hit = this.texts.get(key);
    if (hit) {
      this.texts.delete(key);
      this.texts.set(key, hit); // most recently used last
      return hit;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    const raw = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const t = { raw, masked: maskStringsAndComments(raw) };
    this.texts.set(key, t);
    while (this.texts.size > TEXT_CACHE) this.texts.delete(this.texts.keys().next().value!);
    return t;
  }

  private remove(uri: vscode.Uri): void {
    const key = uri.toString();
    this.texts.delete(key);
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    const base = baseKey(e);
    if (this.byBase.get(base)?.toString() === key) this.byBase.delete(base);
    const bundle = mainBundle(uri);
    if (bundle && this.bundles.get(bundle)?.toString() === key) this.bundles.delete(bundle);
    this.changed.fire(uri);
  }

  private async update(uri: vscode.Uri, notify = true): Promise<void> {
    const kind = kindOf(uri);
    if (!kind) return;
    const key = uri.toString();
    this.texts.delete(key);
    let text: { raw: string; masked: string };
    try {
      text = await this.text(uri);
    } catch {
      this.remove(uri);
      return;
    }
    const e = entryFor(uri, kind, text.raw, text.masked);
    this.entries.set(key, e);
    if (!this.byBase.has(baseKey(e))) this.byBase.set(baseKey(e), uri);
    const bundle = mainBundle(uri);
    if (bundle) this.bundles.set(bundle, uri);
    if (notify) this.changed.fire(uri);
  }
}

function baseKey(e: Entry): string {
  const base = e.kind === "flow" ? flowApiName(e.uri) : (/([^/]+?)(\.[^./]+)?$/.exec(e.uri.path)?.[1] ?? "");
  return `${e.kind}:${base.toLowerCase()}`;
}

/** The bundle whose main file this is (`lwc/foo/foo.js` → "foo"), lowercased. */
function mainBundle(uri: vscode.Uri): string | undefined {
  const m = /\/lwc\/([^/]+)\/([^/]+)\.js$/i.exec(uri.path);
  return m && m[1].toLowerCase() === m[2].toLowerCase() ? m[1].toLowerCase() : undefined;
}

/** Offset of a position, from an entry's line table. */
export function offsetIn(e: Entry, pos: vscode.Position): number {
  return (e.lines[pos.line] ?? 0) + pos.character;
}

/** Position of an offset, from an entry's line table. */
export function positionIn(e: Entry, offset: number): vscode.Position {
  let lo = 0, hi = e.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (e.lines[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return new vscode.Position(lo, offset - e.lines[lo]);
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

export function entryFor(uri: vscode.Uri, kind: FileKind, raw: string, masked: string): Entry {
  const lines = [0];
  for (let i = raw.indexOf("\n"); i >= 0; i = raw.indexOf("\n", i + 1)) lines.push(i + 1);
  const refs = new Set<string>();
  if (kind === "flow") {
    const flow = parseFlow(raw);
    for (const el of flow.elements) {
      for (const c of el.calls) refs.add(`${c.type}:${c.type === "apex" ? c.target.replace(/^[A-Za-z0-9]+__/, "") : c.target}`.toLowerCase());
    }
    return { uri, kind, calls: new Map(), decls: [], lines, aura: new Set(), supers: new Map(), apex: [], words: new Set(), refs, flow };
  }
  const calls = new Map<string, CallSite[]>();
  const words = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const w = m[0].toLowerCase();
    words.add(w);
    let i = re.lastIndex;
    while (isSpace(masked[i])) i++;
    if (masked[i] !== "(") continue;
    // The word before a dot: `Foo.bar(` or `this.bar(`.
    let j = m.index - 1;
    while (isSpace(masked[j])) j--;
    let q: string | undefined;
    if (masked[j] === ".") {
      j--;
      while (isSpace(masked[j])) j--;
      const end = j + 1;
      while (j >= 0 && /[\w$]/.test(masked[j])) j--;
      if (end > j + 1) q = masked.slice(j + 1, end).toLowerCase();
    }
    const site: CallSite = q ? { o: m.index, q } : { o: m.index };
    const list = calls.get(w);
    if (list) list.push(site);
    else calls.set(w, [site]);
  }
  const decls = kind === "apex" || kind === "java" ? findMethodDecls(raw) : [];
  const aura = new Set<string>();
  if (kind === "js" && /\/aura\//i.test(uri.path)) {
    const ar = /["']c\.(\w+)["']/g;
    while ((m = ar.exec(raw))) aura.add(m[1].toLowerCase());
  }
  const supers = new Map<string, string[]>();
  if (kind === "apex" || kind === "java") {
    const decl = /\b(?:class|interface)\s+([A-Za-z_]\w*)/gi;
    while ((m = decl.exec(masked))) {
      const s = supertypesIn(masked.slice(m.index), m[1]);
      if (s.length) supers.set(m[1].toLowerCase(), s);
    }
  }
  const apex = kind === "js" ? [...apexImports(raw)].map(([local, t]) => ({ local, ...t })) : [];
  if (kind === "apex") for (const f of apexFlowStarts(raw, masked)) refs.add(`flow:${f.flow}`.toLowerCase());
  if (kind === "js" && /\/aura\//i.test(uri.path)) for (const f of auraFlowStarts(raw, masked)) refs.add(`flow:${f.flow}`.toLowerCase());
  if (kind === "js" && /\/lwc\//i.test(uri.path)) for (const ev of firedEvents(raw, masked)) refs.add(`fires:${ev.name}`.toLowerCase());
  if (kind === "html") {
    for (const el of templateElements(raw)) {
      const bundle = tagBundle(el.tag);
      if (bundle) refs.add(`lwc:${bundle}`.toLowerCase());
      const flow = el.tag.toLowerCase() === "lightning-flow" && el.attrs.find((a) => a.name === "flow-api-name")?.value;
      if (flow && flow.startsWith("'")) refs.add(`flow:${flow.slice(1, -1)}`.toLowerCase());
    }
  }
  return { uri, kind, calls, decls, lines, aura, supers, apex, words, refs };
}
