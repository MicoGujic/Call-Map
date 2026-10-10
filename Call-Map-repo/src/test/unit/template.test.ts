import * as assert from "node:assert";
import { test } from "node:test";
import { templateHandlers } from "../../parse";

test("templateHandlers finds elements with event handlers", () => {
  const html = `<template>
  <!-- <lightning-button onclick={ignored}></lightning-button> -->
  <lightning-button label="Save" onclick={handleSave}
     onfocus={ handleFocus }></lightning-button>
  <div class="x">{title}</div>
  <c-child onrefresh={refreshData} data-x="a>b"></c-child>
</template>`;
  const els = templateHandlers(html);
  assert.deepStrictEqual(els.map((e) => [e.tag, e.handlers.map((h) => h.event + ":" + h.method)]), [
    ["lightning-button", ["click:handleSave", "focus:handleFocus"]],
    ["c-child", ["refresh:refreshData"]],
  ]);
  const h = els[0].handlers[1];
  assert.strictEqual(html.slice(h.offset, h.offset + h.method.length), "handleFocus");
});
