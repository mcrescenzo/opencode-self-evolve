import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "self-evolve-pack-"));

const requiredFiles = [
  "package.json",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "self-evolve.js",
  "self-evolve-core.js",
  "analyzer-prompt.js",
];

const forbiddenFiles = [
  ".beads/issues.jsonl",
  ".claude/settings.json",
  "AGENTS.md",
  "CLAUDE.md",
  // Dev-only test and script files must never ship in the published tarball.
  "tests/self-evolve-core.test.mjs",
  "tests/self-evolve-plugin.test.mjs",
  "scripts/live-command-hook-smoke.mjs",
  "scripts/pack-artifact-check.mjs",
];

function fail(message, detail = "") {
  const suffix = detail ? `\n${detail}` : "";
  throw new Error(`${message}${suffix}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed`,
      [result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }
  return result;
}

function runNpmPack(args) {
  const result = spawnSync("npm", ["pack", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: path.join(tempRoot, "npm-cache"),
    },
  });
  if (result.status !== 0) {
    fail(`npm pack ${args.join(" ")} failed`, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result;
}

try {
  const packageJSON = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const tarballName = `${packageJSON.name.replace(/^@/, "").replace("/", "-")}-${packageJSON.version}.tgz`;
  runNpmPack(["--ignore-scripts", "--pack-destination", tempRoot]);

  const tarball = path.join(tempRoot, tarballName);
  if (!existsSync(tarball)) {
    fail(`Expected npm pack output was not created: ${tarball}`);
  }

  const list = run("tar", ["-tzf", tarball], { cwd: tempRoot });
  const files = new Set(
    list.stdout
      .split("\n")
      .map((file) => file.trim())
      .filter(Boolean)
      .map((file) => file.replace(/^package\//, ""))
      .filter(Boolean),
  );

  const missing = requiredFiles.filter((file) => !files.has(file));
  if (missing.length > 0) {
    fail(`Package artifact is missing required files: ${missing.join(", ")}`);
  }

  const forbidden = forbiddenFiles.filter((file) => files.has(file));
  if (forbidden.length > 0) {
    fail(`Package artifact includes files that must stay repo-only: ${forbidden.join(", ")}`);
  }

  const extractDir = path.join(tempRoot, "extract");
  mkdirSync(extractDir);
  run("tar", ["-xzf", tarball, "-C", extractDir], { cwd: tempRoot });

  const entrypoint = path.join(extractDir, "package", "self-evolve.js");
  const module = await import(pathToFileURL(entrypoint).href);
  if (typeof module.default !== "function") {
    fail("Packed artifact entrypoint does not default-export the plugin function");
  }

  console.log(`Pack artifact check passed: ${files.size} files verified.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
