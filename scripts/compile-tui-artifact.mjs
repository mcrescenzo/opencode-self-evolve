import path from "node:path";

import solidPlugin from "@opentui/solid/bun-plugin";

const EXTERNAL_IMPORTS = [
  "@opentui/solid",
  "solid-js",
  "timers/promises",
  "./self-evolve-tui.js",
  "./self-evolve-tui-store.js",
];

function fail(message, detail = "") {
  throw new Error(detail ? `${message}\n${detail}` : message);
}

const [entryArgument, outputArgument] = process.argv.slice(2);
if (!entryArgument || !outputArgument) fail("usage: bun compile-tui-artifact.mjs <entry> <output>");

const entry = path.resolve(entryArgument);
const output = path.resolve(outputArgument);
const result = await Bun.build({
  entrypoints: [entry],
  target: "bun",
  format: "esm",
  splitting: false,
  minify: false,
  sourcemap: "none",
  write: false,
  external: EXTERNAL_IMPORTS,
  plugins: [solidPlugin],
});

if (!result.success) {
  fail("OpenTUI Solid compilation failed", result.logs.map((entry) => String(entry)).join("\n"));
}
if (result.outputs.length !== 1) {
  fail(`OpenTUI Solid compilation produced ${result.outputs.length} outputs; expected exactly one`);
}

await Bun.write(output, result.outputs[0]);
