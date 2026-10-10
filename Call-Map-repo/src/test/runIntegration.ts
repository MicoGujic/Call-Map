import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main() {
  const root = path.resolve(__dirname, "../..");
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, "integration/index"),
    launchArgs: [path.join(root, "test-fixtures/shop"), "--disable-workspace-trust"],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
