import * as vscode from "vscode";
import { AnyGraph, classDeclLine, GraphBuilder } from "./graph";
import { Highlighter } from "./highlight";
import { registerHover } from "./hover";
import { WorkspaceIndex } from "./index";

type FromWebview =
  | { type: "ready" }
  | { type: "show"; id: string; dir?: "l" | "r" | "out" | "in" }
  | { type: "close"; id: string }
  | { type: "hideTests"; value: boolean };

class CallMapPanel {
  static current: CallMapPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private pending: unknown[] = [];
  /** The method or class on screen. */
  currentId: string | undefined;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly builder: GraphBuilder,
    public returnColumn: vscode.ViewColumn
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "callMap",
      "Call Map",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => {
      CallMapPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  static show(
    extensionUri: vscode.Uri,
    builder: GraphBuilder,
    startId: string,
    column: vscode.ViewColumn
  ): CallMapPanel {
    if (!CallMapPanel.current) {
      CallMapPanel.current = new CallMapPanel(extensionUri, builder, column);
    } else {
      CallMapPanel.current.returnColumn = column;
      CallMapPanel.current.panel.reveal(vscode.ViewColumn.Active);
    }
    const p = CallMapPanel.current;
    p.post({ type: "options", hideTests: vscode.workspace.getConfiguration("callMap").get<boolean>("hideTests", false) });
    p.post({ type: "start", id: startId });
    void p.load(startId);
    return p;
  }

  /** Theme or code changed: redraw what is on screen. */
  refresh(): void {
    this.post({ type: "refresh" });
  }

  private post(msg: unknown): void {
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  private async load(id: string, dir?: string): Promise<void> {
    this.currentId = id;
    this.post({ type: "loading", id });
    try {
      const graph: AnyGraph = await this.builder.build(id);
      this.panel.title = `Call Map: ${graph.kind === "class" ? graph.name : graph.center.name}`;
      this.post({ type: "graph", id, graph, dir });
    } catch (e) {
      this.post({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "ready":
        this.ready = true;
        for (const msg of this.pending.splice(0)) void this.panel.webview.postMessage(msg);
        break;
      case "show":
        await this.load(m.id, m.dir);
        break;
      case "close": {
        this.panel.dispose();
        await reveal(this.builder, m.id, this.returnColumn);
        break;
      }
      case "hideTests":
        await vscode.workspace.getConfiguration("callMap").update("hideTests", m.value, vscode.ConfigurationTarget.Global);
        break;
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${w.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("graph.css")}">
<title>Call Map</title>
</head>
<body tabindex="0">
<header class="bar">
  <nav class="crumbs" id="crumbs" aria-label="Path you followed"></nav>
  <span class="status" id="status"></span>
  <button class="zoom" id="zoom" type="button"></button>
  <button class="zoom" id="tests" type="button" aria-pressed="false">Hide tests (T)</button>
  <span class="keys"><kbd>←</kbd><kbd>→</kbd> move <kbd>↑</kbd><kbd>↓</kbd> pick <kbd>Z</kbd> zoom <kbd>T</kbd> tests <kbd>⌫</kbd> back <kbd>Enter</kbd><kbd>Enter</kbd> or <kbd>Esc</kbd> to code</span>
</header>
<main id="main"><div class="gwrap" id="gwrap"></div></main>
<script nonce="${nonce}" src="${media("graph.js")}"></script>
</body>
</html>`;
  }
}

/** Open the editor at a method or class from the map. */
async function reveal(builder: GraphBuilder, id: string, column?: vscode.ViewColumn): Promise<void> {
  const item = builder.item(id);
  if (item) {
    await vscode.window.showTextDocument(item.uri, {
      viewColumn: column,
      selection: new vscode.Range(item.selectionRange.start, item.selectionRange.start),
    });
    return;
  }
  const cls = builder.classLocation(id);
  if (cls) {
    const doc = await vscode.workspace.openTextDocument(cls.uri);
    const line = Math.max(0, classDeclLine(doc.getText(), cls.container));
    const pos = new vscode.Position(line, 0);
    await vscode.window.showTextDocument(cls.uri, { viewColumn: column, selection: new vscode.Range(pos, pos) });
  }
}

export interface CallMapApi {
  /** Build the graph for the method at a position. Used by tests. */
  graphAt(uri: vscode.Uri, pos: vscode.Position, opts?: { forceUsages?: boolean }): Promise<AnyGraph | undefined>;
}

export function activate(context: vscode.ExtensionContext): CallMapApi {
  const highlighter = new Highlighter(context.extensionPath);
  const index = new WorkspaceIndex();
  const builder = new GraphBuilder(index, false, highlighter);
  // Build the index in the background so the first map is quick.
  setTimeout(() => void index.ensure(), 1500);

  const openMap = async (uri: vscode.Uri, pos: vscode.Position, column?: vscode.ViewColumn, kind?: "class" | "file") => {
    builder.clear();
    // Not in a method (or a whole file was asked for): show the class instead.
    const id = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Call Map" }, async () =>
      kind === "file"
        ? builder.prepareFileClass(uri)
        : (kind === "class" ? undefined : await builder.prepare(uri, pos)) ??
          (await builder.prepareClassAt(uri, pos)) ??
          (await builder.prepareFileClass(uri, pos))
    );
    CallMapPanel.show(context.extensionUri, builder, id, column ?? vscode.ViewColumn.One);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("callMap.zoomOut", async () => {
      // Focus may be outside the editor (Explorer, a panel): use the file on screen.
      const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
      if (!editor) {
        void vscode.window.showInformationMessage("Open a file first, then zoom out.");
        return;
      }
      await openMap(editor.document.uri, editor.selection.active, editor.viewColumn);
    }),
    vscode.commands.registerCommand("callMap.openFile", async (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
      if (selected && selected.length > 1) {
        void vscode.window.showInformationMessage("Call Map opens one file at a time. Select a single file.");
        return;
      }
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) return;
      await openMap(target, new vscode.Position(0, 0), vscode.window.activeTextEditor?.viewColumn, "file");
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === "json" || doc.languageId === "jsonc") return; // settings, not code
      builder.clear();
      CallMapPanel.current?.refresh();
    }),
    vscode.commands.registerCommand("callMap.openAt", async (uri: string, line: number, character: number, kind?: "class" | "file") => {
      await openMap(vscode.Uri.parse(uri), new vscode.Position(line, character), vscode.window.activeTextEditor?.viewColumn, kind);
    }),
    vscode.commands.registerCommand("callMap.goto", async (uri: string, line: number, character: number) => {
      const pos = new vscode.Position(line, character);
      await vscode.window.showTextDocument(vscode.Uri.parse(uri), { selection: new vscode.Range(pos, pos) });
    }),
    vscode.commands.registerCommand("callMap.jump", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      await jumpPick(builder, editor);
    }),
    vscode.workspace.onDidChangeTextDocument(() => builder.clear()),
    vscode.window.onDidChangeActiveColorTheme(() => {
      highlighter.reset();
      builder.clear();
      CallMapPanel.current?.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("editor.tokenColorCustomizations") || e.affectsConfiguration("workbench.colorTheme")) {
        highlighter.reset();
        builder.clear();
        CallMapPanel.current?.refresh();
      }
    }),
    registerHover(builder),
    index,
    // A file changed outside the editor (git checkout, a pull): built graphs may be stale.
    index.onDidChange(() => builder.clear())
  );

  return {
    async graphAt(uri, pos, opts) {
      const b = new GraphBuilder(index, opts?.forceUsages, highlighter);
      const id = await b.prepare(uri, pos);
      return id ? b.build(id) : undefined;
    },
  };
}

/** Quick pick of callers and calls for the method at the cursor. */
async function jumpPick(builder: GraphBuilder, editor: vscode.TextEditor): Promise<void> {
  builder.clear();
  const pos = editor.selection.active;
  const id =
    (await builder.prepareCallTarget(editor.document.uri, pos)) ?? (await builder.prepare(editor.document.uri, pos));
  if (!id) {
    void vscode.window.showInformationMessage("Call Map: put the cursor in a method or on a call.");
    return;
  }
  const g = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Call Map" }, () =>
    builder.build(id)
  );
  if (g.kind !== "method") return;
  type Pick = vscode.QuickPickItem & { id?: string };
  const label = (n: { container: string; name: string }) => (n.container ? `${n.container}.${n.name}` : n.name);
  const items: Pick[] = [
    { label: "Called from", kind: vscode.QuickPickItemKind.Separator },
    ...g.callers.map((c) => ({ label: `$(arrow-left) ${label(c.node)}`, description: c.args.join(", "), detail: `${c.node.file}:${c.node.line}`, id: c.node.id })),
    { label: "Calls", kind: vscode.QuickPickItemKind.Separator },
    ...g.center.calls.map((c) => ({ label: `$(arrow-right) ${label(c.node)}`, description: c.args.join(", "), detail: `${c.node.file}:${c.node.line}`, id: c.node.id })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `${label(g.center)}: jump to a caller or a call`,
    matchOnDescription: true,
    placeHolder: g.callers.length + g.center.calls.length ? "Type to filter" : "No callers or calls found",
  });
  if (pick?.id) await reveal(builder, pick.id);
}

export function deactivate(): void {}
