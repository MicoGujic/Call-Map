# Changelog

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
