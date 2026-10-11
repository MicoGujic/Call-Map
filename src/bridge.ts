import * as vscode from "vscode";
import { kindOf } from "./index";
import { apexCallArgs, apexCallSites, apexImports, readParams, splitList, templateHandlers } from "./parse";
import { Incoming, Item, Outgoing, UsagesSource } from "./sources";

interface Site {
  cls: string;
  method: string;
  /** Where the local name (or the Aura "c.method" string) starts, and its length. */
  offset: number;
  len: number;
  wire: boolean;
  aura?: boolean;
}

const isJs = (uri: vscode.Uri) => /\.(m?js|ts)$/i.test(uri.path);
const isApex = (uri: vscode.Uri) => /\.cls$/i.test(uri.path);

/**
 * Links Salesforce frontend code to the Apex it calls:
 * LWC `import x from '@salesforce/apex/Class.method'` (called or used in @wire),
 * and Aura `component.get("c.method")` with the bundle's `controller="Class"`.
 */
export class ApexBridge {
  constructor(private readonly usages: UsagesSource) {}

  private get index() {
    return this.usages.index;
  }

  private async apexMethod(cls: string, method: string): Promise<Item | undefined> {
    const file = await this.index.fileFor(cls, "apex");
    if (!file) return undefined;
    return (await this.usages.methodsIn(file)).find(
      (m) => m.name.toLowerCase() === method.toLowerCase() && (m.detail ?? "").toLowerCase() === cls.toLowerCase()
    );
  }

  private async params(item: Item): Promise<string[]> {
    const doc = await vscode.workspace.openTextDocument(item.uri);
    return readParams(doc.getText(), doc.offsetAt(item.selectionRange.end));
  }

