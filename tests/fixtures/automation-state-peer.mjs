import { writeFileSync } from "node:fs";
import { openStore } from "../../self-evolve-store.js";

const [rootDir, projectFingerprint, operation, resultPath, argument] = process.argv.slice(2);

function finish(value) {
  writeFileSync(resultPath, JSON.stringify(value), "utf8");
}

try {
  const store = openStore(rootDir, {
    projectFingerprint,
    staleLockMs: 1,
    lockTimeoutMs: 10_000,
    faultInjection: argument
      ? (point) => { if (point === argument) process.exit(91); }
      : undefined,
  });
  const current = store.getAutomationState();
  if (operation === "off") {
    finish(store.transitionAutomation({
      transitionId: `peer-off-${process.pid}`,
      expectedGeneration: 1,
      action: "set-automatic-recommendations",
      enabled: false,
    }));
  } else if (operation === "read") {
    finish(current);
  } else {
    finish({ ok: false, reason: "unknown-operation" });
  }
  store.close();
} catch (error) {
  finish({ ok: false, reason: error instanceof Error ? error.message : String(error) });
}
