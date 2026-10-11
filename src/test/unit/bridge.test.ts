import * as assert from "node:assert";
import { test } from "node:test";
import { apexCallArgs, apexCallSites, apexImports } from "../../parse";

const js = `import getData from '@salesforce/apex/RecordTimelineDataProvider.getTimelineItemData';
import save from "@salesforce/apex/ns__TaskUtils.saveTask";
export default class X extends LightningElement {
  @wire(getData, { confIdOrName: '$configId', recordId: '$recordId' }) items;
  load() { getData({ confIdOrName: this.configId, recordId, dateFilter: String(this.f) }).then(r => r); }
}`;

test("apexImports reads @salesforce/apex imports", () => {
  const m = apexImports(js);
  assert.deepStrictEqual(m.get("getData"), { cls: "RecordTimelineDataProvider", method: "getTimelineItemData" });
  assert.deepStrictEqual(m.get("save"), { cls: "TaskUtils", method: "saveTask" });
});

test("apexCallSites finds calls and wires, not the import", () => {
  const sites = apexCallSites(js, "getData");
  assert.deepStrictEqual(sites.map((s) => s.wire), [true, false]);
});

test("apexCallArgs lines object keys up with Apex parameters", () => {
  const at = js.indexOf("getData({") + "getData".length;
  assert.deepStrictEqual(apexCallArgs(js, at, ["confIdOrName", "recordId", "dateFilter", "other"]), [
    "this.configId", "recordId", "String(this.f)", "—",
  ]);
  assert.deepStrictEqual(apexCallArgs("f(a, b)", 1, ["x"]), ["a", "b"]);
});