  /** Aura: the Apex controller named in the component next to this JS file. */
  private async auraController(js: vscode.Uri): Promise<string | undefined> {
    if (!/\/aura\//i.test(js.path)) return undefined;
    const dir = vscode.Uri.joinPath(js, "..");
    const bundle = /([^/]+)\/?$/.exec(dir.path)?.[1];
    for (const ext of ["cmp", "app"]) {
      try {
        const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${bundle}.${ext}`)));
        const m = /\bcontroller\s*=\s*["'](?:\w+\.)?(\w+)["']/.exec(text);
        if (m) return m[1];
      } catch {
        // no such file
      }
    }
    return undefined;
  }

  /** Every call into Apex in one JS file. */
  private async callsIn(js: vscode.Uri): Promise<Site[]> {
    const { raw, masked } = await this.usages.textOf(js);
    const out: Site[] = [];
    for (const [local, target] of apexImports(raw)) {
      for (const site of apexCallSites(masked, local)) out.push({ ...target, ...site, len: local.length });
    }
    const controller = await this.auraController(js);
    if (controller) {
      const re = /["']c\.(\w+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw))) out.push({ cls: controller, method: m[1], offset: m.index + 1, wire: false, len: m[0].length - 2, aura: true });
    }
    return out;
  }

  private async argsAt(js: vscode.Uri, site: Site, params: string[]): Promise<string[]> {
    if (site.aura) return []; // Aura sets parameters separately with setParams
    const { raw } = await this.usages.textOf(js);
    if (!site.wire) return apexCallArgs(raw, site.offset + site.len, params);
    // @wire(adapter, { … }): the config object is the second argument.
    const open = raw.lastIndexOf("(", site.offset);
    const list = splitList(raw, open);
    return list && list[1] ? apexCallArgs(`f(${list[1]})`, 1, params) : [];
  }

  /** The method or @wire property in a JS file that holds `offset`. */
  private async holder(js: vscode.Uri, offset: number, wire: boolean): Promise<Item | undefined> {
    const doc = await vscode.workspace.openTextDocument(js);
    const pos = doc.positionAt(offset);
    if (!wire) {
      const inside = await this.usages.enclosing(js, pos);
      if (inside) return inside;
    }
    // A @wire on a property or a call outside any method: name it after the property.
    const text = doc.getText();
    const close = (() => {
      const open = text.lastIndexOf("(", offset);
      let depth = 0;
      for (let i = open; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")" && --depth === 0) return i;
      }
      return offset;
    })();
    const prop = /^\s*([A-Za-z_$][\w$]*)/.exec(text.slice(close + 1));
    const cls = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? "";
    const start = doc.positionAt(prop ? close + 1 + prop.index + prop[0].indexOf(prop[1]) : offset);
    const line = doc.lineAt(pos.line);
    return {
      name: wire ? "@wire " + (prop?.[1] ?? "?") : cls || "(top level)",
      detail: cls,
      uri: js,
      range: new vscode.Range(line.range.start, doc.lineAt(start.line).range.end),
      selectionRange: new vscode.Range(start, start.translate(0, prop?.[1].length ?? 1)),
    };
  }

  /** JavaScript that calls an Apex method, or LWC templates that call a JS handler. */
  async incoming(item: Item): Promise<Incoming[]> {
    if (kindOf(item.uri) === "js") return this.templateCallers(item);
    if (!isApex(item.uri)) return [];
    const cls = (item.detail || /([^/]+)\.cls$/i.exec(item.uri.path)?.[1] || "").toLowerCase();
    const name = item.name.toLowerCase();
    const params = await this.params(item);
    const groups = new Map<string, Incoming>();
    // LWC files that import this method, and Aura controllers (which name it in a string).
    const lwc = (await this.index.apexImporters(cls, name)).map((x) => x.uri);
    const aura = await this.index.auraCallers(name);
    for (const js of [...lwc, ...aura]) {
      const { raw } = await this.usages.textOf(js);
      if (!raw.toLowerCase().includes(name)) continue;
      const doc = await vscode.workspace.openTextDocument(js);
      for (const site of await this.callsIn(js)) {
        if (site.cls.toLowerCase() !== cls || site.method.toLowerCase() !== name) continue;
        const from = await this.holder(js, site.offset, site.wire);
        if (!from) continue;
        const key = `${from.uri}#${from.selectionRange.start.line}:${from.selectionRange.start.character}`;
        const pos = doc.positionAt(site.offset);
        const g = groups.get(key) ?? { from, sites: [], args: await this.argsAt(js, site, params) };
        g.sites.push(new vscode.Range(pos, pos.translate(0, site.len)));
        groups.set(key, g);
      }
    }
    return [...groups.values()];
  }

  /** Apex methods a JavaScript method calls, or the JS handlers a template element calls. */
  async outgoing(item: Item): Promise<Outgoing[]> {
    if (kindOf(item.uri) === "html") return this.templateCalls(item);
    if (!isJs(item.uri)) return [];
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const from = doc.offsetAt(item.range.start);
    const to = doc.offsetAt(item.range.end);
    const groups = new Map<string, Outgoing>();
    for (const site of await this.callsIn(item.uri)) {
      if (site.offset < from || site.offset > to) continue;
      const target = await this.apexMethod(site.cls, site.method);
      if (!target) continue;
      const key = `${target.uri}#${target.selectionRange.start.line}`;
      const pos = doc.positionAt(site.offset);
      const g = groups.get(key) ?? { to: target, sites: [], args: await this.argsAt(item.uri, site, await this.params(target)) };
      g.sites.push(new vscode.Range(pos, pos.translate(0, site.len)));
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  /** The component's JS file next to an LWC template (bundle/bundle.js). */
  private bundleJs(html: vscode.Uri): vscode.Uri {
    const dir = vscode.Uri.joinPath(html, "..");
    const bundle = /([^/]+)\/?$/.exec(dir.path)?.[1] ?? "";
    return vscode.Uri.joinPath(dir, `${bundle}.js`);
  }

  private async templateCalls(item: Item): Promise<Outgoing[]> {
    const doc = await vscode.workspace.openTextDocument(item.uri);
    const from = doc.offsetAt(item.range.start), to = doc.offsetAt(item.range.end);
    let methods: Item[] = [];
    try {
      methods = await this.usages.methodsIn(this.bundleJs(item.uri));
    } catch {
      return [];
    }
    const out: Outgoing[] = [];
    for (const el of templateHandlers(doc.getText())) {
      if (el.start < from || el.start > to) continue;
      for (const h of el.handlers) {
        const target = methods.find((m) => m.name === h.method);
        if (!target) continue;
        const pos = doc.positionAt(h.offset);
        out.push({ to: target, sites: [new vscode.Range(pos, pos.translate(0, h.method.length))], args: ["on" + h.event] });
      }
    }
    return out;
  }

  private async templateCallers(item: Item): Promise<Incoming[]> {
    if (!/\/lwc\//i.test(item.uri.path)) return [];
    const dir = vscode.Uri.joinPath(item.uri, "..").toString();
    const templates = (await this.index.files("html")).filter((u) => vscode.Uri.joinPath(u, "..").toString() === dir);
    const out: Incoming[] = [];
    for (const html of templates) {
      const doc = await vscode.workspace.openTextDocument(html);
      const elements = await this.usages.methodsIn(html);
      for (const el of templateHandlers(doc.getText())) {
        const hits = el.handlers.filter((h) => h.method === item.name);
        if (!hits.length) continue;
        const from = elements.find((e) => doc.offsetAt(e.range.start) === el.start);
        if (!from) continue;
        out.push({
          from,
          sites: hits.map((h) => {
            const pos = doc.positionAt(h.offset);
            return new vscode.Range(pos, pos.translate(0, h.method.length));
          }),
          args: hits.map((h) => "on" + h.event),
        });
      }
    }
    return out;
  }
}
