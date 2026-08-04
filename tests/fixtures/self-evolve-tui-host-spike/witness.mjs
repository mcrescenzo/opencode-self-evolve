import { createMockKeys, createMockMouse } from "@opentui/core/testing";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const PLUGIN_ID = "mcrescenzo.self-evolve-host-spike";
const WITNESS_ID = "mcrescenzo.self-evolve-host-spike-witness";
const COMMAND_ID = "self-evolve.control-center";
const ROUTE_ID = "self-evolve.control-center.route";
const CARD_ID = "self-evolve-spike-card";
const DIALOG_ID = "self-evolve-spike-dialog";
const ROUTE_VIEW_ID = "self-evolve-spike-route";
const DELAYED_ID = "self-evolve-spike-delayed";
const REQUIRED_VERSION = "1.18.3";
const RECEIPT_SCHEMA_VERSION = 1;
const WAIT_MS = 30_000;
const decoder = new TextDecoder();

function spikeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredAbsoluteEnv(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw spikeError("invalid-environment", `${name} must be absolute`);
  return path.resolve(value);
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true, () => false);
}

async function eventually(operation, description, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(25);
  }
  throw spikeError("spike-timeout", `${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

async function readBoundedJson(filePath, maximum = 16 * 1024) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > maximum) throw spikeError("invalid-private-file", "private file size is invalid");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function spikeEvents(eventsPath) {
  const handle = await fs.open(eventsPath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw spikeError("event-bound", "product event log exceeded its bound");
    return (await handle.readFile("utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

async function productEvents(eventsPath) {
  return (await spikeEvents(eventsPath)).filter((event) => event?.source === "product");
}

async function providerPromptHookCalls(eventsPath) {
  return (await spikeEvents(eventsPath)).filter(
    (event) => event?.source === "server-witness" && event.type === "provider-prompt-hook",
  ).length;
}

function frameText(api) {
  return decoder.decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
}

function node(api, id) {
  return api.renderer.root.findDescendantById(id);
}

function countNodesById(renderable, id) {
  let count = renderable?.id === id ? 1 : 0;
  const children = renderable?.getChildren?.();
  if (!Array.isArray(children)) return count;
  for (const child of children) count += countNodesById(child, id);
  return count;
}

function center(renderable) {
  return {
    x: Math.max(0, Math.floor(renderable.screenX + renderable.width / 2)),
    y: Math.max(0, Math.floor(renderable.screenY + renderable.height / 2)),
  };
}

function framePoint(api, needle) {
  const rows = frameText(api).split("\n");
  const y = rows.findIndex((row) => row.includes(needle));
  if (y < 0) return null;
  const start = rows[y].indexOf(needle);
  return { x: start + Math.floor(needle.length / 2), y };
}

function pluginStatus(api) {
  return api.plugins.list().filter((entry) => entry.id === PLUGIN_ID);
}

function commandEntries(api) {
  return api.keymap.getCommandEntries({ namespace: "palette", visibility: "registered" })
    .filter((entry) => entry.command?.name === COMMAND_ID);
}

function unwrap(value) {
  return value?.data ?? value;
}

async function createSession(api, directory) {
  const response = await api.client.session.create({ directory, title: "Self-evolve exact-host spike" });
  if (response?.error) throw spikeError("session-create", "fixture session creation failed");
  const session = unwrap(response);
  if (!session || typeof session.id !== "string" || !session.id) throw spikeError("session-create", "fixture session has no identity");
  return session.id;
}

async function selectSession(api, directory, sessionID) {
  const response = await api.client.tui.selectSession({ directory, sessionID });
  if (response?.error) throw spikeError("session-select", "fixture session selection failed");
  await eventually(
    () => api.route.current.name === "session" && api.route.current.params?.sessionID === sessionID,
    "session route",
  );
}

async function deleteSession(api, directory, sessionID) {
  const response = await api.client.session.delete({ directory, sessionID });
  if (response?.error && response.response?.status !== 404) throw spikeError("session-delete", "fixture session deletion failed");
  const get = await api.client.session.get({ directory, sessionID });
  const listed = unwrap(await api.client.session.list({ directory }));
  return get?.error && get.response?.status === 404
    && Array.isArray(listed) && !listed.some((session) => session?.id === sessionID);
}

async function proveCardInputs(api, mouse, keys) {
  const card = await eventually(() => node(api, CARD_ID), "visible sidebar card");
  const point = center(card);
  await mouse.click(point.x, point.y);
  await eventually(() => api.ui.dialog.open && node(api, DIALOG_ID), "click-opened product dialog");
  api.ui.dialog.clear();
  await eventually(() => !api.ui.dialog.open, "cleared product dialog");
  const focusedCard = await eventually(() => node(api, CARD_ID), "card after dialog clear");
  focusedCard.focus();
  keys.pressEnter();
  await eventually(() => api.ui.dialog.open && node(api, DIALOG_ID), "enter-opened product dialog");
  api.ui.dialog.clear();
  return true;
}

async function provePaletteRoute(api, keys) {
  const entries = commandEntries(api);
  if (entries.length !== 1) throw spikeError("palette-metadata", "control-center command was not registered exactly once");
  const command = entries[0].command;
  if (command.namespace !== "palette" || command.slashName !== undefined || command.slashAliases !== undefined) {
    throw spikeError("palette-metadata", "control-center command is not palette-only");
  }
  const prior = JSON.parse(JSON.stringify(api.route.current));
  const priorMode = api.mode.current();
  const opened = await Promise.resolve(api.keymap.dispatchCommand("command.palette.show"));
  if (opened === false) throw spikeError("palette-open", "host command palette did not open");
  await eventually(() => api.ui.dialog.open, "real command palette mount");
  await keys.typeText("Self-evolve control center", 1);
  await eventually(() => frameText(api).includes("Self-evolve control center"), "filtered product palette visibility");
  keys.pressEnter();
  await eventually(() => api.route.current.name === ROUTE_ID && node(api, ROUTE_VIEW_ID), "palette-opened namespaced route");
  const routeNode = node(api, ROUTE_VIEW_ID);
  routeNode.focus();
  keys.pressEnter();
  await eventually(
    () => api.route.current.name === prior.name
      && JSON.stringify(api.route.current.params) === JSON.stringify(prior.params),
    "exact prior-route restoration",
  );
  return priorMode;
}

async function proveDelayedLease(api, eventsPath) {
  const dispatched = await Promise.resolve(api.keymap.dispatchCommand("self-evolve.host-spike.delayed"));
  if (dispatched === false) throw spikeError("delayed-open", "delayed component command was not handled");
  await eventually(() => node(api, DELAYED_ID), "delayed component mount");
  api.ui.dialog.replace(() => api.ui.DialogAlert({ title: "Witness sentinel", message: "Sentinel survives late callback" }));
  await wait(450);
  const events = await productEvents(eventsPath);
  if (!events.some((event) => event.type === "delayed-noop")
    || events.some((event) => event.type === "delayed-overwrite")
    || !frameText(api).includes("Sentinel survives late callback")) {
    throw spikeError("delayed-lease", "late delayed callback overwrote the witness sentinel");
  }
  api.ui.dialog.clear();
  return true;
}

async function runStageOne(api, state) {
  const { directory, fixtureState, eventsPath, handoffPath, workspaceDir } = state;
  const keys = createMockKeys(api.renderer);
  const mouse = createMockMouse(api.renderer);
  await eventually(() => pluginStatus(api).length === 1 && pluginStatus(api)[0].active, "packed product activation");
  const initialEvents = await eventually(async () => {
    const events = await productEvents(eventsPath);
    return events.some((event) => event.type === "activated" && event.targetIsBuilt === true
      && event.productVersion === state.productVersion && event.hostVersion === REQUIRED_VERSION) ? events : false;
  }, "packed target identity");
  if (initialEvents.filter((event) => event.type === "activated").length !== 1) {
    throw spikeError("product-activation", "packed target did not activate exactly once at startup");
  }

  const sessionID = await createSession(api, directory);
  state.sessionIDs.push(sessionID);
  await selectSession(api, directory, sessionID);
  await wait(150);
  if (node(api, CARD_ID)) throw spikeError("card-condition", "sidebar card was present before fixture eligibility");
  await writeJsonAtomic(fixtureState, { cardVisible: true });
  await eventually(() => node(api, CARD_ID), "eligible sidebar card");
  await proveCardInputs(api, mouse, keys);
  const priorMode = await provePaletteRoute(api, keys);
  await eventually(async () => {
    const events = await productEvents(eventsPath);
    const mounted = events.findLast((event) => event.type === "route-mounted");
    const cleaned = events.findLast((event) => event.type === "route-cleaned");
    return mounted?.mode === "self-evolve-control-center"
      && cleaned?.priorRestored === true && cleaned?.mode === priorMode;
  }, "route cleanup and mode pop");
  await proveDelayedLease(api, eventsPath);

  const activationCountBeforeWarp = (await productEvents(eventsPath)).filter((event) => event.type === "activated").length;
  const workspaceCommand = await Promise.resolve(api.keymap.dispatchCommand("workspace.set"));
  if (workspaceCommand === false) throw spikeError("workspace-command", "workspace.set was not handled");
  await eventually(
    () => api.ui.dialog.open && frameText(api).includes("Warp")
      && frameText(api).includes("Self-evolve scratch folder"),
    "workspace adapter dialog",
  );
  const adapterPoint = await eventually(
    () => framePoint(api, "Self-evolve scratch folder"),
    "workspace adapter frame coordinates",
  );
  await mouse.click(adapterPoint.x, adapterPoint.y);
  let confirmation;
  try {
    confirmation = await eventually(() => {
      if (path.resolve(api.state.path.directory) === workspaceDir) return "warped";
      if (api.ui.dialog.open && frameText(api).includes("File Changes Found")) return "confirm";
      return false;
    }, "workspace warp or file-change confirmation");
  } catch {
    const listed = unwrap(await api.client.experimental.workspace.list({ directory }).catch(() => undefined));
    throw spikeError(
      "workspace-warp",
      `workspace warp stalled (created=${await exists(path.join(workspaceDir, ".self-evolve-host-spike-created"))}`
        + ` listed=${Array.isArray(listed) ? listed.length : -1}`
        + ` dialog=${api.ui.dialog.open} filePrompt=${frameText(api).includes("File Changes Found")})`,
    );
  }
  if (confirmation === "confirm") keys.pressEnter();
  await eventually(() => path.resolve(api.state.path.directory) === workspaceDir, "workspace path update");
  await eventually(async () => {
    const events = await productEvents(eventsPath);
    return events.some((event) => event.type === "path-rebound" && event.changed === true) ? true : false;
  }, "product path rebind");
  const activationCountAfterWarp = (await productEvents(eventsPath)).filter((event) => event.type === "activated").length;
  if (activationCountAfterWarp !== activationCountBeforeWarp) {
    throw spikeError("workspace-reinstantiate", "workspace warp re-instantiated the TUI plugin");
  }

  const cleanupStarted = Date.now();
  if (await api.plugins.deactivate(PLUGIN_ID) !== true) throw spikeError("plugin-deactivate", "product plugin did not deactivate");
  const cleanupElapsedMs = Date.now() - cleanupStarted;
  if (cleanupElapsedMs > 5000) throw spikeError("plugin-cleanup-timeout", "product cleanup exceeded 5000ms");
  await eventually(() => pluginStatus(api).length === 1 && pluginStatus(api)[0].active === false, "product deactivation");
  if (commandEntries(api).length !== 0 || node(api, CARD_ID)) {
    throw spikeError("registration-cleanup", "product registrations survived deactivation");
  }
  api.route.navigate(ROUTE_ID);
  await wait(100);
  if (node(api, ROUTE_VIEW_ID)) throw spikeError("route-cleanup", "product route renderer survived deactivation");
  api.route.navigate("session", { sessionID });
  await eventually(() => api.route.current.name === "session", "session route after deactivation probe");
  if (await api.plugins.activate(PLUGIN_ID) !== true) throw spikeError("plugin-reactivate", "product plugin did not reactivate");
  await eventually(() => pluginStatus(api).length === 1 && pluginStatus(api)[0].active === true, "product reactivation");
  await eventually(
    () => commandEntries(api).length === 1 && countNodesById(api.renderer.root, CARD_ID) === 1,
    "single reactivated command and slot set",
  );
  await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
  await eventually(
    () => api.route.current.name === ROUTE_ID && countNodesById(api.renderer.root, ROUTE_VIEW_ID) === 1,
    "single reactivated route",
  );
  api.route.navigate("session", { sessionID });
  await eventually(() => api.route.current.name === "session", "session route after reactivation probe");
  const finalEvents = await productEvents(eventsPath);
  const productActivations = finalEvents.filter((event) => event.type === "activated").length;
  if (productActivations !== 2 || finalEvents.filter((event) => event.type === "disposed").length !== 1) {
    throw spikeError("registration-count", "reactivation lifecycle count was not exact");
  }

  await writeJsonAtomic(handoffPath, {
    schemaVersion: 1,
    stageOnePid: process.pid,
    sessionID,
    directory: api.state.path.directory,
  });
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    stage: 1,
    status: "passed",
    openCodeVersion: REQUIRED_VERSION,
    productVersion: state.productVersion,
    productActivations,
    cleanupElapsedMs,
    proofs: {
      packedTargetActive: true,
      cardAbsentThenPresent: true,
      rendererClickOpenedDialog: true,
      rendererEnterOpenedDialog: true,
      paletteVisible: true,
      paletteMetadataOnly: true,
      paletteOpenedRoute: true,
      routeModeLifecycle: true,
      delayedReplacementLease: true,
      workspaceWarped: true,
      livePathUpdated: true,
      pluginNotReinstantiated: true,
      pathRebound: true,
      pluginDeactivated: true,
      pluginReactivated: true,
      registrationsExact: true,
    },
    providerPromptHookCalls: await providerPromptHookCalls(eventsPath),
  };
}

async function runStageTwo(api, state) {
  const handoff = await readBoundedJson(state.handoffPath);
  if (handoff?.schemaVersion !== 1 || !Number.isInteger(handoff.stageOnePid)
    || handoff.stageOnePid === process.pid || typeof handoff.sessionID !== "string" || !handoff.sessionID
    || typeof handoff.directory !== "string" || path.resolve(handoff.directory) !== state.workspaceDir) {
    throw spikeError("restart-handoff", "private restart handoff is invalid");
  }
  state.sessionIDs.push(handoff.sessionID);
  const keys = createMockKeys(api.renderer);
  await eventually(() => pluginStatus(api).length === 1 && pluginStatus(api)[0].active === true, "fresh packed product activation");
  const productActivations = (await eventually(async () => {
    const events = await productEvents(state.eventsPath);
    const current = events.filter((event) => event.type === "activated" && event.activation === 1);
    return current.length >= 2 ? current : false;
  }, "fresh-process product event")).filter((event) => event.hostVersion === REQUIRED_VERSION).length;
  await selectSession(api, handoff.directory, handoff.sessionID);
  if (!node(api, CARD_ID)) {
    await Promise.resolve(api.keymap.dispatchCommand("session.sidebar.toggle"));
  }
  await eventually(() => node(api, CARD_ID), "narrow sidebar card");
  const card = node(api, CARD_ID);
  if (countNodesById(api.renderer.root, CARD_ID) !== 1) {
    throw spikeError("narrow-slot-duplicate", "narrow sidebar card registration was duplicated");
  }
  card.focus();
  keys.pressEnter();
  await eventually(() => node(api, DIALOG_ID), "narrow product dialog");
  api.ui.dialog.clear();
  await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
  await eventually(() => api.route.current.name === ROUTE_ID && node(api, ROUTE_VIEW_ID), "narrow product route");
  const singleRegistration = pluginStatus(api).length === 1
    && commandEntries(api).length === 1
    && countNodesById(api.renderer.root, ROUTE_VIEW_ID) === 1;
  api.route.navigate("session", { sessionID: handoff.sessionID });
  await eventually(() => api.route.current.name === "session", "narrow route close");
  const observedProviderPromptHookCalls = await providerPromptHookCalls(state.eventsPath);

  const sessionDeleted = await deleteSession(api, handoff.directory, handoff.sessionID);
  if (!sessionDeleted) throw spikeError("session-delete-readback", "fixture session survived deletion");
  const fixtureFiles = [
    state.fixtureState,
    state.eventsPath,
    path.join(state.workspaceDir, ".self-evolve-host-spike-created"),
  ];
  for (const filePath of fixtureFiles) await fs.rm(filePath, { force: true });
  if ((await Promise.all(fixtureFiles.map(exists))).some(Boolean)) {
    throw spikeError("fixture-delete-readback", "fixture state survived deletion");
  }
  await fs.rm(state.handoffPath, { force: true });
  if (await exists(state.handoffPath)) throw spikeError("handoff-delete-readback", "private handoff survived deletion");
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    stage: 2,
    status: "passed",
    openCodeVersion: REQUIRED_VERSION,
    productVersion: state.productVersion,
    productActivations: Math.max(1, productActivations - 1),
    proofs: {
      freshProcess: true,
      packedTargetActive: true,
      singleRegistration,
      restartHandoffValid: true,
      narrowCardReachable: true,
      narrowDialogReachable: true,
      narrowRouteReachable: true,
      sessionsDeleted: true,
      fixturesDeleted: true,
      privateHandoffDeleted: true,
    },
    providerPromptHookCalls: observedProviderPromptHookCalls,
  };
}

function safeError(error, sessionIDs) {
  let message = error instanceof Error ? error.message : String(error);
  for (const sessionID of sessionIDs) message = message.replaceAll(sessionID, "<session>");
  return message.replace(/\bses_[A-Za-z0-9_-]+\b/g, "<session>").slice(0, 500);
}

async function tui(api) {
  const stage = Number(process.env.SELF_EVOLVE_TUI_SPIKE_STAGE);
  const receiptPath = requiredAbsoluteEnv("SELF_EVOLVE_TUI_SPIKE_RECEIPT");
  const handoffPath = requiredAbsoluteEnv("SELF_EVOLVE_TUI_SPIKE_HANDOFF");
  const fixtureState = requiredAbsoluteEnv("SELF_EVOLVE_TUI_SPIKE_FIXTURE_STATE");
  const eventsPath = requiredAbsoluteEnv("SELF_EVOLVE_TUI_SPIKE_EVENTS");
  const workspaceDir = requiredAbsoluteEnv("SELF_EVOLVE_TUI_SPIKE_WORKSPACE");
  const productVersion = process.env.SELF_EVOLVE_TUI_SPIKE_PRODUCT_VERSION;
  if (![1, 2].includes(stage) || !productVersion) throw spikeError("invalid-environment", "stage or product version is invalid");
  const state = {
    stage,
    receiptPath,
    handoffPath,
    fixtureState,
    eventsPath,
    workspaceDir,
    productVersion,
    directory: path.resolve(api.state.path.directory),
    sessionIDs: [],
  };
  setTimeout(() => {
    void eventually(() => pluginStatus(api).length === 1 && pluginStatus(api)[0].active, "product startup")
      .then(() => stage === 1 ? runStageOne(api, state) : runStageTwo(api, state))
      .then((receipt) => writeJsonAtomic(receiptPath, receipt))
      .catch(async (error) => {
        await writeJsonAtomic(receiptPath, {
          schemaVersion: RECEIPT_SCHEMA_VERSION,
          stage,
          status: "failed",
          errorCode: typeof error?.code === "string" ? error.code : "spike-failed",
          error: safeError(error, state.sessionIDs),
        }).catch(() => {});
      });
  }, 0);
}

export default {
  id: WITNESS_ID,
  tui,
};
