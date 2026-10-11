// Text helpers that work on raw source, so they behave the same for
// TypeScript, JavaScript, Java and Apex. No VS Code imports: unit-testable.

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE = new Set([")", "]", "}"]);
const MAX_ARG = 48;

/** Skip whitespace and comments starting at i; returns the next index. */
function skipSpace(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl + 1;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      return i;
    }
  }
}

/** `s` with every regular-expression character escaped, so a name can go into a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `s` without its generic argument lists, nested ones included (`Batchable<Map<Id, X>>` → `Batchable`). */
function stripGenerics(s: string): string {
  let depth = 0;
  let out = "";
  for (const ch of s) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** Skip a balanced <...> generic argument list (TS/Java) starting at '<'. */
function skipGenerics(text: string, i: number): number {
  let depth = 0;
  for (let j = i; j < text.length && j < i + 400; j++) {
    const ch = text[j];
    if (ch === "<") depth++;
    else if (ch === ">") {
      depth--;
      if (depth === 0) return j + 1;
    } else if (ch === ";" || ch === "{" || ch === ")") return i;
  }
  return i;
}

/**
 * Split the parenthesised list that starts at text[open] === '(' into its
 * top-level comma-separated parts. Returns undefined if unbalanced.
 */
export function splitList(text: string, open: number): string[] | undefined {
  if (text[open] !== "(") return undefined;
  const parts: string[] = [];
  const stack: string[] = [];
  let cur = "";
  let i = open + 1;
  const limit = Math.min(text.length, open + 4000);
  while (i < limit) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < limit && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      i = skipSpace(text, i);
      cur += " ";
      continue;
    }
    if (OPEN[ch]) {
      stack.push(OPEN[ch]);
    } else if (CLOSE.has(ch)) {
      if (stack.length === 0) {
        if (ch !== ")") return undefined;
        if (cur.trim() || parts.length) parts.push(cur);
        return parts.map((p) => p.replace(/\s+/g, " ").trim());
      }
      if (stack.pop() !== ch) return undefined;
    } else if (ch === "," && stack.length === 0) {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  return undefined;
}

/** Find the '(' that follows a name ending at `from`, allowing generics in between. */
export function findOpenParen(text: string, from: number): number {
  let i = skipSpace(text, from);
  if (text[i] === "<") {
    const after = skipGenerics(text, i);
    if (after === i) return -1;
    i = skipSpace(text, after);
  }
  if (text.startsWith("?.", i)) i = skipSpace(text, i + 2); // fn?.(x)
  return text[i] === "(" ? i : -1;
}

function shorten(s: string): string {
  return s.length > MAX_ARG ? s.slice(0, MAX_ARG - 1) + "…" : s;
}

/** Arguments of the call whose callee name ends at `from`. */
export function readArgs(text: string, from: number): string[] | undefined {
  const open = findOpenParen(text, from);
  if (open < 0) return undefined;
  return splitList(text, open)?.map(shorten);
}

/** Turn one declared parameter into its bare name, for TS, JS, Java and Apex. */
export function paramName(raw: string): string {
  let p = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  p = p.replace(/@\w+(\([^)]*\))?\s*/g, ""); // annotations / decorators
  if (p.startsWith("{") || p.startsWith("[")) return "{…}";
  const eq = p.search(/=(?!>)/);
  if (eq >= 0) p = p.slice(0, eq).trim();
  p = p.replace(/^((public|private|protected|readonly|override|final)\s+)+/, "");
  if (p.startsWith("...")) p = p.slice(3);
  const colon = p.indexOf(":");
  if (colon >= 0) return p.slice(0, colon).replace(/\?$/, "").trim(); // TS: name: Type
  const m = /([A-Za-z_$][\w$]*)\s*(\[\s*\])*$/.exec(p); // Java/Apex: Type name
  return m ? m[1] : p;
}

/** Parameter names of the declaration whose name ends at `from`. */
export function readParams(text: string, from: number): string[] {
  const open = findOpenParen(text, from);
  if (open < 0) return [];
  return (splitList(text, open) ?? []).filter((p) => p.trim()).map(paramName);
}

