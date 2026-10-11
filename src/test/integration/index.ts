import * as assert from "assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { CallMapApi } from "../../extension";
import type { Graph } from "../../graph";

const ws = () => vscode.workspace.workspaceFolders![0].uri;
const file = (rel: string) => vscode.Uri.joinPath(ws(), rel);

async function api(): Promise<CallMapApi> {
  const ext = vscode.extensions.all.find((e) => e.packageJSON.name === "salesforce-call-map")!;
  return (await ext.activate()) as CallMapApi;
}

async function posOf(uri: vscode.Uri, needle: string): Promise<vscode.Position> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `fixture is missing ${needle}`);
  return doc.positionAt(i);
}

/** The TypeScript server needs a moment to load the project. */
async function graphWithCalls(a: CallMapApi, uri: vscode.Uri, pos: vscode.Position, forceUsages = false): Promise<Graph> {
  let g: Graph | undefined;
  for (let i = 0; i < 40; i++) {
    g = (await a.graphAt(uri, pos, { forceUsages })) as Graph | undefined;
    if (g && g.center.calls.length >= 4 && g.callers.length >= 2) return g;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail("no graph with calls and callers: " + JSON.stringify(g, null, 1));
}

function checkPlaceOrder(g: Graph) {
  assert.equal(g.center.name, "placeOrder");
  assert.deepEqual(g.center.params, ["cart", "buyer"]);
  assert.match(g.center.doc, /^Validates the cart, charges the buyer/);
  assert.ok(g.center.code[0].includes("placeOrder(cart: Cart"), g.center.code[0]);

  const calls = g.center.calls.map((c) => [c.node.name, c.args.join(", "), c.node.params.join(", ")]);
  assert.deepEqual(calls, [
    ["validateCart", "cart", "c"],
    ["totalFor", "cart", "cart"],
    ["charge", "buyer.card, total", "cardToken, amount"],
    ["saveOrder", "cart, buyer, total", "cart, buyer, total"],
  ]);
  const charge = g.center.calls[2];
  assert.equal(charge.node.doc, "Charges the card. Returns the charge id.");
  assert.equal(charge.node.file, "src/payments.ts");
  assert.ok(g.center.code[charge.line].includes("Payments.charge"), "call line points at the call");
  assert.equal(g.center.calls[3].node.doc, "Stores the order and returns it with an id.");

  const callers = g.callers.map((c) => [c.node.name, c.args.join(", ")]).sort();
  assert.deepEqual(callers, [
    ["retryFailed", "f.cart, f.buyer"],
    ["submit", "req.cart, req.buyer"],
  ]);
  assert.equal(g.callers.find((c) => c.node.name === "submit")!.node.doc, "Called when the buyer clicks Pay.");
}

const tests: [string, () => Promise<void>][] = [
  [
    "call hierarchy: TypeScript graph for placeOrder",
    async () => {
      const a = await api();
      const uri = file("src/orderService.ts");
      const g = await graphWithCalls(a, uri, await posOf(uri, "Pricing.totalFor"));
      assert.equal(g.source, "hierarchy");
      checkPlaceOrder(g);
      fs.writeFileSync(path.join(__dirname, "../../../out/sample-graph.json"), JSON.stringify(g, null, 1));
    },
  ],
  [
    "usages fallback (the Apex path) builds the same graph",
    async () => {
      const a = await api();
      const uri = file("src/orderService.ts");
      const g = await graphWithCalls(a, uri, await posOf(uri, "Pricing.totalFor"), true);
      assert.equal(g.source, "usages");
      checkPlaceOrder(g);
    },
  ],
  [
    "Apex file without a language server: method, params and ApexDoc from the text",
    async () => {
      const a = await api();
      const uri = file("classes/OrderService.cls");
      const g = (await a.graphAt(uri, await posOf(uri, "Pricing.totalFor"))) as Graph | undefined;
      assert.ok(g, "no graph");
      assert.equal(g.center.name, "placeOrder");
      assert.equal(g.center.container, "OrderService");
      assert.deepEqual(g.center.params, ["cart", "buyer"]);
      assert.equal(g.center.doc, "Validates the cart, charges the buyer and reserves stock.\n@param cart  the cart to buy");
      assert.ok(g.center.code[0].includes("@AuraEnabled"), g.center.code[0]);
    },
  ],
  [
    "zoom out command opens the Call Map panel",
    async () => {
      const uri = file("src/orderService.ts");
      const editor = await vscode.window.showTextDocument(uri);
      const p = await posOf(uri, "Pricing.totalFor");
      editor.selection = new vscode.Selection(p, p);
      await vscode.commands.executeCommand("callMap.zoomOut");
      for (let i = 0; i < 20; i++) {
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (tab?.input instanceof vscode.TabInputWebview && tab.label.startsWith("Call Map")) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.fail("Call Map panel did not open");
    },
  ],
];

export async function run(): Promise<void> {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${name}\n${e instanceof Error ? e.stack : e}`);
    }
  }
  if (failed) throw new Error(`${failed} integration test(s) failed`);
}
