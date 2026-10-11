import { test } from "node:test";
import * as assert from "node:assert/strict";
import { findCallCandidates, findDoc, findMethodDecls, paramName, readArgs, readParams } from "../../parse";

const at = (text: string, needle: string) => text.indexOf(needle) + needle.length;

test("readArgs splits top-level arguments", () => {
  const t = `payments.charge(user.card, total(a, b), { x: [1, 2] }, "a,b");`;
  assert.deepEqual(readArgs(t, at(t, "charge")), ["user.card", "total(a, b)", "{ x: [1, 2] }", '"a,b"']);
});

test("readArgs handles generics, newlines and empty calls", () => {
  const t = "repo.find<Order>(\n  id,\n  // comment, here\n  opts\n);\nfoo();";
  assert.deepEqual(readArgs(t, at(t, "find")), ["id", "opts"]);
  assert.deepEqual(readArgs(t, at(t, "foo")), []);
});

test("paramName covers TS, Java and Apex", () => {
  assert.equal(paramName("cart: Cart"), "cart");
  assert.equal(paramName("user?: User = defaultUser"), "user");
  assert.equal(paramName("private readonly repo: Repo"), "repo");
  assert.equal(paramName("...rest: string[]"), "rest");
  assert.equal(paramName("Map<String, List<Id>> idsByName"), "idsByName");
  assert.equal(paramName("final @NonNull String name"), "name");
  assert.equal(paramName("String... args"), "args");
  assert.equal(paramName("int[] values"), "values");
  assert.equal(paramName("{ a, b }: Opts"), "{…}");
  assert.equal(paramName("x"), "x");
});

test("readParams on an Apex declaration", () => {
  const t = "public static Order__c placeOrder(\n    Cart cart, Contact buyer) {";
  assert.deepEqual(readParams(t, at(t, "placeOrder")), ["cart", "buyer"]);
});

test("findDoc reads ApexDoc above annotations", () => {
  const lines = ["/**", " * Called by the page.", " * @param req the request", " */", "@AuraEnabled", "public static Id submit(Req req) {"];
  assert.deepEqual(findDoc(lines, 5, 5), { text: "Called by the page.\n@param req the request", bodyStart: 5 });
});

test("findDoc reads a JSDoc inside the declaration range", () => {
  const lines = ["  /** Saves it. */", "  save(x: X) {", "  }"];
  assert.deepEqual(findDoc(lines, 0, 1), { text: "Saves it.", bodyStart: 1 });
});

test("findDoc reads // comments and returns empty when there are none", () => {
  assert.equal(findDoc(["// one", "// two", "void f() {"], 2, 2).text, "one\ntwo");
  assert.equal(findDoc(["int x;", "void f() {"], 1, 1).text, "");
});

test("findCallCandidates skips keywords, constructors, strings and comments", () => {
  const t = `{ if (a(x)) { new Foo(1); b.c(2); } // d(3)\n "e(4)"; return f(5); }`;
  assert.deepEqual(findCallCandidates(t).map((c) => c.name), ["a", "c", "f"]);
});

test("findMethodDecls outlines an Apex class", () => {
  const src = [
    "public with sharing class OrderService {",
    "  /** Places it. */",
    "  @AuraEnabled",
    "  public static Order__c placeOrder(Cart cart, Contact buyer) {",
    "    validateCart(cart);",
    "    if (cart.items.isEmpty()) { throw new OrderException('x'); }",
    "    return OrderRepo.save(cart, buyer);",
    "  }",
    "  private static void validateCart(Cart c) {",
    "    for (CartItem i : c.items) { Inventory.isInStock(i.sku); }",
    "  }",
    "  public OrderService() { }",
    "}",
  ].join("\n");
  const decls = findMethodDecls(src);
  assert.deepEqual(decls.map((d) => [d.name, d.container]), [
    ["placeOrder", "OrderService"],
    ["validateCart", "OrderService"],
    ["OrderService", "OrderService"],
  ]);
  const p = decls[0];
  assert.ok(src.slice(p.start, p.end).startsWith("@AuraEnabled"));
  assert.ok(src.slice(p.start, p.end).trimEnd().endsWith("}"));
});