function cleanBlock(lines: string[]): string {
  return lines
    .map((l) =>
      l
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\* ?/, "")
        .trim()
    )
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

export interface DocResult {
  text: string;
  /** First line of the declaration itself, after any comment inside the range. */
  bodyStart: number;
}

/**
 * Find the comment that documents a declaration. Looks inside the declaration
 * range first (some servers include JSDoc in it), then above it, skipping
 * annotations such as @AuraEnabled or decorators.
 */
export function findDoc(lines: string[], rangeStart: number, nameLine: number): DocResult {
  // 1. A /** */ block inside the range, before the name line.
  for (let i = rangeStart; i < nameLine && i < lines.length; i++) {
    if (lines[i].trim().startsWith("/*")) {
      let end = i;
      while (end < nameLine && !lines[end].includes("*/")) end++;
      return { text: cleanBlock(lines.slice(i, end + 1)), bodyStart: end + 1 };
    }
  }
  // 2. Above the range.
  let i = rangeStart - 1;
  while (i >= 0 && /^\s*@\w+/.test(lines[i])) i--;
  if (i < 0) return { text: "", bodyStart: rangeStart };
  const t = lines[i].trim();
  if (t.endsWith("*/")) {
    let start = i;
    while (start > 0 && !lines[start].includes("/*")) start--;
    return { text: cleanBlock(lines.slice(start, i + 1)), bodyStart: rangeStart };
  }
  if (t.startsWith("//")) {
    let start = i;
    while (start > 0 && lines[start - 1].trim().startsWith("//")) start--;
    const text = lines
      .slice(start, i + 1)
      .map((l) => l.trim().replace(/^\/\/+\s?/, ""))
      .join("\n");
    return { text, bodyStart: rangeStart };
  }
  return { text: "", bodyStart: rangeStart };
}

const NOT_CALLS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new",
  "super", "this", "sizeof", "synchronized", "when", "else", "do", "try", "await",
  "void", "delete", "in", "of", "instanceof", "constructor",
]);

export interface CallCandidate {
  name: string;
  /** Offset of the first character of the callee name. */
  offset: number;
}

/**
 * Identifiers followed by '(' inside `text`, in order. Skips keywords,
 * constructor calls (`new Foo(`), strings and comments. Used where the
 * language has no call hierarchy (Apex).
 */
export function findCallCandidates(text: string, base = 0): CallCandidate[] {
  const out: CallCandidate[] = [];
  const masked = maskStringsAndComments(text);
  const re = /\b([A-Za-z_$][\w$]*)\s*(?:<[^<>;(){}]*>\s*)?\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const name = m[1];
    if (NOT_CALLS.has(name) || NOT_CALLS.has(name.toLowerCase())) continue;
    const before = masked.slice(Math.max(0, m.index - 8), m.index);
    if (/\bnew\s+$/.test(before)) continue;
    out.push({ name, offset: base + m.index });
  }
  return out;
}

/** Replace string and comment contents with spaces, keeping offsets. */
export function maskStringsAndComments(text: string): string {
  const out = text.split("");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (text.startsWith("//", i)) {
      while (i < text.length && text[i] !== "\n") out[i++] = " ";
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      out[i++] = " ";
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") out[i++] = " ";
        if (i < text.length && text[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < text.length) out[i++] = " ";
    } else {
      i++;
    }
  }
  return out.join("");
}

export interface MethodDecl {
  name: string;
  /** Offset of the method name. */
  nameOffset: number;
  /** Offset where the declaration starts (modifiers / annotations). */
  start: number;
  /** Offset just after the closing brace (or ';' for abstract methods). */
  end: number;
  container: string;
}

