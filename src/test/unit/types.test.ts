import * as assert from "node:assert";
import { test } from "node:test";
import { declaredTypeOf, escapeRegExp, isTestDecl, supertypesIn } from "../../parse";

test("declaredTypeOf finds local, cast and parameter types", () => {
  const src = `void run(Timeline_Configuration__c conf, String recordId) {
    AbstractTimelineDataProvider provider = (AbstractTimelineDataProvider)x.newInstance();
    List<Account> accs = new List<Account>();
    return provider;
    provider.getData(recordId);
  }`;
  const at = src.indexOf("provider.getData");
  assert.strictEqual(declaredTypeOf(src, at, "provider"), "AbstractTimelineDataProvider");
  assert.strictEqual(declaredTypeOf(src, at, "conf"), "Timeline_Configuration__c");
  assert.strictEqual(declaredTypeOf(src, at, "accs"), "List");
  assert.strictEqual(declaredTypeOf(src, at, "nothing"), undefined);
});

test("supertypesIn reads extends and implements", () => {
  const src = "global with sharing class Sample extends Base implements ITimeline, Database.Batchable<SObject> {";
  assert.deepStrictEqual(supertypesIn(src, "Sample"), ["Base", "ITimeline", "Batchable"]);
  assert.deepStrictEqual(supertypesIn("class A {", "A"), []);
});

test("supertypesIn skips nested generics", () => {
  const src = "class Job implements Database.Batchable<Map<Id, List<Account>>>, Schedulable {";
  assert.deepStrictEqual(supertypesIn(src, "Job"), ["Batchable", "Schedulable"]);
});

test("escapeRegExp makes any name safe to search for", () => {
  const name = "Outer.Inner$1(int) [a-z]+ \\d";
  assert.strictEqual(new RegExp(escapeRegExp(name)).exec("x " + name + " y")?.[0], name);
  assert.strictEqual(new RegExp(escapeRegExp("a.b")).test("axb"), false);
});

test("isTestDecl sees annotations and testMethod", () => {
  const lines = ["}", "    @isTest(SeeAllData=true) static void  testProvider() {", "  void plain() {", "  @IsTest", "  static void t2() {", "  static testMethod void t3() {"];
  assert.strictEqual(isTestDecl(lines, 1), true);
  assert.strictEqual(isTestDecl(lines, 2), false);
  assert.strictEqual(isTestDecl(lines, 4), true);
  assert.strictEqual(isTestDecl(lines, 5), true);
});
