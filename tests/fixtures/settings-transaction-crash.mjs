import { openStore } from "../../self-evolve-store.js";
import { makeGlobalSettings, makeRepoSettings } from "../../self-evolve-schemas.js";

const [root, projectFingerprint, point, scope] = process.argv.slice(2);
const store = openStore(root, {
  projectFingerprint,
  now: () => 2_000,
  staleLockMs: 1,
  faultInjection(current) {
    if (current === point) process.kill(process.pid, "SIGKILL");
  },
});

if (scope === "revoke-excerpts") {
  const current = store.getAutomationState();
  store.transitionAutomation({
    transitionId: `crash-revoke-excerpts-${point}`,
    expectedGeneration: current.epoch.generation,
    action: "set-permission",
    permission: "sanitizedExcerpts",
    enabled: false,
  });
} else if (scope === "global") {
  store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, retentionDays: 31, updatedAt: 2_000 }));
} else if (scope === "repo") {
  store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, excluded: true }));
} else {
  store.updateSettings(({ global, repo }) => ({
    global: makeGlobalSettings({ ...global, retentionDays: 31, updatedAt: 2_000 }),
    repo: makeRepoSettings({ ...repo, excluded: true }),
  }));
}
process.exitCode = 2;
