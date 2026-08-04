import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const defaultWorkflows = path.resolve(repository, "..", "opencode-workflows");

function fail(message) {
  throw new Error(message);
}

function takeOption(argv, name) {
  const output = [];
  let value;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) {
      output.push(argv[index]);
      continue;
    }
    if (value !== undefined) fail(`${name} may be supplied only once`);
    if (argv[index + 1] === undefined) fail(`${name} requires a value`);
    value = argv[index + 1];
    index += 1;
  }
  return { value, argv: output };
}

export function resolveCoexistenceInvocation(argv) {
  const runnerOption = takeOption(argv, "--runner");
  const workflowsOption = takeOption(runnerOption.argv, "--workflows");
  const selfEvolveOption = takeOption(workflowsOption.argv, "--self-evolve");
  const workflows = path.resolve(workflowsOption.value ?? defaultWorkflows);
  const selfEvolve = path.resolve(selfEvolveOption.value ?? repository);
  const runnerRoot = path.resolve(
    runnerOption.value
      ?? process.env.SELF_EVOLVE_WORKFLOWS_RUNNER
      ?? (workflows.endsWith(".tgz") ? defaultWorkflows : workflows),
  );
  const runner = path.join(runnerRoot, "scripts", "tui-coexistence-smoke.mjs");
  return {
    runner,
    args: [
      runner,
      "--self-evolve",
      selfEvolve,
      "--workflows",
      workflows,
      ...selfEvolveOption.argv,
    ],
  };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write([
      "Usage: npm run test:tui-coexistence -- [--self-evolve <checkout-or-tarball>] [--workflows <checkout-or-tarball>] [--runner <workflows-checkout>] [harness options]",
      "",
      "The OpenCode Workflows checkout owns the canonical no-witness harness.",
      "Use --runner when --workflows is a packed tarball. Common release options:",
      "  --attempts 10 --witness",
      "  --attempts 1 --symlinked-config --witness",
      "  --attempts 1 --server-stack --witness",
      "",
    ].join("\n"));
    return 0;
  }
  const invocation = resolveCoexistenceInvocation(argv);
  if (!existsSync(invocation.runner) || !statSync(invocation.runner).isFile()) {
    fail("OpenCode Workflows coexistence runner was not found; pass --runner <workflows-checkout>");
  }
  const result = spawnSync(process.execPath, invocation.args, {
    cwd: repository,
    env: process.env,
    stdio: "inherit",
    shell: false,
  });
  if (result.error) fail(`coexistence runner could not start (${result.error.code ?? "spawn-error"})`);
  if (result.signal) fail(`coexistence runner terminated by ${result.signal}`);
  if (result.status !== 0) fail(`coexistence runner exited with ${result.status}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Self-Evolve TUI coexistence smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
