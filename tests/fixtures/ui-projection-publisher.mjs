import { readFileSync, writeFileSync } from "node:fs";
import { publishUiProjection } from "../../self-evolve-bridge.js";

const [stateRoot, bundlePath, resultPath] = process.argv.slice(2);
if (!stateRoot || !bundlePath || !resultPath) {
  throw new Error("usage: ui-projection-publisher <state-root> <bundle-json> <result-json>");
}
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const result = publishUiProjection(stateRoot, bundle);
writeFileSync(resultPath, `${JSON.stringify({
  generation: result.index.generation,
  projectionHash: result.index.projectionHash,
})}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
