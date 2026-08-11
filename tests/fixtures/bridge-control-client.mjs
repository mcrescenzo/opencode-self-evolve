import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createControlRequest,
  createUiOperationRequest,
  pollControlResponse,
  pollUiOperationResponse,
  readControlState,
  readUiProjection,
  submitControlRequest,
  submitUiOperationRequest,
} from "../../self-evolve-bridge.js";
import {
  UI_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
} from "../../self-evolve-ui-protocol.js";

const [stateRoot, projectFingerprint, operation, value, requestFile, resultFile] = process.argv.slice(2);
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
let nativeOperation = false;
let nativeOperationPublished = false;
const NATIVE_PROJECTION_ATTEMPTS = 8;
const TRANSIENT_PROJECTION_ERRORS = new Set([
  "expired-projection",
  "ui-dashboard-replaced",
  "ui-projection-index-replaced",
  "ui-protocol-offer-replaced",
]);
function createProjectModeRequest(controlState) {
  const projection = readUiProjection(stateRoot, projectFingerprint, {
    clientOffer: {
      projectionVersions: [UI_PROJECTION_VERSION],
      operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
      capabilities: UI_CAPABILITIES,
    },
  });
  const grant = projection?.index?.allowedActions?.find((item) => item.action === "set-repo-mode");
  if (!grant) throw new Error("project-analysis-grant-unavailable");
  return createUiOperationRequest({
    projection: projection.index,
    grant,
    action: "set-repo-mode",
    payload: { mode: value, settingsVersion: controlState.settingsVersion },
    timestamp: Date.now(),
  });
}

async function createAndPublishProjectModeRequest(previousRequest = null) {
  let lastTransientError;
  for (let attempt = 0; attempt < NATIVE_PROJECTION_ATTEMPTS; attempt += 1) {
    try {
      const controlState = readControlState(stateRoot, projectFingerprint);
      const candidate = createProjectModeRequest(controlState);
      const freshGrant = !previousRequest
        || candidate.generation !== previousRequest.generation
        || candidate.projectionHash !== previousRequest.projectionHash
        || candidate.nonce !== previousRequest.nonce;
      if (!freshGrant) {
        await sleep(10);
        continue;
      }
      submitUiOperationRequest(stateRoot, candidate);
      return { controlState, request: candidate };
    } catch (error) {
      if (!TRANSIENT_PROJECTION_ERRORS.has(error?.message)) throw error;
      lastTransientError = error;
    }
    await sleep(10);
  }
  if (lastTransientError) throw lastTransientError;
  throw new Error("fresh-project-analysis-grant-timeout");
}
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
  } else if (operation === "repo-mode") {
    nativeOperation = true;
    const fresh = await createAndPublishProjectModeRequest();
    state = fresh.controlState;
    request = fresh.request;
    nativeOperationPublished = true;
  } else if (operation === "allowlist") {
    action = "update-allowlist";
    payload = { allowlist: value ? value.split(path.delimiter) : [], confirmation: "UPDATE ALLOWLIST" };
  } else {
    throw new Error("unknown-control-fixture-operation");
  }
  if (!nativeOperation) request = createControlRequest({ controlState: state, action, payload, timestamp: Date.now() });
}

if (operation !== "raw") {
  if (nativeOperation) {
    if (!nativeOperationPublished) submitUiOperationRequest(stateRoot, request);
  } else {
    submitControlRequest(stateRoot, request);
  }
}
let response;
async function waitForResponse() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const polled = nativeOperation
      ? pollUiOperationResponse(stateRoot, request)
      : pollControlResponse(stateRoot, projectFingerprint, request.requestId);
    if (polled) return polled;
    await sleep(10);
  }
  return null;
}
response = await waitForResponse();
for (let retry = 0; nativeOperation && ["stale-or-unavailable-projection", "replayed-operation"].includes(response?.reason) && retry < 3; retry += 1) {
  // A settings write can legitimately replace the projection between a fresh
  // client's read and the server's mailbox consume. Mirror the production
  // retry contract: obtain a new control version and projection grant, then
  // publish a distinct bounded request rather than replaying stale authority.
  const fresh = await createAndPublishProjectModeRequest(request);
  state = fresh.controlState;
  request = fresh.request;
  response = await waitForResponse();
}
if (!response) throw new Error("control-response-timeout");
const next = response.ok ? await stateAfter(state.nonce) : readControlState(stateRoot, projectFingerprint);
fs.writeFileSync(resultFile, JSON.stringify({ state, request, response, next }), { encoding: "utf8", flag: "wx" });
