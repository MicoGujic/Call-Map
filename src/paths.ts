// How files are named on the map: short paths in Salesforce projects, and
// what kind of code each file holds. Pure functions, no VS Code.

/** A package directory from sfdx-project.json, as an absolute path ending in "/". */
export interface PackageDir {
  dir: string;
  /** Its path as written in sfdx-project.json ("force-app"). */
  name: string;
  isDefault: boolean;
}

/** The package directories an sfdx-project.json declares, resolved against the folder it's in. */
export function packageDirs(projectJson: string, projectDir: string): PackageDir[] {
  let parsed: { packageDirectories?: { path?: unknown; default?: unknown }[] };
  try {
    parsed = JSON.parse(projectJson);
  } catch {
    return [];
  }
  const base = projectDir.replace(/\/+$/, "");
  return (parsed.packageDirectories ?? [])
    .filter((p) => typeof p?.path === "string" && p.path.trim())
    .map((p) => {
      const name = String(p.path).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
      return { dir: `${base}/${name}/`, name, isDefault: p.default === true };
    });
}

/**
 * A file's path as the map shows it. Inside a Salesforce package directory
 * the package and `main/default` are left out (`force-app/main/default/classes/Foo.cls`
 * → `classes/Foo.cls`); a package that isn't the default keeps its name
 * (`src-flows/classes/Bar.cls`). Anything else keeps its workspace path.
 */
export function shortPath(absolute: string, relative: string, dirs: PackageDir[]): string {
  // Folder names can differ in case from sfdx-project.json on Windows and macOS.
  const lower = absolute.toLowerCase();
  const pkg = [...dirs].sort((a, b) => b.dir.length - a.dir.length).find((d) => lower.startsWith(d.dir.toLowerCase()));
  if (!pkg) return relative;
  const rest = absolute.slice(pkg.dir.length).replace(/^main\/default\//, "");
  const only = dirs.length === 1 || pkg.isDefault;
  return only ? rest : `${pkg.name}/${rest}`;
}

export type CodeType = "apex" | "trigger" | "test" | "lwc" | "aura" | "flow" | "java" | "ts" | "js" | "other";

/** What kind of code a file holds, for the map's colors. Tests win over the language. */
export function codeType(path: string, opts: { flow?: boolean; test?: boolean } = {}): CodeType {
  if (opts.flow) return "flow";
  if (opts.test) return "test";
  const p = path.toLowerCase();
  if (p.endsWith(".trigger")) return "trigger";
  if (p.endsWith(".cls")) return "apex";
  if (p.endsWith(".flow-meta.xml")) return "flow";
  if (p.includes("/lwc/")) return "lwc";
  if (p.includes("/aura/")) return "aura";
  if (p.endsWith(".java")) return "java";
  if (/\.[cm]?tsx?$/.test(p)) return "ts";
  if (/\.[cm]?jsx?$/.test(p)) return "js";
  return "other";
}
