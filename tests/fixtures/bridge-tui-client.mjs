import fs from "node:fs";
import {
  createDecisionRequest,
  pollDecisionResponse,
  readProjectInbox,
  submitDecisionRequest,
} from "../../self-evolve-bridge.js";

const [stateRoot, projectFingerprint, action, proposalId, replayFile, resultFile] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let request;
if (action === "replay") {
  request = JSON.parse(fs.readFileSync(replayFile, "utf8"));
  request = { ...request, requestId: `replay-${Date.now()}`, timestamp: Date.now() };
} else {
  let proposal;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    proposal = readProjectInbox(stateRoot, projectFingerprint).find((item) => item.id === proposalId);
    if (proposal?.decisionNonce) break;
    await sleep(10);
  }
  if (!proposal?.decisionNonce) throw new Error("proposal-or-server-nonce-unavailable");
  const newState = action === "apply" ? "approved" : action === "reject" ? "rejected" : action === "undo" ? "rolled-back" : action;
  request = createDecisionRequest({ projectFingerprint, proposal, newState, timestamp: Date.now() });
}

const submitted = submitDecisionRequest(stateRoot, request);
const requestMode = fs.statSync(submitted.path).mode & 0o777;
let response;
for (let attempt = 0; attempt < 300; attempt += 1) {
  response = pollDecisionResponse(stateRoot, projectFingerprint, request.requestId);
  if (response) break;
  await sleep(10);
}
if (!response) throw new Error("mailbox-response-timeout");
const responsePath = `${stateRoot}/self-evolve/bridge/${projectFingerprint}/responses/${request.requestId}.json`;
fs.writeFileSync(resultFile, JSON.stringify({ request, response, requestMode, responseMode: fs.statSync(responsePath).mode & 0o777, inbox: readProjectInbox(stateRoot, projectFingerprint).map((item) => ({ id: item.id, state: item.state })) }), { encoding: "utf8", flag: "wx" });
