import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { probeHostSkillContract } from "../scripts/host-skill-contract-probe.mjs";

const projectDirectory = "/srv/projects/example";
const home = "/srv/home/operator";
const config = `${home}/.config/opencode`;
const globalSkill = Object.freeze({
  name: "global-example",
  description: "Global example",
  location: `${config}/skills/global-example/SKILL.md`,
  content: "# Global example",
});
const projectSkill = Object.freeze({
  name: "project-example",
  description: "Project example",
  location: `${projectDirectory}/.opencode/skills/project-example/SKILL.md`,
  content: "# Project example",
});
const origin = "http://127.0.0.1:41983/";

async function hostFetch(url, options = {}) {
  const pathname = new URL(url).pathname;
  const directory = decodeURIComponent(String(options.headers?.["x-opencode-directory"] ?? ""));
  if (pathname === "/path") {
    return new Response(JSON.stringify({ home, state: `${home}/.local/state/opencode`, config, worktree: projectDirectory, directory: projectDirectory }), { status: 200 });
  }
  if (pathname === "/config") {
    return new Response(JSON.stringify({
      skills: {
        paths: directory === config ? ["skills"] : ["skills", ".opencode/skills"],
        urls: ["https://example.invalid/skills"],
      },
    }), { status: 200 });
  }
  if (pathname === "/skill") {
    return new Response(JSON.stringify(directory === config
      ? [{ name: "built-in", location: "<built-in>", content: "# Built in" }, globalSkill]
      : [{ name: "built-in", location: "<built-in>", content: "# Built in" }, globalSkill, projectSkill]), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}

test("stable host probe composes global path, config, and skill projections", async () => {
  const result = await probeHostSkillContract({ origin, directory: projectDirectory, fetchImpl: hostFetch });
  assert.equal(result.contract, "opencode-stable-1.18-host-skills-v1");
  assert.equal(result.globalSkillCount, 2);
  assert.equal(result.projectSkillCount, 3);
  assert.equal(result.configuredRootCount, 1);
  assert.equal(result.projectConfiguredRootCount, 2);
  assert.deepEqual(result.eligible.map((skill) => skill.name), ["global-example"]);
  assert.deepEqual(result.diagnostics, ["non-local-source"]);
});

test("stable host probe rejects redirects and unexpected authority fields", async () => {
  await assert.rejects(
    probeHostSkillContract({
      origin,
      directory: projectDirectory,
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname === "/path") {
          return new Response(JSON.stringify({ home, state: `${home}/.local/state/opencode`, config, worktree: projectDirectory, directory: projectDirectory, authority: true }), { status: 200 });
        }
        return hostFetch(url, options);
      },
    }),
    /unexpected-path-projection-field/u,
  );
});

test("installed stable plugin and SDK expose the documented host seams", async () => {
  const [pluginTypes, sdkTypes, sdkClient] = await Promise.all([
    readFile(new URL("../node_modules/@opencode-ai/plugin/dist/index.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts", import.meta.url), "utf8"),
    readFile(new URL("../node_modules/@opencode-ai/sdk/dist/gen/sdk.gen.d.ts", import.meta.url), "utf8"),
  ]);
  assert.match(pluginTypes, /export type PluginInput = \{[\s\S]*client:[\s\S]*directory: string;[\s\S]*worktree: string;[\s\S]*serverUrl: URL;/u);
  assert.match(sdkTypes, /export type Path = \{[\s\S]*state: string;[\s\S]*config: string;[\s\S]*worktree: string;[\s\S]*directory: string;/u);
  assert.match(sdkTypes, /export type ConfigGetData = \{[\s\S]*directory\?: string;[\s\S]*url: "\/config";/u);
  assert.match(sdkClient, /declare class Path[\s\S]*get</u);
  assert.match(sdkClient, /declare class Config[\s\S]*get</u);
});

test("normative contract fixes binary control and mixed-version negotiation", async () => {
  const contract = await readFile(new URL("../docs/autonomy-contract.md", import.meta.url), "utf8");
  assert.match(contract, /Automatic recommendations On\/Off/u);
  assert.match(contract, /automatic-recommendations-control-v1/u);
  assert.match(contract, /new-TUI\/old-server or old-TUI\/new-server pairing is explicitly limited and submits no write/u);
  assert.match(contract, /Old `set-mode`, `set-repo-mode`, `set-paused`[\s\S]*are never reinterpreted/u);
  assert.match(contract, /Exact v0\.4 surface disposition/u);
});

test("live smoke exercises only the current native operation mailbox", async () => {
  const smoke = await readFile(new URL("../scripts/live-command-hook-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /createUiOperationRequest/u);
  assert.match(smoke, /submitUiOperationRequest/u);
  assert.match(smoke, /pollUiOperationResponse/u);
  assert.doesNotMatch(smoke, /createControlRequest|submitControlRequest|pollControlResponse|readControlState/u);
});
