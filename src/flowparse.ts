// Reads Salesforce Flow metadata (.flow-meta.xml): its steps, the order they
// run in, and what each step calls (Apex actions, subflows, LWC screen
// components). Pure functions, no VS Code, so they can be unit tested.

/** One XML element: its tag, where it starts and ends, its children and its own text. */
export interface XNode {
  tag: string;
  start: number;
  end: number;
  children: XNode[];
  text: string;
}

/** A small XML reader for metadata files. Attributes are ignored; Flow metadata doesn't use them. */
export function parseXml(xml: string): XNode {
  const root: XNode = { tag: "", start: 0, end: xml.length, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.text += decode(xml.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      top.text += m[1];
      continue;
    }
    if (!m[3]) continue; // comment, <?xml ?> or <!DOCTYPE>
    if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag !== m[3]) continue;
        stack[i].end = re.lastIndex;
        stack.length = i;
        break;
      }
      continue;
    }
    const node: XNode = { tag: m[3], start: m.index, end: re.lastIndex, children: [], text: "" };
    top.children.push(node);
    if (!m[5]) stack.push(node);
  }
  return root;
}

function decode(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi, (all, e: string) => {
    const named: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
    if (named[e.toLowerCase()]) return named[e.toLowerCase()];
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : all;
  });
}

const kid = (n: XNode | undefined, tag: string) => n?.children.find((c) => c.tag === tag);
const kids = (n: XNode | undefined, tag: string) => n?.children.filter((c) => c.tag === tag) ?? [];
const val = (n: XNode | undefined, tag: string) => kid(n, tag)?.text.trim() ?? "";

function* descendants(n: XNode, tag: string): Generator<XNode> {
  for (const c of n.children) {
    if (c.tag === tag) yield c;
    yield* descendants(c, tag);
  }
}

const MAX_VALUE = 40;
const short = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_VALUE ? one.slice(0, MAX_VALUE - 1) + "…" : one;
};

/** A value as Flow Builder shows it: a resource name, or a literal. */
function valueText(v: XNode | undefined): string {
  if (!v) return "";
  const ref = val(v, "elementReference");
  if (ref) return ref;
  const s = kid(v, "stringValue");
  if (s) return short(`'${s.text.trim()}'`);
  for (const t of ["numberValue", "booleanValue", "dateValue", "dateTimeValue", "apexValue", "formulaExpression"]) {
    const x = val(v, t);
    if (x) return short(x);
  }
  return "";
}

export interface FlowCall {
  type: "apex" | "flow" | "lwc";
  /** Apex class, flow API name, or LWC component name (`c:myComponent` → `myComponent`). */
  target: string;
  /** Apex method, when the step names one (Apex plugins call `invoke`). Invocable actions don't. */
  method?: string;
  inputs: { name: string; value: string }[];
  /** Where the call is in the file (the step, or the screen component). */
  offset: number;
}

export interface FlowElement {
  /** Metadata tag: actionCalls, screens, decisions, … */
  kind: string;
  name: string;
  label: string;
  start: number;
  end: number;
  /** Steps it can go to next, in the order they're written. */
  next: string[];
  calls: FlowCall[];
  /** A short note: the object, the action, the decision's outcomes. */
  detail: string;
}

export interface FlowInfo {
  apiVersion: string;
  label: string;
  description: string;
  /** "Screen flow", "Record-triggered flow · Account, after save on create", … */
  type: string;
  status: string;
  /** Where the flow's <label> is, or 0. */
  labelOffset: number;
  /** The steps, in the order they run from Start (unreachable ones last). */
  elements: FlowElement[];
}

/** Step tags, and short names for them in the map (Flow Builder's names, shortened to keep the column narrow). */
const STEPS: Record<string, string> = {
  actionCalls: "Action",
  apexPluginCalls: "Plugin",
  assignments: "Assign",
  collectionProcessors: "Collect",
  customErrors: "Error",
  decisions: "Decision",
  loops: "Loop",
  orchestratedStages: "Stage",
  recordCreates: "Create",
  recordDeletes: "Delete",
  recordLookups: "Get",
  recordRollbacks: "Rollback",
  recordUpdates: "Update",
  screens: "Screen",
  steps: "Step",
  subflows: "Subflow",
  transforms: "Transform",
  waits: "Wait",
};

const inputsOf = (n: XNode, tag: string) =>
  kids(n, tag)
    .map((p) => ({ name: val(p, "name"), value: valueText(kid(p, "value")) }))
    .filter((p) => p.name);

/** Salesforce's own screen components (`flowruntime:address`, `forceContent:fileUpload`), not ones in the project. */
const STANDARD = /^(flowruntime|force\w*|lightning\w*|runtime\w*|ui):/i;

/** `c:myComponent` or `ns:myComponent` → `myComponent`. */
const componentName = (ext: string) => ext.slice(ext.indexOf(":") + 1);

