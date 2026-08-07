import { createIntegration } from "../../self-evolve-integration.js";
import { openStore } from "../../self-evolve-store.js";
import * as schemas from "../../self-evolve-schemas.js";
import * as commands from "../../self-evolve-commands.js";
import * as inventory from "../../self-evolve-inventory.js";

const [stateRoot, projectFingerprint, crashPoint = "after-effect"] = process.argv.slice(2);
const store = openStore(stateRoot, { projectFingerprint, projectName: "operation-effect-crash" });
const integration = createIntegration({
  store,
  inventory,
  privacy: {
    exportScope: () => store.exportProject(),
    exportAll: () => store.exportAll(),
    purgeScope: ({ scope }) => store.purge({ scope }),
    scanForForbiddenContent: () => ({ ok: true, issues: [] }),
  },
  schemas,
  observation: {},
  synthesisModule: {},
  applier: { circuitBreakerOpen: () => false, recoverPending: () => [], close: () => ({ ok: true }) },
  commands,
  pipeline: {
    createPipeline() {
      return {
        runEvolutionCycle: async () => ({ result: "no-change" }),
        recoverSynthesisAttempts: () => [],
      };
    },
  },
  scheduler: {
    createScheduler() {
      return { setMode() {}, getCircuitBreaker: () => ({ open: false }), dispose() {} };
    },
  },
  options: {
    stateRoot,
    __testAfterOperationEffect() {
      if (crashPoint === "after-effect") process.kill(process.pid, "SIGKILL");
    },
    __testAfterRequestHandled({ type }) {
      if (crashPoint === "before-response" && type === "operation") process.kill(process.pid, "SIGKILL");
    },
  },
});

const result = await integration.processMailbox();
process.stderr.write(`${JSON.stringify(result)}\n`);
process.exitCode = 2;
