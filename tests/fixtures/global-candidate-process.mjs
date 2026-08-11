import { openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, rootPolicySource, targetBindingSource, timestampText, mode = "none"] = process.argv.slice(2);
const nowMs = Number(timestampText);
const rootPolicy = JSON.parse(rootPolicySource);
const targetBinding = JSON.parse(targetBindingSource);
// `crash:<applied-change-count>` kills the process once that many candidate or
// support-set change writes have landed, leaving a partial materialization.
const crashAfter = mode.startsWith("crash:") ? Number(mode.slice("crash:".length)) : null;

const store = openStore(root, {
  projectFingerprint,
  now: () => nowMs,
  staleLockMs: 1,
  ...(crashAfter === null ? {} : {
    faultInjection(point, details) {
      if (point === "global-candidate-after-change" && details.applied >= crashAfter) process.kill(process.pid, "SIGKILL");
    },
  }),
});

const result = store.materializeGlobalCandidates({ targetBindings: [targetBinding], rootPolicy, nowMs });
store.close();
process.stdout.write(JSON.stringify({
  ok: result.ok,
  reason: result.reason ?? null,
  changed: result.changed ?? 0,
  candidateIds: (result.candidates ?? []).map((candidate) => candidate.candidateId),
  supportSetHashes: (result.supportSets ?? []).map((supportSet) => supportSet.supportSetHash),
}));
