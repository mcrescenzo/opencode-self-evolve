import { createScheduler } from "../../self-evolve-scheduler.js";
import { openStore } from "../../self-evolve-store.js";
import { writeFileSync } from "node:fs";

const [root, projectFingerprint, clockText, label, resultPath] = process.argv.slice(2);
const clock = Number(clockText);
const store = openStore(root, { projectName: "passive-process", projectFingerprint, now: () => clock });
const scheduler = createScheduler({ store, budgets: { passiveCallsPerHour: 6 }, now: () => clock, enqueueWork() {} });
const result = scheduler.reservePassiveProviderCalls(2, { rootSessionID: label });
scheduler.dispose();
store.close();
writeFileSync(resultPath, JSON.stringify(result), { encoding: "utf8", flag: "wx" });
