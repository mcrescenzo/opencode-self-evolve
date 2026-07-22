import { createScheduler } from "../../self-evolve-scheduler.js";
import { openStore } from "../../self-evolve-store.js";

const [root, projectFingerprint, clockText, label] = process.argv.slice(2);
const clock = Number(clockText);
const store = openStore(root, { projectName: "passive-process", projectFingerprint, now: () => clock });
const scheduler = createScheduler({ store, budgets: { passiveCallsPerHour: 6 }, now: () => clock, enqueueWork() {} });
const result = scheduler.reservePassiveProviderCalls(2, { rootSessionID: label });
scheduler.dispose();
store.close();
process.stdout.write(JSON.stringify(result));
