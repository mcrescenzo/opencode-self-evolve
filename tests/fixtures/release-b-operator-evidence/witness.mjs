import { createHash } from "node:crypto";
import { createMockKeys, createMockMouse } from "@opentui/core/testing";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";

const PRODUCT_ID = "mcrescenzo.self-evolve";
const COMMAND_ID = "mcrescenzo.self-evolve.control-center";
const ROUTE_ID = "mcrescenzo.self-evolve.control-center.route";
const VIEW_ID = "mcrescenzo.self-evolve.control-center";
const CARD_ID = "self-evolve-sidebar-card";
const WAIT_MS = 30_000;
const decoder = new TextDecoder();

function requiredAbsoluteEnv(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
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
  throw new Error(`${description} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function frameText(api) {
  return decoder.decode(api.renderer.currentRenderBuffer.getRealCharBytes(true));
}

function node(api, id) {
  return api.renderer.root.findDescendantById(id);
}

async function revealSidebarCard(api, expectedText = "Starting Self-evolve") {
  const existing = node(api, CARD_ID);
  if (existing && frameText(api).includes(expectedText)) return existing;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await Promise.resolve(api.keymap.dispatchCommand("session.sidebar.toggle"));
    const card = await eventually(
      () => {
        const candidate = node(api, CARD_ID);
        return candidate && frameText(api).includes(expectedText) ? candidate : false;
      },
      `production sidebar card toggle ${attempt + 1}`,
      1_500,
    ).catch(() => null);
    if (card) return card;
  }
  throw new Error("production sidebar card remained absent after probing both sidebar states");
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

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function unwrap(value) {
  return value?.data ?? value;
}

async function createSession(api, directory) {
  const response = await api.client.session.create({
    directory,
    title: "Self-evolve Release B exact-host evidence",
  });
  if (response?.error) throw new Error("operator evidence session creation failed");
  const session = unwrap(response);
  if (!session || typeof session.id !== "string" || !session.id) {
    throw new Error("operator evidence session has no identity");
  }
  return session.id;
}

async function selectSession(api, directory, sessionID) {
  const response = await api.client.tui.selectSession({ directory, sessionID });
  if (response?.error) throw new Error("operator evidence session selection failed");
  await eventually(
    () => api.route.current.name === "session" && api.route.current.params?.sessionID === sessionID,
    "session route",
  );
}

async function deleteSession(api, directory, sessionID) {
  const response = await api.client.session.delete({ directory, sessionID });
  if (response?.error && response.response?.status !== 404) {
    throw new Error("operator evidence session deletion failed");
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filePath);
}

function normalizeFrame(source, replacements) {
  let value = source;
  for (const [needle, replacement] of replacements) {
    if (needle) value = value.replaceAll(needle, replacement);
  }
  return value
    .replace(/\b[A-Za-z0-9]{6}\/project\b/gu, "<project-id>/project")
    .replace(/\bfile:\/\/\/[^\s"'<>|│┃┌┐└┘]+/giu, "<private-file-url>")
    .replace(
      /(^|[\s"'(])\/(?:home|Users|ssd|tmp|var|private|opt|root)(?:\/[^\s"'<>|│┃┌┐└┘]*)?/gu,
      "$1<private-path>",
    )
    .replace(/\bses_[A-Za-z0-9_-]+\b/gu, "<session>")
    .replace(/\b[a-f0-9]{64}\b/gu, "<hash>")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/^\n+|\n+$/gu, "");
}

function audit(schemas, kind, proposalId, details, timestamp) {
  return schemas.makeAuditEvent({
    id: sha256(JSON.stringify([kind, proposalId, details, timestamp])),
    kind,
    ...(proposalId ? { proposalId } : {}),
    actor: "self-evolve-integration",
    timestamp,
    payloadHash: sha256(JSON.stringify(details)),
    details,
  });
}

async function createProjectionHarness(api, state) {
  const moduleUrl = (name) => pathToFileURL(path.join(state.packageRoot, name)).href;
  const activeModuleUrl = (name) => pathToFileURL(path.join(state.activePackageRoot, name)).href;
  const [bridge, projection, schemas, stateRootModule, storeModule, tuiStoreModule] = await Promise.all([
    import(moduleUrl("self-evolve-bridge.js")),
    import(moduleUrl("self-evolve-projection.js")),
    import(moduleUrl("self-evolve-schemas.js")),
    import(moduleUrl("self-evolve-state-root.js")),
    import(moduleUrl("self-evolve-store.js")),
    import(moduleUrl("self-evolve-tui-store.js")),
  ]);
  const activeTuiStoreModule = await import(activeModuleUrl("self-evolve-tui-store.js"));
  const activeOwner = activeTuiStoreModule.acquireProjectTuiStore({ api });
  const context = tuiStoreModule.resolveTuiStoreContext(api, {});
  const stateRoot = context.stateRoot;
  const projectFingerprint = context.projectFingerprint;
  const rootIdentity = stateRootModule.stateRootIdentity(stateRoot);
  const store = storeModule.openStore(stateRoot, {
    projectFingerprint,
    projectName: "release-b-operator-evidence",
  });
  const skillRoot = path.join(
    state.scratch,
    "approved-skill-folders",
    "a-very-long-folder-name-that-must-wrap-without-horizontal-scrolling",
  );
  const skillPath = path.join(skillRoot, "diagnostic-helper", "SKILL.md");
  const currentContent = [
    "---",
    "name: diagnostic-helper",
    "description: Bounded exact-host Release B evidence fixture.",
    "---",
    "",
    "# Diagnostic helper",
    "",
    "Current guidance.",
    "",
  ].join("\n");
  const proposedContent = `${currentContent}\nAdd a deliberately long but bounded explanation that must wrap cleanly in narrow terminal layouts without exposing identifiers or corrupting adjacent controls.\n`;
  await fs.mkdir(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(skillPath, currentContent, { mode: 0o600 });
  const currentHash = storeModule.hashContent(currentContent);
  const proposedHash = storeModule.hashContent(proposedContent);
  let clock = Date.now();
  let proposalState = null;

  const append = (kind, payload, timestamp = ++clock) => {
    const saved = store.appendRecord(schemas.wrapRecord(kind, payload, timestamp));
    if (!saved?.ok) throw new Error(`${kind} fixture append failed: ${saved?.reason}`);
  };
  const updateSettings = ({ mode, consent, paused = false, killSwitchActive = false } = {}) => {
    const current = store.getSettings();
    const next = schemas.makeGlobalSettings({
      ...current.global,
      mode: mode ?? current.global.mode,
      paused,
      killSwitchActive,
      allowedSkillRoots: [skillRoot],
      consent: consent ?? current.global.consent,
      updatedAt: ++clock,
    });
    const saved = store.setGlobalSettings(next);
    if (saved?.ok === false) throw new Error(`global settings fixture update failed: ${saved.reason}`);
  };
  const targetReader = (proposalValue) => {
    if (proposalValue.skillTarget.relativePath !== "diagnostic-helper/SKILL.md") {
      return { exists: false, content: null, hash: null };
    }
    const content = proposalState === "applied" ? proposedContent : currentContent;
    return { exists: true, content: Buffer.from(content), hash: storeModule.hashContent(content) };
  };
  const inventory = () => [{
    canonicalRoot: skillRoot,
    relativePath: "diagnostic-helper/SKILL.md",
    exists: true,
    currentHash: proposalState === "applied" ? proposedHash : currentHash,
  }];
  const publishControl = (settings) => {
    const now = ++clock;
    bridge.publishControlState(stateRoot, {
      // Bridge wire version, which is separate from the durable state generation.
      schemaVersion: bridge.BRIDGE_SCHEMA_VERSION,
      projectFingerprint,
      actor: "self-evolve-integration",
      issuedAt: now,
      expiresAt: now + 60_000,
      settingsUpdatedAt: settings.global.updatedAt,
      settingsVersion: sha256(JSON.stringify(settings)),
      stateRootIdentity: rootIdentity,
      nonce: `operator-control-${now}`,
      mode: settings.global.mode,
      effectiveMode: settings.global.mode,
      allowedSkillRoots: settings.global.allowedSkillRoots,
      consent: settings.global.consent,
      repoExcluded: settings.repo.excluded,
    });
  };
  const publish = async ({ health = {}, dashboard = true, corruptDashboard = false } = {}) => {
    const now = ++clock;
    const snapshot = store.readProjectionSnapshot();
    const built = projection.buildUiProjection(snapshot, {
      stateRootIdentity: rootIdentity,
      now,
      targetReader,
      inventory: inventory(),
      health: {
        hostSupported: true,
        stateRootReady: true,
        providerReady: true,
        minSynthesesObserved: 0,
        minSuccessRateBasisPoints: 0,
        ...health,
      },
      detailProposalIds: proposalState ? ["release-b-recommendation"] : [],
    });
    bridge.publishUiProjection(stateRoot, {
      index: built.index,
      details: built.publicationDetails,
      ...(dashboard ? { dashboard: built.dashboard } : {}),
      now,
    });
    const readback = bridge.readUiProjection(stateRoot, projectFingerprint, {
      now,
      stateRootIdentity: rootIdentity,
      clientOffer: tuiStoreModule.__testTuiStore.clientOffer,
      detailProposalIds: proposalState ? ["release-b-recommendation"] : [],
    });
    if (!readback?.index) {
      throw new Error(`published projection readback failed: ${readback?.reason ?? readback?.mode ?? "unknown"}`);
    }
    publishControl(snapshot.settings);
    let lastActiveSnapshot = null;
    const activeSnapshot = await eventually(async () => {
      const candidate = await activeOwner.refresh();
      lastActiveSnapshot = candidate;
      if (!candidate?.projection?.index || candidate.phase === "error") return false;
      if (candidate.projection.index.projectionHash !== built.index.projectionHash) return false;
      if (state.legacyTui && Object.hasOwn(candidate, "dashboard")) return false;
      if (!state.legacyTui && dashboard
        && candidate.projection.dashboard?.dashboardHash !== built.dashboard.dashboardHash) {
        return false;
      }
      return candidate;
    }, "production shared TUI store convergence", 5_000).catch((error) => {
      const last = lastActiveSnapshot ?? {};
      throw new Error([
        error.message,
        `phase=${String(last.phase ?? "missing")}`,
        `error=${String(last.error ?? "none")}`,
        `mode=${String(last.projection?.mode ?? "missing")}`,
        `reason=${String(last.projection?.reason ?? "none")}`,
        `index=${last.projection?.index ? "present" : "missing"}`,
        `dashboard=${Object.hasOwn(last, "dashboard") ? "present" : "absent"}`,
      ].join("; "));
    });
    if (corruptDashboard) {
      const dashboardPath = path.join(
        stateRoot,
        "self-evolve",
        "bridge",
        projectFingerprint,
        "projection",
        "generations",
        built.generation,
        "dashboard-v1.json",
      );
      fs.writeFile(dashboardPath, "{}\n", { mode: 0o600 });
    }
    return {
      ...built,
      legacyTuiIgnoredAdditiveDashboard: state.legacyTui
        && dashboard
        && !Object.hasOwn(activeSnapshot, "dashboard"),
    };
  };
  const seedCycle = (outcome, reason = null) => {
    const occurredAt = ++clock;
    append("audit-event", audit(schemas, "decision", null, {
      action: "cycle-outcome",
      outcome,
      triggerClass: "idle",
      mode: store.getSettings().global.mode,
      observationCount: outcome === "recommendation-created" ? 3 : 0,
      eligibilityCount: outcome === "recommendation-created" ? 1 : 0,
      occurredAt,
      reason,
    }, occurredAt), occurredAt);
  };
  const seedRecommendation = () => {
    if (proposalState) return;
    proposalState = "pending";
    const clusterId = sha256("release-b-operator-evidence-cluster");
    const proposal = schemas.makeProposal({
      id: "release-b-recommendation",
      projectFingerprint,
      clusterId,
      skillTarget: {
        canonicalRoot: skillRoot,
        relativePath: "diagnostic-helper/SKILL.md",
        currentHash,
      },
      proposedContentHash: proposedHash,
      rationaleText: "Repeated independent diagnostic incidents support this bounded improvement. This intentionally long rationale verifies wrapping, stable focus, and readable hierarchy without showing raw transcripts, host identifiers, hashes, or private paths.",
      synthesizedAt: ++clock,
      synthesizerModelId: "fixture/no-provider",
      criticScore: 0.95,
      criticPassed: true,
      validDeterministic: true,
      state: "pending",
      injectionFlagged: false,
      decisionVersion: 0,
      burnedNonceHashes: [],
    });
    append("proposal", proposal);
    append("proposal-content", schemas.makeProposalContent({
      proposalId: proposal.id,
      contentHash: proposedHash,
      contentEncoding: "base64",
      chunkIndex: 0,
      chunkCount: 1,
      content: Buffer.from(proposedContent).toString("base64"),
    }));
    append("evidence-cluster", schemas.makeEvidenceCluster({
      id: clusterId,
      receiptType: "repeated-command",
      projectFingerprint,
      incidentIds: ["incident-one", "incident-two", "incident-three"],
      scopeFingerprint: sha256("release-b-operator-scope"),
      occurrencesSum: 4,
      firstSeenAt: clock - 20_000,
      lastSeenAt: clock - 1_000,
    }));
    append("eligibility-explanation", schemas.makeEligibilityExplanation({
      clusterId,
      eligible: true,
      reasons: ["all-thresholds-met"],
      thresholdsMet: {
        minIndependentIncidents: "3 (actual 3)",
        minOccurrencesSum: "3 (actual 4)",
      },
      thresholdsMissed: {},
    }));
    seedCycle("recommendation-created");
  };
  const seedApplied = async () => {
    seedRecommendation();
    proposalState = "applied";
    await fs.writeFile(skillPath, proposedContent, { mode: 0o600 });
    const currentProposal = store.readRecords("proposal").at(-1).payload;
    append("proposal", schemas.makeProposal({
      ...currentProposal,
      state: "applied",
      decisionVersion: currentProposal.decisionVersion + 1,
    }));
    append("audit-event", audit(schemas, "apply", currentProposal.id, {
      state: "readback-verified",
      appliedHash: proposedHash,
      "readback-verified": true,
    }, ++clock));
  };
  return {
    projectFingerprint,
    skillRoot,
    close() {
      activeOwner.dispose();
      store.close();
    },
    publish,
    seedApplied,
    seedCycle,
    seedRecommendation,
    updateSettings,
  };
}

async function runEvidence(api, state) {
  const frames = [];
  const proofs = {};
  const scratchName = path.basename(state.scratch);
  const replacements = [
    [state.scratch, "<scratch>"],
    [scratchName.slice(-6), "<scratch-id>"],
    [state.stateRoot, "<state-root>"],
    [state.packageRoot, "<candidate>"],
    [state.activePackageRoot, "<active-candidate>"],
    [state.directory, "<project>"],
  ];
  const capture = async (name, required = []) => {
    await wait(100);
    const raw = frameText(api);
    for (const text of required) {
      if (!raw.includes(text)) throw new Error(`${name} frame omitted ${JSON.stringify(text)}; visible frame:\n${normalizeFrame(raw, replacements).slice(-2500)}`);
    }
    const frame = normalizeFrame(raw, replacements);
    const rawLines = raw.split("\n");
    frames.push({
      name,
      columns: Number(process.env.COLUMNS),
      rows: Number(process.env.LINES),
      sha256: sha256(frame),
      frame,
      maximumLineColumns: Math.max(0, ...rawLines.map((line) => [...line].length)),
    });
    return frame;
  };
  const keys = createMockKeys(api.renderer);
  const mouse = createMockMouse(api.renderer);
  const scrollUntilVisible = async (needle, description) => {
    const view = await eventually(() => node(api, VIEW_ID), `${description} control center`);
    const point = center(view);
    for (const direction of ["down", "up"]) {
      for (let attempt = 0; attempt < 96; attempt += 1) {
        if (frameText(api).includes(needle)) return;
        await mouse.scroll(point.x, point.y, direction, { delayMs: 0 });
        await wait(10);
      }
    }
    throw new Error(`${description} remained below the scroll viewport`);
  };
  const productStatus = await eventually(() => {
    const status = api.plugins.list().find((entry) => entry.id === PRODUCT_ID && entry.active);
    return status || false;
  }, "installed production TUI activation", 60_000).catch((error) => {
    const statuses = api.plugins.list()
      .filter(({ source }) => source !== "internal")
      .map(({ id, source, enabled, active }) => ({ id, source, enabled, active }));
    const configured = Array.isArray(api.tuiConfig.plugin) ? api.tuiConfig.plugin : [];
    throw new Error(
      `${error.message}; plugins=${JSON.stringify(statuses)}; config=${
        JSON.stringify({
          count: configured.length,
          candidatePresent: configured.some((entry) => (
            typeof entry === "string" && entry.includes("@mcrescenzo/opencode-self-evolve")
          )),
        })
      }`,
    );
  });
  const harness = await createProjectionHarness(api, state);
  const sessionID = await createSession(api, state.directory);
  await selectSession(api, state.directory, sessionID);
  try {
    await Promise.resolve(api.kv.set("dismissed_getting_started", true));
    const startupText = state.legacyTui ? "Starting" : "Starting Self-evolve";
    const card = await revealSidebarCard(api, startupText);
    if (productStatus.source !== "file") {
      throw new Error(`packed production target used unexpected ${productStatus.source} loader`);
    }
    const initialRoute = JSON.stringify(api.route.current);
    if (api.ui.dialog.open || api.route.current.name === ROUTE_ID) {
      throw new Error("production TUI opened ambient UI before operator activation");
    }
    await capture(
      state.legacyTui ? "legacy-startup-sidebar" : "startup-sidebar",
      ["Self-evolve", startupText],
    );
    proofs.noAmbientUiBeforeActivation = true;
    if (state.legacyTui) {
      proofs.legacyTuiEntryActive = true;
      proofs.legacyTuiPinnedArtifactPath = true;
    } else {
      proofs.productionTuiEntryActive = true;
      proofs.productionTuiPackedArtifactPath = true;
    }

    const allConsent = {
      passiveCalls: true,
      durableObservations: true,
      sanitizedExcerpts: true,
      crossRepoAggregation: true,
    };
    harness.updateSettings({ mode: "manual" });
    harness.seedCycle("valid-no-change");
    const manualPublication = await harness.publish();
    await eventually(
      () => frameText(api).includes(state.legacyTui ? "Manual · Ready" : "Runs on demand"),
      "manual sidebar state",
      5_000,
    ).catch((error) => {
      const visible = normalizeFrame(frameText(api), replacements).slice(-2_000);
      throw new Error(`${error.message}; visible frame:\n${visible}`);
    });

    if (state.stage === 1) {
      await mouse.click(center(card).x, center(card).y);
      await eventually(() => api.route.current.name === ROUTE_ID && node(api, VIEW_ID), "pointer-opened Home");
      // The global-first Home carries more content than the Release B layout, so
      // the no-change empty state can sit below the fold at this viewport.
      await scrollUntilVisible("No useful change found", "home no-change empty state");
      await capture("wide-home-pointer", ["Home", "Recommendations", "Activity", "Settings", "No useful change found"]);
      proofs.pointerOpenedSidebarDeepLink = true;

      for (const [section, required] of [
        ["Recommendations", ["Recommendations", "Nothing needs review"]],
        ["Activity", ["Activity", "Diagnostics", "Analysis completed successfully"]],
        ["Settings", ["Approved global skill folders", "a-very-long-folder-name"]],
      ]) {
        const point = await eventually(() => framePoint(api, section), `${section} navigation point`);
        await mouse.click(point.x, point.y);
        // The global-first sections are taller than the Release B layout, so each
        // required string is proven visible in turn instead of in one frame.
        for (const text of required) {
          await scrollUntilVisible(text, `wide ${section} content ${JSON.stringify(text)}`);
        }
        await capture(`wide-${section.toLowerCase()}`, required.slice(-1));
      }
      proofs.fourSectionsRendered = true;
      proofs.longApprovedRootRenderedOnlyInSettings = frames
        .filter(({ frame }) => frame.includes("a-very-long-folder-name"))
        .every(({ name }) => name === "wide-settings")
        && frames.some(({ name, frame }) => (
          name === "wide-settings" && frame.includes("a-very-long-folder-name")
        ));
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "wide exact Escape restoration");
      proofs.escapeRestoredExactPriorRoute = true;

      harness.updateSettings({ mode: "auto", consent: allConsent });
      await harness.publish();
      // This witness publishes only a project projection, so the global-first
      // sidebar reports the read-only global view instead of the v0.2 ready copy.
      // Cross-project global surfaces are proven by the global bridge suites.
      await revealSidebarCard(api, "Limited global view");
      await capture("wide-ready-sidebar", [
        "Self-evolve",
        "Limited global view",
      ]);
      proofs.readyStateRendered = true;

      harness.seedRecommendation();
      await harness.publish();
      await eventually(() => frameText(api).includes("Recommendation ready"), "recommendation sidebar state");
      const nextCard = await eventually(() => node(api, CARD_ID), "recommendation sidebar card");
      nextCard.focus();
      keys.pressKey("RETURN");
      await eventually(() => api.route.current.name === ROUTE_ID && frameText(api).includes("Why this was suggested"), "Enter recommendation deep link");
      await capture("wide-recommendation-enter", ["Recommendations", "Why this was suggested", "Proposed change", "Evidence"]);
      await scrollUntilVisible("Safety checks", "wide recommendation safety detail");
      await capture("wide-recommendation-safety", ["Safety checks"]);
      await scrollUntilVisible("Token impact", "wide recommendation token detail");
      await capture("wide-recommendation-token", ["Token impact"]);
      await scrollUntilVisible("Rollback", "wide recommendation rollback detail");
      await capture("wide-recommendation-scrolled", ["Rollback"]);
      proofs.enterOpenedRecommendationDeepLink = true;
      proofs.recommendationDetailScrolledWithPointer = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "recommendation Escape restoration");

      await harness.seedApplied();
      await harness.publish();
      await eventually(() => frameText(api).includes("Change applied"), "applied sidebar state");
      await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
      await eventually(() => api.route.current.name === ROUTE_ID, "palette command Home");
      await capture("wide-applied-palette", ["Home", "Change applied", "applied change"]);
      proofs.paletteOpenedHome = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "palette Escape restoration");
    } else if (state.stage === 2) {
      harness.updateSettings({
        mode: "auto",
        consent: {
          passiveCalls: false,
          durableObservations: false,
          sanitizedExcerpts: false,
          crossRepoAggregation: false,
        },
      });
      await harness.publish();
      await eventually(() => frameText(api).includes("Setup needed"), "setup sidebar state");
      const setupCard = await eventually(() => node(api, CARD_ID), "setup sidebar card");
      setupCard.focus();
      keys.pressKey(" ");
      // The global-first Home shows the setup blockers with their own headings;
      // consent review lives in Settings and Home's first-run card.
      await eventually(() => (
        api.route.current.name === ROUTE_ID
        && frameText(api).includes("Setup")
      ), "Space exact setup deep link");
      await capture("medium-setup-space", ["Setup"]);
      const settingsPoint = await eventually(() => framePoint(api, "Settings"), "Settings navigation point");
      await mouse.click(settingsPoint.x, settingsPoint.y);
      for (const text of ["Background AI analysis", "Saved structured patterns"]) {
        await scrollUntilVisible(text, `medium consent setting ${JSON.stringify(text)}`);
      }
      await capture("medium-setup-consent", ["Saved structured patterns"]);
      proofs.spaceOpenedExactSettingsDeepLink = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "setup Escape restoration");

      harness.updateSettings({ mode: "auto", consent: allConsent });
      const waitingProjection = await harness.publish({
        health: { inFlightCount: 1, inFlightStage: "pipeline" },
      });
      if (waitingProjection.dashboard.automation.state !== "running") {
        throw new Error(`waiting projection remained ${waitingProjection.dashboard.automation.state}`);
      }
      const waitingCard = await revealSidebarCard(api, "Analysis in progress");
      waitingCard.focus();
      keys.pressKey("RETURN");
      await eventually(() => api.route.current.name === ROUTE_ID, "waiting Home deep link");
      await capture("medium-waiting", ["Home", "Analysis in progress", "operation in progress"]);
      proofs.waitingStateRendered = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "waiting Escape restoration");

      const failureProjection = await harness.publish({
        health: { corrupt: true, state: "corrupt", reason: "corrupt-state" },
      });
      if (failureProjection.dashboard.automation.state !== "corrupt") {
        throw new Error(`failure projection remained ${failureProjection.dashboard.automation.state}`);
      }
      const failureCard = await revealSidebarCard(api, "Self-evolve needs recovery");
      const failurePoint = center(failureCard);
      await mouse.click(failurePoint.x, failurePoint.y);
      await eventually(() => api.route.current.name === ROUTE_ID && frameText(api).includes("Activity"), "failure Activity deep link");
      await capture("medium-failure", ["Activity", "Errors", "Self-evolve needs recovery"]);
      proofs.failureStateRendered = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "failure Escape restoration");

      await harness.publish({ dashboard: false });
      await revealSidebarCard(api, "Limited view");
      await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
      await eventually(() => api.route.current.name === ROUTE_ID, "limited Home route");
      await capture("medium-new-tui-old-server", [
        "Home",
        "Limited view",
        "could not be validated",
      ]);
      proofs.newTuiOldServerLimitedWithoutAuthority = true;
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "limited Escape restoration");
    } else if (state.stage === 3) {
      await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
      await eventually(() => api.route.current.name === ROUTE_ID && node(api, VIEW_ID), "narrow Home route");
      await capture("narrow-home", ["Home", "Recommendations", "Activity", "Settings", "Runs on demand"]);
      const settingsPoint = await eventually(() => framePoint(api, "Settings"), "narrow Settings point");
      await mouse.click(settingsPoint.x, settingsPoint.y);
      await scrollUntilVisible("Background AI analysis", "narrow privacy settings");
      await capture("narrow-settings", ["Background AI analysis"]);
      proofs.narrowLayoutRenderedWithoutHorizontalOverflow = frames.every((item) => item.maximumLineColumns <= item.columns);
      keys.pressKey("ESCAPE");
      await eventually(() => JSON.stringify(api.route.current) === initialRoute, "narrow Escape restoration");
      if (path.basename(state.directory) !== "restart-project") {
        throw new Error("restart stage did not use the distinct project context");
      }
      proofs.restartFreshProcess = true;
      proofs.restartUsedDistinctProject = true;
    } else {
      if (manualPublication.legacyTuiIgnoredAdditiveDashboard !== true) {
        throw new Error("Release A TUI consumed the additive dashboard");
      }
      await capture("legacy-new-server-sidebar", [
        "Self-evolve",
        "Manual · Ready",
      ]);
      proofs.legacyTuiIgnoredAdditiveDashboard = true;
      await Promise.resolve(api.keymap.dispatchCommand(COMMAND_ID));
      await eventually(
        () => api.route.current.name === ROUTE_ID && node(api, VIEW_ID),
        "Release A control center route",
      );
      await capture("legacy-new-server-control-center", [
        "Self-evolve control center",
        "Overview",
        "Reviews",
        "Settings",
        "Safety",
        "Evidence",
        "Health / Budgets",
        "Maintenance",
        "Help",
        "Status: ready",
        "Mode: manual",
      ]);
      proofs.legacyControlCenterOpened = true;
      keys.pressKey("ESCAPE");
      await eventually(
        () => JSON.stringify(api.route.current) === initialRoute,
        "Release A exact Escape restoration",
      );
      proofs.legacyEscapeRestoredExactPriorRoute = true;
    }
  } finally {
    harness.close();
    await deleteSession(api, state.directory, sessionID).catch(() => {});
  }
  return {
    schemaVersion: 1,
    status: "passed",
    stage: state.stage,
    pid: process.pid,
    openCodeVersion: api.app.version,
    columns: Number(process.env.COLUMNS),
    rows: Number(process.env.LINES),
    proofs,
    frames,
  };
}

async function tui(api) {
  const scratch = requiredAbsoluteEnv("SELF_EVOLVE_RELEASE_B_SCRATCH");
  const expectedStateRoot = requiredAbsoluteEnv("SELF_EVOLVE_RELEASE_B_STATE_ROOT");
  const stateRoot = path.resolve(api.state?.path?.state ?? "");
  if (!stateRoot
    || stateRoot !== expectedStateRoot
    || (stateRoot !== scratch && !stateRoot.startsWith(`${scratch}${path.sep}`))) {
    throw new Error("host-reported state root escaped the isolated evidence stage");
  }
  await fs.chmod(stateRoot, 0o700);
  const stateRootStat = await fs.lstat(stateRoot);
  if (!stateRootStat.isDirectory()
    || stateRootStat.isSymbolicLink()
    || (stateRootStat.mode & 0o077) !== 0
    || await fs.realpath(stateRoot) !== stateRoot) {
    throw new Error("isolated evidence state root is not a canonical private directory");
  }
  const state = {
    stage: Number(process.env.SELF_EVOLVE_RELEASE_B_STAGE),
    receiptPath: requiredAbsoluteEnv("SELF_EVOLVE_RELEASE_B_RECEIPT"),
    scratch,
    stateRoot,
    packageRoot: requiredAbsoluteEnv("SELF_EVOLVE_RELEASE_B_PACKAGE_ROOT"),
    activePackageRoot: requiredAbsoluteEnv("SELF_EVOLVE_RELEASE_B_ACTIVE_PACKAGE_ROOT"),
    directory: path.resolve(api.state.path.directory),
    legacyTui: process.env.SELF_EVOLVE_RELEASE_B_LEGACY_TUI === "1",
  };
  setTimeout(() => {
    void runEvidence(api, state).then(
      (receipt) => writeJsonAtomic(state.receiptPath, receipt),
      (error) => writeJsonAtomic(state.receiptPath, {
        schemaVersion: 1,
        status: "failed",
        stage: state.stage,
        error: String(error?.stack ?? error).slice(0, 4_000),
      }),
    );
  }, 0);
}

export default {
  id: "mcrescenzo.self-evolve.release-b-operator-witness",
  tui,
};
