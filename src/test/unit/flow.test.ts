import * as assert from "node:assert";
import { test } from "node:test";
import { elementAt, flowOutline, parseFlow } from "../../flowparse";

// Shaped like Salesforce's dreamhouse-lwc "Create property" flow, cut down.
const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <actionCalls>
        <name>geocode_address</name>
        <label>Geocode Address</label>
        <actionName>GeocodingService</actionName>
        <actionType>apex</actionType>
        <connector>
            <targetReference>details</targetReference>
        </connector>
        <inputParameters>
            <name>city</name>
            <value>
                <elementReference
                >property_address.city</elementReference>
            </value>
        </inputParameters>
    </actionCalls>
    <description>Creates a property &amp; its picture</description>
    <label>Create Property</label>
    <processType>Flow</processType>
    <recordCreates>
        <name>create_property</name>
        <label>Create Property</label>
        <object>Property__c</object>
        <connector><targetReference>notify</targetReference></connector>
    </recordCreates>
    <screens>
        <name>details</name>
        <label>Property Details</label>
        <connector><targetReference>create_property</targetReference></connector>
        <fields>
            <name>region</name>
            <fields>
                <name>nav</name>
                <extensionName>c:navigateToRecord</extensionName>
                <fieldType>ComponentInstance</fieldType>
                <inputParameters>
                    <name>recordId</name>
                    <value><stringValue>a01</stringValue></value>
                </inputParameters>
            </fields>
            <fields>
                <name>addr</name>
                <extensionName>flowruntime:address</extensionName>
                <fieldType>ComponentInstance</fieldType>
            </fields>
        </fields>
    </screens>
    <start>
        <connector><targetReference>geocode_address</targetReference></connector>
    </start>
    <status>Active</status>
    <subflows>
        <name>notify</name>
        <label>Notify Broker</label>
        <flowName>Notify_Broker</flowName>
        <inputAssignments>
            <name>recordId</name>
            <value><elementReference>create_property</elementReference></value>
        </inputAssignments>
    </subflows>
    <subflows>
        <name>orphan</name>
        <label>Never Reached</label>
        <flowName>Other</flowName>
    </subflows>
</Flow>`;

test("parseFlow reads the steps in run order, with what each calls", () => {
  const f = parseFlow(xml);
  assert.strictEqual(f.label, "Create Property");
  assert.strictEqual(f.type, "Screen flow");
  assert.strictEqual(f.description, "Creates a property & its picture");
  assert.deepStrictEqual(f.elements.map((e) => e.name), ["geocode_address", "details", "create_property", "notify", "orphan"]);
  const calls = f.elements.flatMap((e) => e.calls.map((c) => [c.type, c.target, c.inputs.map((i) => `${i.value} → ${i.name}`).join(", ")]));
  assert.deepStrictEqual(calls, [
    ["apex", "GeocodingService", "property_address.city → city"],
    ["lwc", "navigateToRecord", "'a01' → recordId"],
    ["flow", "Notify_Broker", "create_property → recordId"],
    ["flow", "Other", ""],
  ]);
  const nav = f.elements[1].calls[0];
  assert.ok(xml.slice(nav.offset).startsWith("<fields>\n                <name>nav</name>"));
  assert.strictEqual(elementAt(f, nav.offset)?.name, "details");
});

test("flowOutline gives one line per step", () => {
  const { lines, lineOf } = flowOutline(parseFlow(xml));
  assert.strictEqual(lines[0], "Start");
  assert.strictEqual(lines[lineOf.get("geocode_address")!], "Action  Geocode Address  · Apex GeocodingService");
  assert.strictEqual(lines[lineOf.get("create_property")!], "Create  Create Property  · Property__c");
});

test("parseFlow names record-triggered flows by object and timing", () => {
  const f = parseFlow(`<Flow><processType>AutoLaunchedFlow</processType><start><object>Account</object>
    <recordTriggerType>CreateAndUpdate</recordTriggerType><triggerType>RecordAfterSave</triggerType></start></Flow>`);
  assert.strictEqual(f.type, "Record-triggered flow · Account, after save on create or update");
});
