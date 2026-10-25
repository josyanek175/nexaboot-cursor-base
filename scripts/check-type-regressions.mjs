import ts from "typescript";
import { execFileSync } from "node:child_process";
import { resolve, relative } from "node:path";
const base = process.argv[2];
if (!base) throw Error("Pass a base Git ref, e.g. node scripts/check-type-regressions.mjs 0e4a125");
const cwd = process.cwd(),
  rel = (file) => relative(cwd, resolve(file)).replaceAll("\\", "/");
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
const tracked = new Set(
  execFileSync("git", ["ls-tree", "-r", "--name-only", base], { encoding: "utf8" })
    .trim()
    .split("\n"),
);
const changed = execFileSync("git", ["diff", "--name-only", base], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter((p) => tracked.has(p) && /\.tsx?$/.test(p));
const originals = new Map(
  changed.map((p) => [p, execFileSync("git", ["show", `${base}:${p}`], { encoding: "utf8" })]),
);
function diagnostics(baseline) {
  const host = ts.createCompilerHost(parsed.options),
    read = host.readFile.bind(host);
  if (baseline) {
    host.readFile = (file) => (originals.has(rel(file)) ? originals.get(rel(file)) : read(file));
    host.getSourceFile = (file, language, onError) => {
      const content = host.readFile(file);
      if (content === undefined) {
        onError?.("File not found: " + file);
        return undefined;
      }
      return ts.createSourceFile(file, content, language);
    };
  }
  const roots = baseline ? parsed.fileNames.filter((p) => tracked.has(rel(p))) : parsed.fileNames;
  const program = ts.createProgram(roots, parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ({
      file: d.file ? rel(d.file.fileName) : "",
      line:
        d.file && d.start !== undefined
          ? d.file.getLineAndCharacterOfPosition(d.start).line + 1
          : 0,
      code: d.code,
      span:
        d.file && d.start !== undefined
          ? d.file.text.slice(d.start, d.start + (d.length ?? 0))
          : "",
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    }));
}
const before = diagnostics(true),
  after = diagnostics(false),
  counts = new Map();
// Union member order in diagnostic prose changes with module traversal order.
// Compare error locations by source span/code, independent of moved line numbers.
const key = (d) => `${d.file}:${d.code}:${d.span.replace(/\r\n/g, "\n")}`;
for (const d of before) counts.set(key(d), (counts.get(key(d)) ?? 0) + 1);
const added = after.filter((d) => {
  const n = counts.get(key(d)) ?? 0;
  if (n) {
    counts.set(key(d), n - 1);
    return false;
  }
  return true;
});
console.log(
  JSON.stringify({
    base,
    baselineErrors: before.length,
    currentErrors: after.length,
    newErrors: added.length,
  }),
);
for (const d of added) console.log(`${d.file}:${d.line} TS${d.code} ${d.message}`);
if (added.length) process.exitCode = 1;
