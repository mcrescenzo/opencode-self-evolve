import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const scopedFiles = Object.freeze([
  "scripts/bench-store-perf.mjs",
  "scripts/live-tui-host-spike.mjs",
  "self-evolve-integration.js",
]);

// Named callback parameters may be required by an external signature even when
// the implementation does not read them. Keep exceptions exact and reviewable.
const allowedUnusedParameters = Object.freeze(new Set([]));

function maskNonCode(source) {
  let output = "";
  let state = "code";
  let returnState = "code";
  let templateExpressionDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (char === "\n") { state = "code"; output += "\n"; } else output += " ";
    } else if (state === "block-comment") {
      if (char === "*" && next === "/") { output += "  "; index += 1; state = "code"; }
      else output += char === "\n" ? "\n" : " ";
    } else if (state === "template") {
      if (char === "\\") { output += "  "; index += 1; }
      else if (char === "`") { output += " "; state = returnState; }
      else if (char === "$" && next === "{") {
        output += " {";
        index += 1;
        templateExpressionDepth = 1;
        state = "code";
      } else output += char === "\n" ? "\n" : " ";
    } else if (state !== "code") {
      if (char === "\\") { output += "  "; index += 1; }
      else if (char === state) { output += " "; state = returnState; }
      else output += char === "\n" ? "\n" : " ";
    } else if (char === "/" && next === "/") {
      output += "  "; index += 1; state = "line-comment";
    } else if (char === "/" && next === "*") {
      output += "  "; index += 1; state = "block-comment";
    } else if (char === "\"" || char === "'") {
      output += " "; returnState = "code"; state = char;
    } else if (char === "`") {
      output += " "; returnState = "code"; state = "template";
    } else if (templateExpressionDepth > 0 && char === "{") {
      templateExpressionDepth += 1; output += char;
    } else if (templateExpressionDepth > 0 && char === "}") {
      templateExpressionDepth -= 1; output += char;
      if (templateExpressionDepth === 0) state = "template";
    } else output += char;
  }
  return output;
}

function identifierCount(source, name) {
  return [...source.matchAll(new RegExp(`\\b${name}\\b`, "gu"))].length;
}

function closingBrace(source, opening) {
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

export function findUnusedBindings(source, file = "fixture.js", allowances = allowedUnusedParameters, externalCode = source) {
  const code = maskNonCode(source);
  const findings = [];
  const declarations = /^\s*(export\s+)?(?:const|let|var|(?:async\s+)?function)\s+([A-Za-z_$][\w$]*)/gmu;
  for (const match of code.matchAll(declarations)) {
    const name = match[2];
    // Declaration usage intentionally scans raw text: this narrow gate favors
    // avoiding false failures on template expressions over parsing all JS.
    const usage = match[1] ? externalCode : source;
    if (identifierCount(usage, name) === 1) findings.push(`${file}: unused declaration ${name}`);
  }
  const functions = /(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gmu;
  for (const match of code.matchAll(functions)) {
    const opening = match.index + match[0].lastIndexOf("{");
    const closing = closingBrace(code, opening);
    if (closing < 0) continue;
    const body = code.slice(opening + 1, closing);
    for (const raw of match[2].split(",")) {
      const parameter = raw.trim().replace(/^\.\.\./u, "").split("=")[0].trim();
      if (!/^[A-Za-z_$][\w$]*$/u.test(parameter) || identifierCount(body, parameter) > 0) continue;
      const key = `${file}:${match[1]}:${parameter}`;
      if (!allowances.has(key)) findings.push(`${file}: unused parameter ${match[1]}(${parameter})`);
    }
  }
  return findings;
}

export function checkScopedFiles(base = root) {
  const sourceFiles = [
    ...fs.readdirSync(base).filter((name) => name.endsWith(".js")).map((name) => path.join(base, name)),
    ...fs.readdirSync(path.join(base, "scripts")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(base, "scripts", name)),
    ...fs.readdirSync(path.join(base, "tests"), { recursive: true })
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => path.join(base, "tests", name)),
  ];
  const projectCode = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  return scopedFiles.flatMap((file) => findUnusedBindings(fs.readFileSync(path.join(base, file), "utf8"), file, allowedUnusedParameters, projectCode));
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const findings = checkScopedFiles();
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`unused-code check passed (${scopedFiles.length} scoped files)`);
  }
}
