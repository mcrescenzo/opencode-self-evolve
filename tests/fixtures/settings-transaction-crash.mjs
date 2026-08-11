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
  store.updateGlobalSettings((global) => makeGlobalSettings({
    ...global,
    consent: { ...global.consent, sanitizedExcerpts: false },
    updatedAt: Math.max(2_000, global.updatedAt + 1),
  }));
} else if (scope === "global") {
  store.updateGlobalSettings((global) => makeGlobalSettings({ ...global, mode: "auto", updatedAt: 2_000 }));
} else if (scope === "repo") {
  store.updateRepoSettings((repo) => makeRepoSettings({ ...repo, mode: "auto", excluded: true }));
} else {
  store.updateSettings(({ global, repo }) => ({
    global: makeGlobalSettings({ ...global, mode: "auto", updatedAt: 2_000 }),
    repo: makeRepoSettings({ ...repo, mode: "auto", excluded: true }),
  }));
}
process.exitCode = 2;
