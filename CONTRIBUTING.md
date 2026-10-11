# Contributing

## Build and run

```sh
git clone https://github.com/MicoGujic/Call-Map.git
cd Call-Map
npm ci
npm run compile
```

- Press **F5** in VS Code to start an Extension Development Host on `test-fixtures/shop` with Call Map loaded.
- `npm run watch` recompiles as you edit.
- `npm run package` builds `salesforce-call-map-<version>.vsix` in the project folder.

## Tests

- `npm run test:unit` runs the parser tests.
- `npm run test:integration` downloads a copy of VS Code, opens it on `test-fixtures/shop` and checks the TypeScript map, the Apex name-matching path and the command. On Linux without a display, run it under `xvfb-run`.

Every push and pull request runs the **Build** workflow: compile, unit tests and packaging, with the `.vsix` attached to the run.

## Where things are

| Path | What it does |
| --- | --- |
| `src/extension.ts` | Commands, the map window and its messages |
| `src/graph.ts` | Builds the method and class maps |
| `src/sources.ts` | Finds callers and calls: call hierarchy, or references and definitions, or name matching |
| `src/index.ts` | The background index of Apex, Java, Lightning and flow files |
| `src/bridge.ts` | LWC/Aura to Apex, and LWC templates to JavaScript |
| `src/links.ts` | Flows (Apex actions, subflows, screen components, flows started from code) and LWC parents and children (child tags, events, `@api` calls) |
| `src/flowparse.ts` | Reads flow metadata: steps, run order, what each step calls |
| `src/paths.ts` | Short paths in Salesforce projects (from `sfdx-project.json`), and the kind of code in each file for the map's colors |
| `src/parse.ts` | Text parsing: declarations, calls, arguments, tests, LWC templates and events |
| `src/highlight.ts` | Colors code with the user's theme |
| `src/hover.ts` | Hover links in the editor |
| `media/graph.js`, `media/graph.css` | The map window |

## Release a version

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag and push, for example `git tag v0.6.5 && git push origin main v0.6.5`.
3. The Build workflow checks that the tag matches `package.json` and publishes a GitHub release with the `.vsix` attached.
4. Upload the same `.vsix` to the Marketplace from the publisher page.
