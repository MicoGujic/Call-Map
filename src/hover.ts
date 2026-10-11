import * as vscode from "vscode";
import { GraphBuilder, GraphNode } from "./graph";

const MAX_LINKS = 8;
const COMMANDS = ["callMap.goto", "callMap.openAt"];

function cmd(name: string, args: unknown[]): string {
  return `command:${name}?${encodeURIComponent(JSON.stringify(args))}`;
}

function nodeLink(builder: GraphBuilder, n: GraphNode, label = n.name): string {
  const item = builder.item(n.id);
  if (!item) return `\`${label}\``;
  const s = item.selectionRange.start;
  const title = `${n.container ? n.container + "." : ""}${n.name} · ${n.file}:${n.line}`;
  return `[${label}](${cmd("callMap.goto", [item.uri.toString(), s.line, s.character])} "${title.replace(/"/g, "'")}")`;
}

function list(links: string[]): string {
  if (!links.length) return "_none found_";
  const shown = links.slice(0, MAX_LINKS).join(" · ");
  return links.length > MAX_LINKS ? `${shown} · _+${links.length - MAX_LINKS} more_` : shown;
}

/**
 * Adds "Called from" and "Calls" to the normal hover on a method name (its
 * declaration or a call to it), and "Used by" and "Uses" on a class name.
 * Every name is a link; Go Back returns to where you were.
 */
export function registerHover(builder: GraphBuilder): vscode.Disposable {
  return vscode.languages.registerHoverProvider([{ scheme: "file" }, { scheme: "untitled" }], {
    async provideHover(doc, pos, token) {
      if (!vscode.workspace.getConfiguration("callMap").get<boolean>("hover.enabled", true)) return undefined;
      const word = doc.getWordRangeAtPosition(pos, /[A-Za-z_$][\w$]*/);
      if (!word) return undefined;
      const name = doc.getText(word);
      const after = doc.getText(new vscode.Range(word.end, word.end.translate(0, 120))).replace(/^\s*(<[^<>;(){}]*>)?\s*/, "");
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: COMMANDS };
      md.supportThemeIcons = true;

      const before = doc.getText(new vscode.Range(word.start.with(undefined, 0), word.start));
      const isConstructor = /\bnew\s+$/.test(before);
      if (after.startsWith("(") && !isConstructor) {
        // A method: its declaration, or a call to it.
        const id = (await builder.prepareCallTarget(doc.uri, word.start)) ?? undefined;
        let methodId = id;
        if (!methodId) {
          const here = await builder.prepare(doc.uri, word.start);
          const item = here ? builder.item(here) : undefined;
          if (item && item.selectionRange.contains(word.start)) methodId = here;
        }
        if (!methodId || token.isCancellationRequested) return undefined;
        const g = await builder.build(methodId);
        if (g.kind !== "method" || token.isCancellationRequested) return undefined;
        const c = g.center;
        const item = builder.item(methodId)!;
        md.appendMarkdown(`$(type-hierarchy) **Call Map** · \`${c.container ? c.container + "." : ""}${c.name}\`\n\n`);
        md.appendMarkdown(`$(arrow-left) **Called from:** ${list(g.callers.map((x) => nodeLink(builder, x.node, x.node.container && x.node.container !== c.container ? `${x.node.container}.${x.node.name}` : x.node.name)))}\n\n`);
        md.appendMarkdown(`$(arrow-right) **Calls:** ${list(c.calls.map((x) => nodeLink(builder, x.node, x.node.container && x.node.container !== c.container ? `${x.node.container}.${x.node.name}` : x.node.name)))}\n\n`);
        const s = item.selectionRange.start;
        md.appendMarkdown(`[Open map](${cmd("callMap.openAt", [item.uri.toString(), s.line, s.character])}) · Ctrl+Alt+H to jump`);
        return new vscode.Hover(md, word);
      }

      // A class: declaration or a reference. Classes are capitalized by convention.
      if (!/^[A-Z]/.test(name)) return undefined;
      const classId = await builder.prepareClassAt(doc.uri, word.start);
      if (!classId || token.isCancellationRequested) return undefined;
      const g = await builder.build(classId);
      if (g.kind !== "class" || token.isCancellationRequested) return undefined;
      const usedBy = new Map<string, string>();
      for (const c of g.callers) {
        const key = c.node.container || c.node.file;
        if (!usedBy.has(key)) usedBy.set(key, nodeLink(builder, c.node, c.node.container || c.node.file.split("/").pop()!));
      }
      const uses = new Map<string, string>();
      for (const c of g.calls) {
        const key = c.node.container || c.node.file;
        if (!uses.has(key)) uses.set(key, nodeLink(builder, c.node, c.node.container || c.node.file.split("/").pop()!));
      }
      const loc = builder.classLocation(classId)!;
      md.appendMarkdown(`$(type-hierarchy) **Call Map** · class \`${g.name}\` · ${g.methods.length} methods\n\n`);
      md.appendMarkdown(`$(arrow-left) **Used by:** ${list([...usedBy.values()])}\n\n`);
      md.appendMarkdown(`$(arrow-right) **Uses:** ${list([...uses.values()])}\n\n`);
      md.appendMarkdown(`[Open class map](${cmd("callMap.openAt", [loc.uri.toString(), word.start.line, word.start.character, "class"])})`);
      return new vscode.Hover(md, word);
    },
  });
}
