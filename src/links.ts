import * as vscode from "vscode";
import { FlowCall, FlowElement } from "./flowparse";
import { bundleOf, Entry, flowApiName, kindOf, offsetIn, positionIn } from "./index";
import {
  apexFlowStarts,
  attrProp,
  auraFlowStarts,
  bundleTag,
  childCalls,
  FiredEvent,
  firedEvents,
  isInvocableDecl,
  splitList,
  tagBundle,
  TemplateElement,
  templateElements,
} from "./parse";
import { Incoming, Item, itemId, Outgoing, UsagesSource } from "./sources";

/** An Apex class name without its namespace (`ns__Foo` → `foo`), lowercased. */
const bareClass = (name: string) => name.replace(/^[A-Za-z0-9]+__/, "").toLowerCase();
const isLwc = (uri: vscode.Uri) => /\/lwc\//i.test(uri.path);
const isAura = (uri: vscode.Uri) => /\/aura\//i.test(uri.path);
const unquote = (v: string) => (/^'.*'$/.test(v) ? v.slice(1, -1) : v);

/** `value → name` for each input, as a flow step passes them. */
const inputMap = (inputs: FlowCall["inputs"]) => inputs.map((i) => `${i.value || "…"} → ${i.name}`).join(" · ");
/** The pairs a child component gets from a parent's tag: `contact → contact`. */
const propMap = (el: TemplateElement) =>
  el.attrs.filter((a) => a.name !== "lwc:ref").map((a) => `${a.value} → ${attrProp(a.name)}`).join(" · ") || "no properties";
const propArgs = (el: TemplateElement) => el.attrs.filter((a) => a.name !== "lwc:ref").map((a) => a.value);
const eventMap = (ev: FiredEvent) => `${ev.name} event${ev.detail ? ` · detail: ${ev.detail}` : ""}`;

/** Adds `site` to the link for `item`, keeping one link per item. */
function group<T extends { sites: vscode.Range[] }>(groups: Map<string, T>, item: Item, site: vscode.Range, make: () => T): void {
  const key = itemId(item);
  const g = groups.get(key) ?? make();
  g.sites.push(site);
  groups.set(key, g);
}

/**
 * Salesforce links that aren't calls in code:
 * - Flows: Apex actions (@InvocableMethod), subflows, LWC screen components,
 *   and flows started from Apex, Aura or a <lightning-flow> tag.
 * - LWC parents and children: a child's tag in a parent's template, events a
 *   child fires that a parent handles, and a parent calling a child's @api
 *   methods.
 */
export class SalesforceLinks {
  constructor(private readonly usages: UsagesSource) {}

  private get index() {
    return this.usages.index;
  }

  // ---------- items that aren't methods ----------

  /** A whole flow, as one box on the map. */
  async flowItem(uri: vscode.Uri): Promise<Item | undefined> {
    const e = await this.index.entry(uri);
    if (!e?.flow) return undefined;
    const at = positionIn(e, e.flow.labelOffset);
    const end = new vscode.Position(Math.max(0, e.lines.length - 1), 0);
    return {
      name: e.flow.label || flowApiName(uri),
      detail: flowApiName(uri),
      uri,
      range: new vscode.Range(new vscode.Position(0, 0), end),
      selectionRange: new vscode.Range(at, at),
      role: "flow",
    };
  }

  private async flowNamed(name: string): Promise<Item | undefined> {
    const uri = await this.index.fileFor(name, "flow");
    return uri && this.flowItem(uri);
  }

