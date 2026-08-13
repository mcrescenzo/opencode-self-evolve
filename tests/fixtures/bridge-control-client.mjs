import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createUiOperationRequest,
  pollUiOperationResponse,
  readUiProjection,
  submitUiOperationRequest,
} from "../../self-evolve-bridge.js";
import {
  UI_CAPABILITIES,
  UI_OPERATION_PROTOCOL_VERSION,
  UI_PROJECTION_VERSION,
  hashUiProtocol,
} from "../../self-evolve-ui-protocol.js";

const [stateRoot, projectFingerprint, operation, value, requestFile, resultFile] = process.argv.slice(2);
const offer = {
  projectionVersions: [UI_PROJECTION_VERSION],
  operationProtocolVersions: [UI_OPERATION_PROTOCOL_VERSION],
  capabilities: UI_CAPABILITIES,
};

async function projection() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      const current = readUiProjection(stateRoot, projectFingerprint, { clientOffer: offer });
      if (current?.index && current?.dashboard) return current;
    } catch {}
    await sleep(10);
  }
  throw new Error("ui-projection-unavailable");
}

function grantFor(current, action) {
  if (action === "replace-global-root-policy") return current.dashboard.settings.globalRootPolicyAction;
  return current.index.allowedActions.find((item) => item.action === action) ?? null;
}

function requestFor(current) {
  const settingsVersion = current.dashboard.settings.globalSettingsVersion;
  let action;
  let payload;
  if (operation === "automatic") {
    action = "set-automatic-recommendations";
    payload = { enabled: value === "true", settingsVersion };
  } else if (operation === "permission") {
    action = "set-permission";
    const [permission, enabled] = value.split("=");
    payload = { permission, enabled: enabled === "true", settingsVersion };
  } else if (operation === "exclude") {
    action = "set-repo-excluded";
    payload = { excluded: value === "true", settingsVersion };
  } else if (operation === "allowlist") {
    action = "replace-global-root-policy";
    payload = {
      roots: [{ canonicalPath: value, canUpdate: true, canCreate: false }],
      creationRootPath: null,
      confirmation: current.dashboard.settings.globalRootPolicyConfirmation,
      settingsVersion,
    };
  } else {
    throw new Error("unknown-operation-fixture-operation");
  }
  const grant = grantFor(current, action);
  if (!grant) throw new Error(`operation-grant-unavailable:${action}`);
  return createUiOperationRequest({
    projection: current.index,
    grant,
    action,
    payload,
    timestamp: Date.now(),
  });
}

let state = await projection();
let request;
if (operation === "replay") {
  const prior = JSON.parse(fs.readFileSync(requestFile, "utf8"));
  const { operationHash: _priorHash, ...body } = prior;
  body.requestId = `stale-${Date.now()}`;
  body.issuedAt = Date.now();
  body.expiresAt = Math.min(body.issuedAt + 30_000, prior.expiresAt);
  request = { ...body, operationHash: hashUiProtocol("operation-request", body) };
  const directory = path.join(stateRoot, "self-evolve", "bridge", projectFingerprint, "operation-requests");
  fs.writeFileSync(path.join(directory, `${request.requestId}.json`), `${JSON.stringify(request)}\n`, { mode: 0o600, flag: "wx" });
} else {
  request = requestFor(state);
  submitUiOperationRequest(stateRoot, request);
}

async function responseFor(candidate) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = pollUiOperationResponse(stateRoot, candidate);
    if (response) return response;
    await sleep(10);
  }
  return null;
}
let response = await responseFor(request);
for (let retry = 0;
  operation !== "replay" && response?.reason === "stale-or-unavailable-projection" && retry < 3;
  retry += 1) {
  state = await projection();
  request = requestFor(state);
  submitUiOperationRequest(stateRoot, request);
  response = await responseFor(request);
}
if (!response) throw new Error("operation-response-timeout");

let next = state;
for (let attempt = 0; response.ok && attempt < 300; attempt += 1) {
  next = await projection();
  if (next.dashboard.dashboardHash !== state.dashboard.dashboardHash) break;
  await sleep(10);
}
fs.writeFileSync(resultFile, JSON.stringify({ state, request, response, next }), { encoding: "utf8", flag: "wx" });