function callsOf(kind: string, n: XNode): FlowCall[] {
  if (kind === "actionCalls") {
    const type = val(n, "actionType").toLowerCase();
    const target = val(n, "actionName");
    if (!target || (type !== "apex" && type !== "flow")) return [];
    return [{ type: type as "apex" | "flow", target, inputs: inputsOf(n, "inputParameters"), offset: n.start }];
  }
  if (kind === "apexPluginCalls") {
    const target = val(n, "apexClass");
    return target ? [{ type: "apex", target, method: "invoke", inputs: inputsOf(n, "inputParameters"), offset: n.start }] : [];
  }
  if (kind === "subflows") {
    const target = val(n, "flowName");
    return target ? [{ type: "flow", target, inputs: inputsOf(n, "inputAssignments"), offset: n.start }] : [];
  }
  if (kind === "screens") {
    const out: FlowCall[] = [];
    for (const f of descendants(n, "fields")) {
      const ext = val(f, "extensionName");
      if (ext && val(f, "fieldType") === "ComponentInstance" && !STANDARD.test(ext)) {
        out.push({ type: "lwc", target: componentName(ext), inputs: inputsOf(f, "inputParameters"), offset: f.start });
      }
    }
    return out;
  }
  return [];
}

function detailOf(kind: string, n: XNode): string {
  switch (kind) {
    case "actionCalls": {
      const type = val(n, "actionType");
      return `${type === "apex" ? "Apex" : type} ${val(n, "actionName")}`.trim();
    }
    case "apexPluginCalls":
      return `Apex ${val(n, "apexClass")}`;
    case "recordCreates":
    case "recordDeletes":
    case "recordLookups":
    case "recordUpdates":
      return val(n, "object") || val(n, "inputReference") || val(n, "inputAssignments");
    case "decisions": {
      const outcomes = kids(n, "rules").map((r) => val(r, "label") || val(r, "name"));
      const other = val(n, "defaultConnectorLabel");
      return [...outcomes, ...(other ? [other] : [])].join(" / ");
    }
    case "loops":
      return val(n, "collectionReference");
    case "subflows":
      return val(n, "flowName");
    case "screens":
      return [...descendants(n, "fields")].map((f) => val(f, "extensionName")).filter(Boolean).join(", ");
    default:
      return "";
  }
}

function typeOf(flow: XNode): string {
  const process = val(flow, "processType");
  const start = kid(flow, "start");
  const trigger = val(start, "triggerType");
  const object = val(start, "object");
  if (process === "Flow") return "Screen flow";
  if (/^Record(Before|After)(Save|Delete)$/.test(trigger)) {
    const when = { RecordBeforeSave: "before save", RecordAfterSave: "after save", RecordBeforeDelete: "before delete", RecordAfterDelete: "after delete" }[trigger];
    const on = { Create: "on create", Update: "on update", CreateAndUpdate: "on create or update", Delete: "on delete" }[val(start, "recordTriggerType")];
    return `Record-triggered flow · ${[object, [when, on].filter(Boolean).join(" ")].filter(Boolean).join(", ")}`;
  }
  if (trigger === "Scheduled") return object ? `Scheduled flow · ${object}` : "Scheduled flow";
  if (trigger === "PlatformEvent") return `Platform event flow · ${object}`;
  const names: Record<string, string> = { AutoLaunchedFlow: "Autolaunched flow", Workflow: "Process Builder", Orchestrator: "Orchestration" };
  return names[process] ?? (process || "Flow");
}

export function parseFlow(xml: string): FlowInfo {
  const flow = kid(parseXml(xml), "Flow") ?? { tag: "Flow", start: 0, end: xml.length, children: [], text: "" };
  const elements: FlowElement[] = [];
  for (const n of flow.children) {
    if (!STEPS[n.tag]) continue;
    elements.push({
      kind: n.tag,
      name: val(n, "name"),
      label: val(n, "label") || val(n, "name"),
      start: n.start,
      end: n.end,
      next: [...descendants(n, "targetReference")].map((t) => t.text.trim()),
      calls: callsOf(n.tag, n),
      detail: detailOf(n.tag, n),
    });
  }
  // Run order: follow the connectors from Start, depth first.
  const start = kid(flow, "start");
  const first = start ? [...descendants(start, "targetReference")].map((t) => t.text.trim()) : [val(flow, "startElementReference")];
  const byName = new Map(elements.map((e) => [e.name, e]));
  const ordered: FlowElement[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    const e = byName.get(name);
    if (!e || seen.has(name)) return;
    seen.add(name);
    ordered.push(e);
    e.next.forEach(visit);
  };
  first.forEach(visit);
  for (const e of elements) if (!seen.has(e.name)) ordered.push(e);
  const label = kid(flow, "label");
  return {
    apiVersion: val(flow, "apiVersion"),
    label: label?.text.trim() ?? "",
    description: val(flow, "description"),
    type: typeOf(flow),
    status: val(flow, "status"),
    labelOffset: label?.start ?? 0,
    elements: ordered,
  };
}

/**
 * The flow as text for the map: one line per step, in run order, so each
 * call can be drawn from its line. `lineOf` gives each step's line.
 */
export function flowOutline(info: FlowInfo): { lines: string[]; lineOf: Map<string, number> } {
  const lines = [`Start${info.status && info.status !== "Active" ? ` (${info.status})` : ""}`];
  const lineOf = new Map<string, number>();
  const width = Math.max(...info.elements.map((e) => STEPS[e.kind].length), 0) + 1;
  for (const e of info.elements) {
    lineOf.set(e.name, lines.length);
    lines.push(`${STEPS[e.kind].padEnd(width)}${e.label}${e.detail ? `  · ${e.detail}` : ""}`);
  }
  return { lines, lineOf };
}

/** The step a file offset falls in. */
export function elementAt(info: FlowInfo, offset: number): FlowElement | undefined {
  return info.elements.find((e) => e.start <= offset && offset < e.end);
}
