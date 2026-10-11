# Changelog

## 0.7.1

- **Shorter paths.** In a Salesforce project, paths start inside the package folder: `classes/OrderService.cls` instead of `force-app/main/default/classes/OrderService.cls`. When `sfdx-project.json` lists several package folders, files outside the default one keep their folder's name in front. Other projects show the path from the workspace folder, as before.
- **Colors by kind of code.** Every box has a tag for what it is (Apex, Test, Trigger, LWC, Aura or Flow, and TS, JS or Java in grey), and the method or component name takes that kind's color. The colors come from your theme.
- Long paths wrap after a slash instead of in the middle of a file name, and the line number stays next to the file.

## 0.7.0

- **Flows.** An Apex `@InvocableMethod` lists the flows that run it, with the inputs each one passes. A flow gets its own map: its steps in run order, the Apex actions, subflows and LWC screen components it uses, and the flows, Apex, Aura and `<lightning-flow>` tags that start it. Open it with Ctrl+Alt+G in a `.flow-meta.xml` file, or **Open with Call Map** in the Explorer.
- **LWC parents and children.** A child's tag in a parent's template links to the child with the properties it sets. A child method that fires a `CustomEvent` links to the parent methods that handle it, including bubbling events. A parent calling a child's `@api` method through `querySelector` or `lwc:ref` links the two methods.
- In an LWC component outside any method, the map opens on the component: who uses it, and where its events go. Z still zooms out to the class.

## 0.6.5

- Classes that extend or implement a type with nested generics, such as `Database.Batchable<Map<Id, List<Account>>>`, now link to that type.
- A class name with brackets or other special characters, as some language servers report them, no longer stops the map from opening.
- The map window escapes every value it shows, including line numbers and counts, and only accepts hex colors from the theme. This clears GitHub's CodeQL code-scanning alerts.

## 0.6.4

- Starts on its own only in Salesforce projects (a folder with `sfdx-project.json`). Elsewhere it starts the first time you use one of its commands, instead of in every VS Code window.
- Hover links show names and file names as plain text, so an unusual file name can't change the link.
- Declares that it stays off in untrusted folders (Restricted Mode), which was already VS Code's default for it.
- New README with a Privacy and security section, plus SECURITY.md and CONTRIBUTING.md.
- The GitHub build runs read-only, with actions pinned to exact versions. Only the release step on version tags can write.

## 0.6.3

- Open the method you're on from the keyboard: press Enter twice on the middle box (the first Enter asks, the second opens it in the editor), the same as a double-click. Esc still does it in one key.

## 0.6.2

- Published by MicoGujic under the MIT license. The extension ID is now `MicoGujic.salesforce-call-map` (the name `call-map` is taken on the Marketplace); uninstall the earlier `call-map.call-map` builds.

## 0.6.1

- Long methods and classes: picking a call scrolls the code to its line (class view: to the linked method rows), and the side columns stay in view beside the code.
- The method's code is shown up to 400 lines (was 80).
- Long paths at the top wrap instead of running into the buttons.

## 0.6.0

- Faster on big workspaces: a background index of calls, method declarations and class hierarchies replaces re-reading every file per lookup, and stays current file by file (typing, save, create, delete). On 3,000 Apex classes: method map 24.5 s → 3.4 s first time and 15.1 s → 0.3 s after an edit; class map 7.8 s → 1.1 s and 7.8 s → 0.2 s.
- An edit no longer throws away everything Call Map has read, only the maps already drawn.
- LWC templates: `on…={handler}` attributes link template elements to the JS methods they call.
- Starts with VS Code (so hovers work right away and the index is ready).

## 0.5.0

- Frontend ↔ Apex: LWC `@salesforce/apex` imports (calls and `@wire`) and Aura `c.method` calls link to the Apex methods they reach, with arguments matched to Apex parameters.
- JavaScript callbacks (`.then(() => …)`) count as part of the method around them.

## 0.4.1

- Ctrl+Alt+G outside a method, or with focus outside the editor, opens the class of the file on screen instead of failing.
- Explorer: right-click a single file and pick *Open with Call Map* to open its class view.

## 0.4.0

- Class view: the picked method shows what it's called from and what it calls, inside and outside the class, with arcs between methods of the class.
- Hide tests: T (or the button) leaves out @isTest / @Test / testMethod methods. Setting `callMap.hideTests`.
- Apex and Java name matching follows variables to their declared type and its supertypes, so `provider.getData()` with `AbstractTimelineDataProvider provider` links to the providers that override it.
- Removed the side-by-side mode from 0.3.0.

## 0.2.0

- Class view: Z zooms out from a method to its whole class and back.
- Code in the map uses your color theme and the editor's grammars.
- Hover on a method or class name shows callers and calls as links.
- Ctrl+Alt+H: quick list to jump to a caller or a call.

## 0.1.1

- Apex and Java: when no language server answers, calls and callers are matched by class and method name, so the map works without the Salesforce extension.

## 0.1.0

- First version: graph mode with callers, calls, argument labels, doc comments and arrow-key travel.
- Apex support through references and definitions.
