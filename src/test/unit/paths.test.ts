import * as assert from "node:assert";
import { test } from "node:test";
import { codeType, packageDirs, shortPath } from "../../paths";

test("shortPath drops the package and main/default in Salesforce projects", () => {
  const dirs = packageDirs(JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }] }), "/ws/app");
  assert.strictEqual(shortPath("/ws/app/force-app/main/default/classes/Foo.cls", "app/force-app/main/default/classes/Foo.cls", dirs), "classes/Foo.cls");
  assert.strictEqual(shortPath("/ws/app/force-app/lwc/x/x.js", "app/force-app/lwc/x/x.js", dirs), "lwc/x/x.js");
  // Outside the package directories, and in projects without sfdx-project.json: the full path.
  assert.strictEqual(shortPath("/ws/app/scripts/run.js", "app/scripts/run.js", dirs), "app/scripts/run.js");
  assert.strictEqual(shortPath("/ws/test-fixtures/shop/src/orderService.ts", "test-fixtures/shop/src/orderService.ts", []), "test-fixtures/shop/src/orderService.ts");
});

test("shortPath keeps the name of a package that isn't the default", () => {
  const dirs = packageDirs(JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }, { path: "./src-flows/" }] }), "/ws");
  assert.strictEqual(shortPath("/ws/src-flows/main/default/classes/Bar.cls", "src-flows/main/default/classes/Bar.cls", dirs), "src-flows/classes/Bar.cls");
  assert.strictEqual(shortPath("/ws/force-app/main/default/flows/A.flow-meta.xml", "force-app/main/default/flows/A.flow-meta.xml", dirs), "flows/A.flow-meta.xml");
  assert.deepStrictEqual(packageDirs("not json", "/ws"), []);
});

test("codeType names the kind of code", () => {
  assert.strictEqual(codeType("/a/classes/Foo.cls"), "apex");
  assert.strictEqual(codeType("/a/classes/Foo.cls", { test: true }), "test");
  assert.strictEqual(codeType("/a/triggers/T.trigger"), "trigger");
  assert.strictEqual(codeType("/a/lwc/x/x.html"), "lwc");
  assert.strictEqual(codeType("/a/aura/c/cController.js"), "aura");
  assert.strictEqual(codeType("/a/flows/F.flow-meta.xml"), "flow");
  assert.strictEqual(codeType("/a/src/orderService.ts"), "ts");
});
