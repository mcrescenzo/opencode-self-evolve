import fs from "node:fs";
import path from "node:path";
import {
  createControlRequest,
  pollControlResponse,
  readControlState,
  submitControlRequest,
} from "../../self-evolve-bridge.js";

const [stateRoot, projectFingerprint, operation, value, requestFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stateAfter(nonce) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const state = readControlState(stateRoot, projectFingerprint);
      if (state?.nonce !== nonce) return state;
    } catch {}
    await sleep(10);
  }
  return null;
}

let state;
for (let attempt = 0; attempt < 300; attempt += 1) {
  try { state = readControlState(stateRoot, projectFingerprint); } catch {}
  if (state) break;
  await sleep(10);
}
if (!state) throw new Error("control-state-unavailable");

let request;
if (operation === "replay") {
  request = { ...JSON.parse(fs.readFileSync(requestFile, "utf8")), requestId: `replay-${Date.now()}`, timestamp: Date.now() };
} else if (operation === "raw") {
  request = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const directory = path.join(stateRoot, "self-evolve", "bridge", projectFingerprint, "control-requests");
  fs.writeFileSync(path.join(directory, `${request.requestId}.json`), `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" });
} else {
  let action;
  let payload;
  if (operation === "mode") {
    action = "set-mode";
    payload = value === "yolo"
      ? { mode: "yolo", allowlist: [requestFile], confirmation: "ENABLE YOLO" }
      : { mode: value };
  } else if (operation === "consent") {
    action = "set-consent";
    const [key, enabled] = value.split("=");
    payload = { key, enabled: enabled === "true" };
  } else if (operation === "exclude") {
    action = "set-repo-excluded";
    payload = { excluded: value === "true" };
  } else if (operation === "allowlist") {
    action = "update-allowlist";
    payload = { allowlist: value ? value.split(path.delimiter) : [], confirmation: "UPDATE ALLOWLIST" };
  } else {
    throw new Error("unknown-control-fixture-operation");
  }
  request = createControlRequest({ controlState: state, action, payload, timestamp: Date.now() });
}

if (operation !== "raw") submitControlRequest(stateRoot, request);
let response;
for (let attempt = 0; attempt < 300; attempt += 1) {
  response = pollControlResponse(stateRoot, projectFingerprint, request.requestId);
  if (response) break;
  await sleep(10);
}
if (!response) throw new Error("control-response-timeout");
const next = response.ok ? await stateAfter(state.nonce) : readControlState(stateRoot, projectFingerprint);
process.stdout.write(`${JSON.stringify({ state, request, response, next })}\n`);
