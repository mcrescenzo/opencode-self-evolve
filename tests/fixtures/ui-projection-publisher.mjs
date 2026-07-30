import { readFileSync } from "node:fs";
import { publishUiProjection } from "../../self-evolve-bridge.js";

const [stateRoot, bundlePath] = process.argv.slice(2);
if (!stateRoot || !bundlePath) throw new Error("usage: ui-projection-publisher <state-root> <bundle-json>");
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const result = publishUiProjection(stateRoot, bundle);
process.stdout.write(`${JSON.stringify({
  generation: result.index.generation,
  projectionHash: result.index.projectionHash,
})}\n`);