  /** An LWC component as its parents see it: its JS class, named by its tag. */
  async componentItem(bundle: string): Promise<Item | undefined> {
    const uri = await this.index.bundleJs(bundle);
    const e = uri && (await this.index.entry(uri));
    if (!uri || !e) return undefined;
    const { masked } = await this.usages.textOf(uri);
    const m = /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/.exec(masked) ?? /\bclass\s+([A-Za-z_$][\w$]*)/.exec(masked);
    const nameAt = m ? m.index + m[0].length - m[1].length : 0;
    const open = masked.indexOf("{", nameAt);
    let end = masked.length;
    for (let i = open, depth = 0; open >= 0 && i < masked.length; i++) {
      if (masked[i] === "{") depth++;
      else if (masked[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    const name = positionIn(e, nameAt);
    return {
      name: `<${bundleTag(bundleOf(uri) ?? bundle)}>`,
      detail: m?.[1] ?? "",
      uri,
      range: new vscode.Range(positionIn(e, m ? m.index : 0), positionIn(e, end)),
      selectionRange: new vscode.Range(name, name.translate(0, m?.[1].length ?? 0)),
      role: "component",
    };
  }

  // ---------- the two directions ----------

  async incoming(item: Item): Promise<Incoming[]> {
    if (item.role === "flow") return this.flowCallers(item);
    if (item.role === "component") return this.componentUsers(item);
    const kind = kindOf(item.uri);
    if (kind === "apex") return this.flowsCalling(item);
    if (kind === "js" && isLwc(item.uri)) return [...(await this.eventSenders(item)), ...(await this.parentCallers(item))];
    return [];
  }

  async outgoing(item: Item): Promise<Outgoing[]> {
    if (item.role === "flow") return this.flowCalls(item);
    if (item.role === "component") return this.eventsFrom(item);
    const kind = kindOf(item.uri);
    if (kind === "apex" || (kind === "js" && isAura(item.uri))) return this.flowsStarted(item);
    if (kind === "html") return this.templateLinks(item);
    if (kind === "js" && isLwc(item.uri)) return [...(await this.eventsFrom(item)), ...(await this.childApiCalls(item))];
    return [];
  }

  // ---------- flows ----------

  /** The Apex method a flow step runs: the named one, or the class's @InvocableMethod. */
  private async apexTarget(call: FlowCall): Promise<Item | undefined> {
    const file = (await this.index.fileFor(call.target, "apex")) ?? (await this.index.fileFor(bareClass(call.target), "apex"));
    if (!file) return undefined;
    const methods = (await this.usages.methodsIn(file)).filter((m) => bareClass(m.detail ?? "") === bareClass(call.target));
    if (call.method) return methods.find((m) => m.name.toLowerCase() === call.method!.toLowerCase());
    const lines = (await this.usages.textOf(file)).masked.split(/\r?\n/);
    return methods.find((m) => isInvocableDecl(lines, m.selectionRange.start.line));
  }

  private async flowCalls(flow: Item): Promise<Outgoing[]> {
    const e = await this.index.entry(flow.uri);
    if (!e?.flow) return [];
    const groups = new Map<string, Outgoing>();
    for (const el of e.flow.elements) {
      for (const call of el.calls) {
        const to =
          call.type === "apex" ? await this.apexTarget(call) : call.type === "flow" ? await this.flowNamed(call.target) : await this.componentItem(call.target);
        if (!to) continue;
        const at = positionIn(e, call.offset);
        group(groups, to, new vscode.Range(at, at), () => ({
          to,
          sites: [],
          args: call.inputs.map((i) => i.value),
          map: call.inputs.length ? inputMap(call.inputs) : "no inputs",
        }));
      }
    }
    return [...groups.values()];
  }

  /** Steps in any flow that call `match`, as links from that flow. */
  private async flowSteps(ref: string, match: (call: FlowCall) => boolean): Promise<Incoming[]> {
    const out: Incoming[] = [];
    for (const e of await this.index.withRef(ref)) {
      if (!e.flow) continue;
      const from = await this.flowItem(e.uri);
      if (!from) continue;
      const hits: { el: FlowElement; call: FlowCall }[] = [];
      for (const el of e.flow.elements) for (const call of el.calls) if (match(call)) hits.push({ el, call });
      if (!hits.length) continue;
      const { el, call } = hits[0];
      out.push({
        from,
        sites: hits.map((h) => {
          const at = positionIn(e, h.call.offset);
          return new vscode.Range(at, at);
        }),
        args: call.inputs.map((i) => i.value),
        map: `${el.label}${call.inputs.length ? ": " + inputMap(call.inputs) : ""}`,
      });
    }
    return out;
  }

  /** Flows that run this Apex method: an @InvocableMethod as an action, or a Process.Plugin's invoke. */
  private async flowsCalling(item: Item): Promise<Incoming[]> {
    const cls = bareClass(item.detail || (/([^/]+)\.cls$/i.exec(item.uri.path)?.[1] ?? ""));
    const name = item.name.toLowerCase();
    const { masked } = await this.usages.textOf(item.uri);
    if (name !== "invoke" && !/@InvocableMethod\b/i.test(masked)) return [];
    const invocable = isInvocableDecl(masked.split(/\r?\n/), item.selectionRange.start.line);
    if (!invocable && name !== "invoke") return [];
    return this.flowSteps(`apex:${cls}`, (c) => c.type === "apex" && bareClass(c.target) === cls && (c.method ? c.method.toLowerCase() === name : invocable));
  }

  /** What starts a flow: other flows (subflows), Apex, Aura, and <lightning-flow> in LWC templates. */
  private async flowCallers(flow: Item): Promise<Incoming[]> {
    const name = (flow.detail ?? "").toLowerCase();
    const out = await this.flowSteps(`flow:${name}`, (c) => c.type === "flow" && c.target.toLowerCase() === name);
    const groups = new Map<string, Incoming>();
    for (const e of await this.index.withRef(`flow:${name}`)) {
      if (e.kind === "flow") continue;
      const { raw, masked } = await this.usages.textOf(e.uri);
      if (e.kind === "html") {
        const items = await this.usages.methodsIn(e.uri);
        for (const el of templateElements(raw)) {
          const api = el.attrs.find((a) => a.name === "flow-api-name");
          if (el.tag.toLowerCase() !== "lightning-flow" || !api || unquote(api.value).toLowerCase() !== name) continue;
          const from = items.find((i) => offsetIn(e, i.range.start) === el.start);
          const at = positionIn(e, el.tagStart);
          if (from) group(groups, from, new vscode.Range(at, at.translate(0, el.tag.length)), () => ({ from, sites: [], args: [] }));
        }
        continue;
      }
      const starts = e.kind === "apex" ? apexFlowStarts(raw, masked) : auraFlowStarts(raw, masked);
      for (const s of starts) {
        if (s.flow.toLowerCase() !== name) continue;
        const at = positionIn(e, s.offset);
        const from = await this.usages.enclosing(e.uri, at);
        if (from) group(groups, from, new vscode.Range(at, at.translate(0, s.flow.length)), () => ({ from, sites: [], args: startArgs(raw, s.offset) }));
      }
    }
    return [...out, ...groups.values()];
  }

  /** Flows started inside an Apex or Aura method. */
  private async flowsStarted(item: Item): Promise<Outgoing[]> {
    const e = await this.index.entry(item.uri);
    if (!e || !e.refs.size) return [];
    const { raw, masked } = await this.usages.textOf(item.uri);
    const from = offsetIn(e, item.range.start), to = offsetIn(e, item.range.end);
    const starts = kindOf(item.uri) === "apex" ? apexFlowStarts(raw, masked) : auraFlowStarts(raw, masked);
    const groups = new Map<string, Outgoing>();
    for (const s of starts) {
      if (s.offset < from || s.offset > to) continue;
      const flow = await this.flowNamed(s.flow);
      if (!flow) continue;
      const at = positionIn(e, s.offset);
      const args = startArgs(raw, s.offset);
      group(groups, flow, new vscode.Range(at, at.translate(0, s.flow.length)), () => ({ to: flow, sites: [], args, map: args.length ? "passes " + args.join(", ") : "no inputs" }));
    }
    return [...groups.values()];
  }

  // ---------- LWC parents and children ----------

  /** The template element an item stands for. */
  private async elementOf(item: Item): Promise<{ el: TemplateElement; entry: Entry } | undefined> {
    const entry = await this.index.entry(item.uri);
    if (!entry) return undefined;
    const start = offsetIn(entry, item.range.start);
    const el = templateElements((await this.usages.textOf(item.uri)).raw).find((x) => x.start === start);
    return el && { el, entry };
  }

  /** A tag in a parent's template: links to the child component, or to the flow in <lightning-flow>. */
  private async templateLinks(item: Item): Promise<Outgoing[]> {
    const found = await this.elementOf(item);
    if (!found) return [];
    const { el, entry } = found;
    const at = positionIn(entry, el.tagStart);
    const site = new vscode.Range(at, at.translate(0, el.tag.length));
    const bundle = tagBundle(el.tag);
    if (bundle) {
      const to = await this.componentItem(bundle);
      return to ? [{ to, sites: [site], args: propArgs(el), map: propMap(el) }] : [];
    }
    const api = el.attrs.find((a) => a.name === "flow-api-name");
    const flow = api && /^'/.test(api.value) ? await this.flowNamed(unquote(api.value)) : undefined;
    return flow ? [{ to: flow, sites: [site], args: [] }] : [];
  }

  /** Parents that use a component: tags in their templates, and flow screens. */
  private async componentUsers(component: Item): Promise<Incoming[]> {
    const bundle = bundleOf(component.uri) ?? "";
    const tag = bundleTag(bundle);
    const out: Incoming[] = [];
    for (const e of await this.index.withRef(`lwc:${bundle}`)) {
      if (e.kind !== "html") continue;
      const items = await this.usages.methodsIn(e.uri);
      for (const el of templateElements((await this.usages.textOf(e.uri)).raw)) {
        if (el.tag.toLowerCase() !== tag) continue;
        const from = items.find((i) => offsetIn(e, i.range.start) === el.start);
        const at = positionIn(e, el.tagStart);
        if (from) out.push({ from, sites: [new vscode.Range(at, at.translate(0, el.tag.length))], args: propArgs(el), map: "passes " + propMap(el) });
      }
    }
    out.push(...(await this.flowSteps(`lwc:${bundle}`, (c) => c.type === "lwc" && c.target.toLowerCase() === bundle.toLowerCase())));
    return out;
  }

  /**
   * Parent methods that handle an event a child fires. The handler is on the
   * child's tag (`<c-child onselect={handleSelect}>`); an event fired with
   * `bubbles: true` can also be handled on an element around it.
   */
  private async handlersOf(childBundle: string, ev: FiredEvent): Promise<Item[]> {
    const tag = bundleTag(childBundle);
    const out: Item[] = [];
    for (const e of await this.index.withRef(`lwc:${childBundle}`)) {
      if (e.kind !== "html") continue;
      const parentJs = await this.index.bundleJs(bundleOf(e.uri) ?? "");
      if (!parentJs) continue;
      const els = templateElements((await this.usages.textOf(e.uri)).raw);
      const names = new Set<string>();
      for (const child of els.filter((x) => x.tag.toLowerCase() === tag)) {
        const around = ev.bubbles ? els.filter((x) => x.start < child.start && x !== child) : [];
        for (const x of [child, ...around]) {
          for (const h of x.handlers) if (h.event.toLowerCase() === ev.name.toLowerCase()) names.add(h.method);
        }
      }
      if (!names.size) continue;
      const methods = await this.usages.methodsIn(parentJs);
      for (const n of names) {
        const m = methods.find((x) => x.name === n);
        if (m) out.push(m);
      }
    }
    return out;
  }

  /** Events fired inside `item` (a method, or the whole component), to the parent methods that handle them. */
  private async eventsFrom(item: Item): Promise<Outgoing[]> {
    const e = await this.index.entry(item.uri);
    const bundle = bundleOf(item.uri);
    if (!e || !bundle || ![...e.refs].some((r) => r.startsWith("fires:"))) return [];
    const { raw, masked } = await this.usages.textOf(item.uri);
    const from = offsetIn(e, item.range.start), to = offsetIn(e, item.range.end);
    const groups = new Map<string, Outgoing>();
    for (const ev of firedEvents(raw, masked)) {
      if (ev.offset < from || ev.offset > to) continue;
      const at = positionIn(e, ev.offset);
      for (const handler of await this.handlersOf(bundle, ev)) {
        group(groups, handler, new vscode.Range(at, at.translate(0, ev.name.length)), () => ({
          to: handler,
          sites: [],
          args: [ev.detail || ev.name],
          map: eventMap(ev),
        }));
      }
    }
    return [...groups.values()];
  }

  /** Child methods whose events this parent method handles. */
  private async eventSenders(handler: Item): Promise<Incoming[]> {
    const bundle = bundleOf(handler.uri);
    if (!bundle) return [];
    const dir = vscode.Uri.joinPath(handler.uri, "..").toString();
    const out: Incoming[] = [];
    for (const html of await this.index.files("html")) {
      if (vscode.Uri.joinPath(html, "..").toString() !== dir) continue;
      const els = templateElements((await this.usages.textOf(html)).raw);
      for (const el of els) {
        const events = el.handlers.filter((h) => h.method === handler.name).map((h) => h.event.toLowerCase());
        if (!events.length) continue;
        // The handler's own tag, or (for bubbling events) child tags after it.
        const children = tagBundle(el.tag) ? [{ child: el, direct: true }] : els.filter((x) => x.start > el.start && tagBundle(x.tag)).map((x) => ({ child: x, direct: false }));
        for (const { child, direct } of children) {
          const childJs = await this.index.bundleJs(tagBundle(child.tag)!);
          const ce = childJs && (await this.index.entry(childJs));
          if (!childJs || !ce || !events.some((ev) => ce.refs.has(`fires:${ev}`))) continue;
          const { raw, masked } = await this.usages.textOf(childJs);
          const groups = new Map<string, Incoming>();
          for (const ev of firedEvents(raw, masked)) {
            if (!events.includes(ev.name.toLowerCase()) || (!direct && !ev.bubbles)) continue;
            const at = positionIn(ce, ev.offset);
            const from = await this.usages.enclosing(childJs, at);
            if (from) group(groups, from, new vscode.Range(at, at.translate(0, ev.name.length)), () => ({ from, sites: [], args: [ev.detail || ev.name], map: eventMap(ev) }));
          }
          out.push(...groups.values());
        }
      }
    }
    // One link per child method, even when two tags lead to it.
    const seen = new Set<string>();
    return out.filter((i) => !seen.has(itemId(i.from)) && !!seen.add(itemId(i.from)));
  }

  /** `lwc:ref` names in a bundle's templates → the child bundle they point at. */
  private async refsOf(js: vscode.Uri): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    const dir = vscode.Uri.joinPath(js, "..").toString();
    for (const html of await this.index.files("html")) {
      if (vscode.Uri.joinPath(html, "..").toString() !== dir) continue;
      for (const el of templateElements((await this.usages.textOf(html)).raw)) {
        const ref = el.attrs.find((a) => a.name === "lwc:ref");
        const bundle = tagBundle(el.tag);
        if (ref && bundle) refs.set(unquote(ref.value), bundle);
      }
    }
    return refs;
  }

  /** A parent's calls into its children's @api methods. */
  private async childApiCalls(item: Item): Promise<Outgoing[]> {
    const e = await this.index.entry(item.uri);
    if (!e) return [];
    const { raw, masked } = await this.usages.textOf(item.uri);
    const from = offsetIn(e, item.range.start), to = offsetIn(e, item.range.end);
    const groups = new Map<string, Outgoing>();
    for (const c of childCalls(masked, raw, await this.refsOf(item.uri))) {
      if (c.offset < from || c.offset > to) continue;
      const childJs = await this.index.bundleJs(c.bundle);
      const target = childJs && (await this.usages.methodsIn(childJs)).find((m) => m.name === c.method);
      if (!target) continue;
      const at = positionIn(e, c.offset);
      group(groups, target, new vscode.Range(at, at.translate(0, c.method.length)), () => ({ to: target, sites: [] }));
    }
    return [...groups.values()];
  }

  /** Parent methods that call this child method through querySelector or lwc:ref. */
  private async parentCallers(item: Item): Promise<Incoming[]> {
    const bundle = bundleOf(item.uri);
    if (!bundle) return [];
    const groups = new Map<string, Incoming>();
    for (const { entry } of await this.index.callsTo(item.name, ["js"])) {
      if (!isLwc(entry.uri) || bundleOf(entry.uri) === bundle) continue;
      const { raw, masked } = await this.usages.textOf(entry.uri);
      for (const c of childCalls(masked, raw, await this.refsOf(entry.uri))) {
        if (c.bundle.toLowerCase() !== bundle.toLowerCase() || c.method !== item.name) continue;
        const at = positionIn(entry, c.offset);
        const from = await this.usages.enclosing(entry.uri, at);
        if (from) group(groups, from, new vscode.Range(at, at.translate(0, c.method.length)), () => ({ from, sites: [] }));
      }
    }
    return [...groups.values()];
  }
}

/** The inputs passed when starting a flow. */
function startArgs(raw: string, nameOffset: number): string[] {
  // `new Flow.Interview.Name(inputs)`: the arguments follow the name.
  const after = /^\w+\s*\(/.exec(raw.slice(nameOffset));
  const list = after
    ? splitList(raw, nameOffset + after[0].length - 1)
    : // `createInterview('Name', inputs)`, `startFlow("Name", inputs)`: the arguments besides the name.
      splitList(raw, raw.lastIndexOf("(", nameOffset))?.filter((a) => !/^['"]/.test(a));
  return (list ?? []).map((a) => a.replace(/\s+/g, " "));
}