const DECL_RE =
  /(^|[;{}\n])([ \t]*(?:@\w+(?:\([^)]*\))?\s*)*(?:(?:public|private|protected|global|static|override|virtual|abstract|final|webservice|testmethod|synchronized|async)\s+)*(?:[\w$.]+(?:<[^;{}()]*>)?(?:\[\])*\s+)?)([A-Za-z_$][\w$]*)\s*\(/gi;
const CLASS_RE = /\b(?:class|interface|enum|trigger)\s+([A-Za-z_$][\w$]*)/gi;
const DECL_SKIP = new Set([...NOT_CALLS, "class", "interface", "enum", "trigger"]);

/**
 * A rough outline of method declarations for brace languages (Java, Apex),
 * used when no language server provides document symbols.
 */
export function findMethodDecls(text: string): MethodDecl[] {
  const masked = maskStringsAndComments(text);
  const classes: { name: string; start: number; end: number }[] = [];
  let c: RegExpExecArray | null;
  CLASS_RE.lastIndex = 0;
  while ((c = CLASS_RE.exec(masked))) {
    const brace = masked.indexOf("{", c.index);
    if (brace < 0) continue;
    classes.push({ name: c[1], start: c.index, end: matchBrace(masked, brace) });
  }
  const out: MethodDecl[] = [];
  DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DECL_RE.exec(masked))) {
    const name = m[3];
    const nameOffset = m.index + m[1].length + m[2].length;
    DECL_RE.lastIndex = nameOffset + name.length;
    if (DECL_SKIP.has(name.toLowerCase())) continue;
    // A declaration has a type or modifier before the name, a parameter
    // list, then '{' (or ';' for abstract/interface methods).
    if (!/\S/.test(m[2])) continue;
    const open = masked.indexOf("(", nameOffset);
    const params = splitList(masked, open);
    if (!params) continue;
    const close = closingParen(masked, open);
    let j = skipSpace(masked, close + 1);
    const throwsM = /^throws\s+[\w$.,\s]+/.exec(masked.slice(j, j + 200));
    if (throwsM) j = skipSpace(masked, j + throwsM[0].length);
    const prefix = m[2].trim();
    const lastWord = /(\w+)$/.exec(prefix)?.[1].toLowerCase() ?? "";
    if (["return", "new", "throw", "else", "case", "await", "yield"].includes(lastWord)) continue;
    const isAbstract = masked[j] === ";" && /\babstract\b/i.test(prefix);
    if (masked[j] !== "{" && !isAbstract) continue;
    const end = masked[j] === "{" ? matchBrace(masked, j) : j + 1;
    const start = m.index + m[1].length + (m[2].length - m[2].trimStart().length);
    const owner = classes
      .filter((k) => k.start < nameOffset && nameOffset < k.end)
      .sort((a, b) => b.start - a.start)[0];
    out.push({ name, nameOffset, start, end, container: owner?.name ?? "" });
    if (masked[j] === "{") DECL_RE.lastIndex = j + 1;
  }
  return out;
}

function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return text.length - 1;
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  return text.length;
}

const NOT_TYPES = new Set(["return", "new", "else", "throw", "case", "in", "of", "instanceof", "final", "static", "public", "private", "protected", "global"]);

/**
 * The declared type of a variable, field or parameter named `name`, from the
 * last declaration before `offset` (`AbstractProvider provider = …`,
 * `List<Account> accs;`, `(Foo foo, …)`). Text should be masked. Returns the
 * last segment of a dotted type (`Outer.Inner` → `Inner`), or undefined.
 */
export function declaredTypeOf(masked: string, offset: number, name: string): string | undefined {
  const n = escapeRegExp(name);
  const re = new RegExp(`\\b([A-Za-z_][\\w.]*)\\s*(?:<[^;(){}]*>\\s*)?(?:\\[\\s*\\]\\s*)?\\b${n}\\s*(?=[=;,):])`, "gi");
  let found: string | undefined;
  let fallback: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const type = m[1].split(".").pop()!;
    if (NOT_TYPES.has(type.toLowerCase())) continue;
    if (m.index < offset) found = type;
    else fallback ??= type; // a field declared further down the class
  }
  return found ?? fallback;
}

