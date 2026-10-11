import * as assert from "node:assert";
import { test } from "node:test";
import { apexFlowStarts, attrProp, bundleTag, childCalls, firedEvents, maskStringsAndComments, tagBundle, templateElements } from "../../parse";

test("tags and bundles convert both ways", () => {
  assert.strictEqual(tagBundle("c-contact-list-item"), "contactListItem");
  assert.strictEqual(bundleTag("contactListItem"), "c-contact-list-item");
  assert.strictEqual(tagBundle("lightning-button"), undefined);
  assert.strictEqual(attrProp("record-id"), "recordId");
});

test("templateElements finds child components with the properties they get", () => {
  const html = `<template>
  <lightning-layout-item oncontactselect={handleContactSelect}>
    <c-contact-list-item class="x" key={c.Id} contact={contact} record-id="001" lwc:ref="item" onselect={handleSelect}></c-contact-list-item>
  </lightning-layout-item>
  <lightning-flow flow-api-name="Create_property"></lightning-flow>
  <div>{title}</div>
</template>`;
  const els = templateElements(html);
  assert.deepStrictEqual(els.map((e) => e.tag), ["lightning-layout-item", "c-contact-list-item", "lightning-flow"]);
  assert.deepStrictEqual(els[1].attrs.map((a) => `${a.name}=${a.value}`), ["contact=contact", "record-id='001'", "lwc:ref='item'"]);
  assert.deepStrictEqual(els[1].handlers.map((h) => h.event + ":" + h.method), ["select:handleSelect"]);
});

test("firedEvents reads the event name, detail and bubbling", () => {
  const js = `handleClick() {
    // this.dispatchEvent(new CustomEvent('ignored'));
    const evt = new CustomEvent('select', { detail: this.contact.Id });
    this.dispatchEvent(evt);
    this.dispatchEvent(new CustomEvent("contactselect", { bubbles: true }));
    this.dispatchEvent(new CustomEvent('next'));
  }`;
  const evs = firedEvents(js, maskStringsAndComments(js));
  assert.deepStrictEqual(evs.map((e) => [e.name, e.detail, e.bubbles]), [
    ["select", "this.contact.Id", false],
    ["contactselect", "", true],
    ["next", "", false],
  ]);
  assert.strictEqual(js.slice(evs[0].offset, evs[0].offset + 6), "select");
});

test("childCalls finds a parent calling its children's @api methods", () => {
  const js = `export default class P extends LightningElement {
  handleRefresh() {
    this.template.querySelector('c-clock').refresh();
    // this.template.querySelector('c-clock').ignored();
    const list = this.template.querySelector("c-contact-list[data-id='x']");
    list.reload(1);
    this.refs.picker.open();
  }
  other() { list.notThis(); }
}`;
  const calls = childCalls(maskStringsAndComments(js), js, new Map([["picker", "datePicker"]]));
  assert.deepStrictEqual(calls.map((c) => `${c.bundle}.${c.method}`), ["clock.refresh", "contactList.reload", "datePicker.open"]);
});

test("apexFlowStarts finds flows started from Apex", () => {
  const apex = `void run(Map<String, Object> inputs) {
    Flow.Interview.createInterview('Create_property', inputs).start();
    Flow.Interview.Notify_Broker f = new Flow.Interview.Notify_Broker(inputs);
    // new Flow.Interview.Commented(inputs);
  }`;
  assert.deepStrictEqual(apexFlowStarts(apex, maskStringsAndComments(apex)).map((s) => s.flow), ["Create_property", "Notify_Broker"]);
});
