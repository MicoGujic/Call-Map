import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as oniguruma from "vscode-oniguruma";
import * as tm from "vscode-textmate";

/**
 * Colors code the way the editor does: the active color theme's token colors
 * applied by the same TextMate grammars the editor uses. Semantic highlighting
 * (an extra layer some languages add on top) is not reproduced.
 */

/** One line: runs of [length, colorIndex, fontStyle]. colorIndex 0 = default. */
type RawSetting = tm.IRawTheme["settings"][number];

/** One line: runs of [length, colorIndex, fontStyle]. colorIndex 0 = default. */
export type ColoredLine = [number, number, number][];

export interface Colors {
  colorMap: string[];
  lines: ColoredLine[];
}

interface GrammarInfo {
  scopeName: string;
  file: string;
  injectTo?: string[];
}

let onigReady: Promise<void> | undefined;
function loadOniguruma(extensionPath: string): Promise<void> {
  if (!onigReady) {
    const wasm = fs.readFileSync(path.join(extensionPath, "node_modules", "vscode-oniguruma", "release", "onig.wasm"));
    onigReady = oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
  }
  return onigReady;
}

/** JSON with comments and trailing commas, as theme files often are. */
export function parseJsonc(text: string): any {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const SIMPLE_CUSTOMIZATIONS: Record<string, string[]> = {
  comments: ["comment", "punctuation.definition.comment"],
  strings: ["string"],
  keywords: ["keyword", "storage.modifier", "storage.type"],
  numbers: ["constant.numeric"],
  types: ["entity.name.type", "entity.name.class", "support.type", "support.class"],
  functions: ["entity.name.function", "support.function"],
  variables: ["variable", "entity.name.variable"],
};

export class Highlighter {
  private registry: tm.Registry | undefined;
  private grammars = new Map<string, GrammarInfo>();
  private languageScopes = new Map<string, string>();
  private cache = new Map<string, { version: number; colors: Colors }>();

  constructor(private readonly extensionPath: string) {}

  reset(): void {
    this.registry = undefined;
    this.cache.clear();
  }

  private findTheme(): { file: string; ext: vscode.Extension<unknown> } | undefined {
    const configured = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    const dark = vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.Light &&
      vscode.window.activeColorTheme.kind !== vscode.ColorThemeKind.HighContrastLight;
    const wanted = [configured, dark ? "Default Dark Modern" : "Default Light Modern", dark ? "Default Dark+" : "Default Light+"];
    for (const name of wanted) {
      if (!name) continue;
      for (const ext of vscode.extensions.all) {
        for (const t of ext.packageJSON?.contributes?.themes ?? []) {
          if (t.id === name || t.label === name) return { file: path.join(ext.extensionPath, t.path), ext };
        }
      }
    }
    return undefined;
  }

  /** Token color rules of a theme file, following "include". */
  private readThemeRules(file: string, depth = 0): { rules: RawSetting[]; colors: Record<string, string> } {
    if (depth > 5 || !fs.existsSync(file)) return { rules: [], colors: {} };
    let theme: any;
    try {
      theme = parseJsonc(fs.readFileSync(file, "utf8"));
    } catch {
      return { rules: [], colors: {} };
    }
    const base = theme.include ? this.readThemeRules(path.join(path.dirname(file), theme.include), depth + 1) : { rules: [], colors: {} };
    let own: RawSetting[] = [];
    if (Array.isArray(theme.tokenColors)) own = theme.tokenColors;
    else if (typeof theme.tokenColors === "string" && theme.tokenColors.endsWith(".json")) {
      own = this.readThemeRules(path.join(path.dirname(file), theme.tokenColors), depth + 1).rules;
    } else if (Array.isArray(theme.settings)) own = theme.settings;
    return { rules: [...base.rules, ...own], colors: { ...base.colors, ...(theme.colors ?? {}) } };
  }

  private customizationRules(themeLabel: string | undefined): RawSetting[] {
    const c = vscode.workspace.getConfiguration("editor").get<any>("tokenColorCustomizations") ?? {};
    const out: RawSetting[] = [];
    const apply = (block: any) => {
      if (!block || typeof block !== "object") return;
      for (const [key, scopes] of Object.entries(SIMPLE_CUSTOMIZATIONS)) {
        const v = block[key];
        if (typeof v === "string") out.push({ scope: scopes, settings: { foreground: v } });
        else if (v && typeof v === "object") out.push({ scope: scopes, settings: v });
      }
      if (Array.isArray(block.textMateRules)) out.push(...block.textMateRules);
    };
    apply(c);
    if (themeLabel) apply(c[`[${themeLabel}]`]);
    return out;
  }

  private indexGrammars(): void {
    this.grammars.clear();
    this.languageScopes.clear();
    for (const ext of vscode.extensions.all) {
      for (const g of ext.packageJSON?.contributes?.grammars ?? []) {
        if (!g.scopeName || !g.path) continue;
        this.grammars.set(g.scopeName, { scopeName: g.scopeName, file: path.join(ext.extensionPath, g.path), injectTo: g.injectTo });
        if (g.language && !this.languageScopes.has(g.language)) this.languageScopes.set(g.language, g.scopeName);
      }
    }
  }

  private async getRegistry(): Promise<tm.Registry | undefined> {
    if (this.registry) return this.registry;
    await loadOniguruma(this.extensionPath);
    this.indexGrammars();
    const theme = this.findTheme();
    const label = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    const read = theme ? this.readThemeRules(theme.file) : { rules: [], colors: {} };
    const fg = read.colors["editor.foreground"] ?? (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ? "#000000" : "#D4D4D4");
    const bg = read.colors["editor.background"] ?? "#1E1E1E";
    const grammars = this.grammars;
    this.registry = new tm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (p: string[]) => new oniguruma.OnigScanner(p),
        createOnigString: (s: string) => new oniguruma.OnigString(s),
      }),
      theme: { settings: [{ settings: { foreground: fg, background: bg } }, ...read.rules, ...this.customizationRules(label)] },
      loadGrammar: async (scopeName) => {
        const g = grammars.get(scopeName);
        if (!g) return null;
        const content = fs.readFileSync(g.file, "utf8");
        return tm.parseRawGrammar(content, g.file);
      },
      getInjections: (scopeName) =>
        [...grammars.values()].filter((g) => g.injectTo?.includes(scopeName)).map((g) => g.scopeName),
    });
    return this.registry;
  }

  private scopeFor(doc: vscode.TextDocument): string | undefined {
    // Apex without the Salesforce extension: Java's grammar is a close match.
    // (.cls is also LaTeX's class extension, so check it before the language id.)
    if (doc.languageId === "apex" || /\.(cls|trigger)$/i.test(doc.uri.path)) {
      return this.languageScopes.get("apex") ?? this.languageScopes.get("java");
    }
    return this.languageScopes.get(doc.languageId);
  }

  /** Colors for a whole document, tokenized from the top so state is right. */
  async colorsFor(doc: vscode.TextDocument): Promise<Colors | undefined> {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version) return hit.colors;
    try {
      const registry = await this.getRegistry();
      if (!registry) return undefined;
      const scope = this.scopeFor(doc);
      if (!scope) return undefined;
      const grammar = await registry.loadGrammar(scope);
      if (!grammar) return undefined;
      const lines: ColoredLine[] = [];
      let stack = tm.INITIAL;
      const count = Math.min(doc.lineCount, 20000);
      for (let i = 0; i < count; i++) {
        const text = doc.lineAt(i).text;
        const r = grammar.tokenizeLine2(text, stack, 50);
        stack = r.ruleStack;
        const runs: ColoredLine = [];
        for (let t = 0; t < r.tokens.length; t += 2) {
          const start = r.tokens[t];
          const end = t + 2 < r.tokens.length ? r.tokens[t + 2] : text.length;
          const meta = r.tokens[t + 1];
          const fgIdx = (meta & 0x00ff8000) >>> 15;
          const style = (meta & 0x00007800) >>> 11;
          const prev = runs[runs.length - 1];
          if (prev && prev[1] === fgIdx && prev[2] === style) prev[0] += end - start;
          else runs.push([end - start, fgIdx, style]);
        }
        lines.push(runs);
      }
      const colors = { colorMap: registry.getColorMap(), lines };
      this.cache.set(key, { version: doc.version, colors });
      return colors;
    } catch (e) {
      console.error("Call Map: highlighting failed", e);
      return undefined;
    }
  }
}