/** Names a class extends or implements, as declared in `masked`. */
export function supertypesIn(masked: string, className: string): string[] {
  const n = escapeRegExp(className);
  const m = new RegExp(`\\b(?:class|interface)\\s+${n}\\b([^{]*)\\{`, "i").exec(masked);
  if (!m) return [];
  const out: string[] = [];
  const clause = stripGenerics(m[1]);
  for (const part of clause.split(/\b(?:extends|implements)\b/i).slice(1)) {
    for (const t of part.split(",")) {
      const name = t.trim().split(".").pop();
      if (name && /^[A-Za-z_]\w*$/.test(name)) out.push(name);
    }
  }
  return out;
}

/**
 * Whether the method declared at `nameLine` is a test: an @isTest / @Test
 * annotation or `testMethod` modifier between the previous statement and the
 * name. Lines should be masked.
 */
export function isTestDecl(lines: string[], nameLine: number): boolean {
  let head = lines[nameLine] ?? "";
  for (let i = nameLine - 1; i >= 0 && i >= nameLine - 12; i--) {
    const t = lines[i].trim();
    if (/[;{}]\s*$/.test(t)) break;
    head = t + " " + head;
  }
  return /@(is)?test\b|\btestmethod\b/i.test(head);
}

/**
 * Arguments of a call into Apex from JavaScript. LWC passes one object
 * (`getData({ recordId: this.recordId })`), so its keys are lined up with the
 * Apex method's parameters; anything else is read as plain arguments.
 */
export function apexCallArgs(text: string, from: number, params: string[]): string[] {
  const open = findOpenParen(text, from);
  const list = open < 0 ? undefined : splitList(text, open);
  if (!list) return [];
  if (list.length !== 1 || !list[0].startsWith("{")) return list.map(shorten);
  const entries = splitList("(" + list[0].slice(1, list[0].lastIndexOf("}")) + ")", 0) ?? [];
  const byKey = new Map<string, string>();
  for (const e of entries) {
    const m = /^['"]?([\w$]+)['"]?\s*(?::\s*([\s\S]*))?$/.exec(e.trim());
    if (m) byKey.set(m[1].toLowerCase(), (m[2] ?? m[1]).trim());
  }
  return params.map((p) => shorten(byKey.get(p.toLowerCase()) ?? "—"));
}

/** Apex methods a JavaScript file imports: local name → { cls, method }. */
export function apexImports(text: string): Map<string, { cls: string; method: string }> {
  const out = new Map<string, { cls: string; method: string }>();
  const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]@salesforce\/apex\/(?:[\w]+__)?([\w]+)\.([\w]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.set(m[1], { cls: m[2], method: m[3] });
  return out;
}

/** Offsets of uses of `name` as a call or a @wire adapter. */
export function apexCallSites(masked: string, name: string): { offset: number; wire: boolean }[] {
  const n = escapeRegExp(name);
  const out: { offset: number; wire: boolean }[] = [];
  const re = new RegExp(`(@wire\\s*\\(\\s*)?(?<![\\w$.])${n}\\b`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const at = m.index + (m[1]?.length ?? 0);
    const after = masked.slice(at + name.length).trimStart();
    if (m[1]) out.push({ offset: at, wire: true });
    else if (after.startsWith("(")) out.push({ offset: at, wire: false });
  }
  return out;
}

export interface TemplateElement {
  tag: string;
  /** Start and end of the start tag, and where the tag name begins. */
  start: number;
  end: number;
  tagStart: number;
  handlers: { event: string; method: string; offset: number }[];
}

/** Elements of an LWC template that bind events to JS methods: `onclick={handleSave}`. */
export function templateHandlers(html: string): TemplateElement[] {
  const text = html.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length));
  const out: TemplateElement[] = [];
  const tagRe = /<([A-Za-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const attrsAt = m.index + 1 + m[1].length;
    const handlers: TemplateElement["handlers"] = [];
    const attrRe = /(?<=\s)on([\w-]+)\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2]))) {
      handlers.push({ event: a[1], method: a[2], offset: attrsAt + a.index + a[0].indexOf(a[2], a[0].indexOf("{")) });
    }
    if (handlers.length) out.push({ tag: m[1], start: m.index, end: m.index + m[0].length, tagStart: m.index + 1, handlers });
  }
  return out;
}
