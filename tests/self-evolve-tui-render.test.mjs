import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../scripts/tui-render-smoke.mjs", import.meta.url);
const compiler = new URL("../scripts/compile-tui-artifact.mjs", import.meta.url);
const source = new URL("../self-evolve-tui.tsx", import.meta.url);
const root = new URL("..", import.meta.url).pathname;

test("compiled native control center renders reactively and retains exact deep-link focus", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "self-evolve-tui-render-"));
  const compiled = path.join(temporary, "self-evolve-tui.compiled.mjs");
  const smoke = path.join(temporary, "tui-render-smoke.mjs");
  try {
    for (const dependency of ["self-evolve-tui.js", "self-evolve-tui-store.js"]) {
      symlinkSync(path.join(root, dependency), path.join(temporary, dependency));
    }
    symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"));
    const smokeSource = readFileSync(script, "utf8");
    const insertionPoint = "  const firstRunSnapshot = snapshot();";
    assert.ok(smokeSource.includes(insertionPoint), "renderer smoke regression insertion point changed");
    writeFileSync(smoke, smokeSource.replace(insertionPoint, `
  const setupDeepLinkSnapshot = snapshot();
  setupDeepLinkSnapshot.dashboard.settings.consent.passiveCalls = false;
  setupDeepLinkSnapshot.controlState.consent.passiveCalls = false;
  const setupMountSnapshot = structuredClone(setupDeepLinkSnapshot);
  setupMountSnapshot.controlState = null;
  store.emit(setupMountSnapshot);
  const lateHostFocusDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "passive-consent" });
  try {
    assert.equal(lateHostFocusDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls"), undefined,
      "passive-consent control mounted before authority arrived");
    let hostClearedFocus = false;
    const clearMountedFocus = (current) => {
      if (!hostClearedFocus && current?.id === "self-evolve-focus-local-consent-passiveCalls") {
        hostClearedFocus = true;
        current.blur();
      }
    };
    lateHostFocusDeepLink.renderer.on("focused_renderable", clearMountedFocus);
    store.emit(setupDeepLinkSnapshot);
    await lateHostFocusDeepLink.flush();
    lateHostFocusDeepLink.renderer.off("focused_renderable", clearMountedFocus);
    const exactTarget = lateHostFocusDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
    const routeRoot = lateHostFocusDeepLink.renderer.root.findDescendantById("mcrescenzo.self-evolve.control-center");
    assert.equal(hostClearedFocus, true, "late host focus clearing was not simulated");
    assert.equal(exactTarget?.focused, true, "passive-consent deep link never acquired exact focus");
    assert.ok(routeRoot, "control-center route root was not rendered");
    store.emit(structuredClone(setupDeepLinkSnapshot));
    await lateHostFocusDeepLink.flush();
    const replacementTarget = lateHostFocusDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
    assert.notEqual(replacementTarget, exactTarget, "reactive update did not replace the exact target instance");
    assert.equal(replacementTarget?.focused, true, "same-ID target replacement lost deep-link focus");
    assert.match(lateHostFocusDeepLink.captureCharFrame(), /› Review consent for Background AI analysis/u);
    routeRoot.focus();
    await lateHostFocusDeepLink.flush();
    assert.equal(replacementTarget.focused, true, "repeated host route focus displaced the exact deep-link control");
  } finally {
    lateHostFocusDeepLink.renderer.destroy();
  }

  store.emit(setupMountSnapshot);
  const abandonedDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "passive-consent" });
  try {
    let leftRouteDuringFocus = false;
    const leaveOnMountedFocus = (current) => {
      if (!leftRouteDuringFocus && current?.id === "self-evolve-focus-local-consent-passiveCalls") {
        leftRouteDuringFocus = true;
        host.api.route.current = { name: "session", params: { sessionID: "left-deep-link" } };
        current.blur();
      }
    };
    abandonedDeepLink.renderer.on("focused_renderable", leaveOnMountedFocus);
    store.emit(setupDeepLinkSnapshot);
    await abandonedDeepLink.flush();
    abandonedDeepLink.renderer.off("focused_renderable", leaveOnMountedFocus);
    const abandonedTarget = abandonedDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
    assert.equal(leftRouteDuringFocus, true, "route-guard deep link never acquired exact focus");
    assert.equal(abandonedTarget.focused, false, "deep-link focus returned after the route was left");
  } finally {
    abandonedDeepLink.renderer.destroy();
  }

  store.emit(setupMountSnapshot);
  const provisionalDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "passive-consent" });
  try {
    const fallback = provisionalDeepLink.renderer.root.findDescendantById("self-evolve-focus-anchor-passive-consent");
    const userTarget = provisionalDeepLink.renderer.root.findDescendantById("self-evolve-focus-section-home");
    assert.equal(fallback?.focused, true, "provisional anchor did not receive fallback focus");
    assert.ok(userTarget, "user-navigation target was not rendered");
    userTarget.focus();
    store.emit(setupDeepLinkSnapshot);
    await provisionalDeepLink.flush();
    const lateTarget = provisionalDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
    assert.equal(userTarget.focused, true, "late exact mount stole focus after provisional user navigation");
    assert.equal(lateTarget?.focused, false, "late exact target remained focused after ownership cancellation");
  } finally {
    provisionalDeepLink.renderer.destroy();
  }

  for (const unavailableProperty of ["visible", "focusable"]) {
    store.emit(setupDeepLinkSnapshot);
    const unavailableDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "passive-consent" });
    try {
      const unavailableTarget = unavailableDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
      const fallback = unavailableDeepLink.renderer.root.findDescendantById("self-evolve-focus-anchor-passive-consent");
      const routeRoot = unavailableDeepLink.renderer.root.findDescendantById("mcrescenzo.self-evolve.control-center");
      assert.equal(unavailableTarget?.focused, true, unavailableProperty + " target did not start focused");
      assert.ok(routeRoot, "unavailable-target route root was not rendered");
      Object.defineProperty(unavailableTarget, unavailableProperty, { configurable: true, get: () => false });
      routeRoot.focus();
      await unavailableDeepLink.flush();
      assert.equal(fallback?.focused, true, unavailableProperty + " exact target suppressed fallback focus");
      assert.equal(unavailableTarget.focused, false, unavailableProperty + " exact target retained focus");
    } finally {
      unavailableDeepLink.renderer.destroy();
    }
  }

  store.emit(setupDeepLinkSnapshot);
  const geometryDeepLink = await renderRoute(route, host.api, { section: "settings", settingsAnchor: "passive-consent" });
  try {
    const geometryTarget = geometryDeepLink.renderer.root.findDescendantById("self-evolve-focus-local-consent-passiveCalls");
    const routeRoot = geometryDeepLink.renderer.root.findDescendantById("mcrescenzo.self-evolve.control-center");
    let scrollbox = geometryTarget?.parent;
    while (scrollbox && typeof scrollbox.scrollChildIntoView !== "function") scrollbox = scrollbox.parent;
    assert.ok(geometryTarget && routeRoot && scrollbox?.viewport, "real scroll geometry was unavailable");
    const viewportTop = scrollbox.viewport.screenY;
    const viewportHeight = Math.max(2, scrollbox.viewport.height);
    let reportedTop = viewportTop + viewportHeight - 1;
    Object.defineProperty(geometryTarget, "screenY", { configurable: true, get: () => reportedTop });
    const originalScrollChildIntoView = scrollbox.scrollChildIntoView.bind(scrollbox);
    let scrollCalls = 0;
    let settleOnThird = true;
    scrollbox.scrollChildIntoView = (id) => {
      scrollCalls += 1;
      if (settleOnThird && scrollCalls === 3) reportedTop = viewportTop;
      originalScrollChildIntoView(id);
    };
    routeRoot.focus();
    for (let frame = 0; frame < 8; frame += 1) await geometryDeepLink.renderOnce();
    assert.ok(scrollCalls >= 3, "scroll settlement ignored viewport or complete bounds (" + scrollCalls + " calls)");

    Object.defineProperty(geometryTarget, "height", { configurable: true, get: () => viewportHeight + 5 });
    reportedTop = viewportTop;
    scrollCalls = 0;
    settleOnThird = false;
    routeRoot.focus();
    for (let frame = 0; frame < 5; frame += 1) await geometryDeepLink.renderOnce();
    assert.ok(scrollCalls <= 3, "taller-than-viewport target did not use top visibility (" + scrollCalls + " calls)");

    delete geometryTarget.height;
    reportedTop = viewportTop + viewportHeight + 10;
    scrollCalls = 0;
    routeRoot.focus();
    for (let frame = 0; frame < 32; frame += 1) await geometryDeepLink.renderOnce();
    assert.ok(scrollCalls <= 10, "scroll settlement exceeded its frame bound (" + scrollCalls + " calls)");
  } finally {
    host.api.route.current = { name: "session", params: { sessionID: "geometry-finished" } };
    geometryDeepLink.renderer.destroy();
  }

${insertionPoint}`));
    const compilation = spawnSync("bun", [compiler.pathname, source.pathname, compiled], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(compilation.status, 0, `${compilation.stdout}\n${compilation.stderr}`);

    const result = spawnSync("bun", ["--conditions=browser", smoke, compiled], {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout);
    assert.deepEqual(receipt, {
      ok: true,
      renderedSections: ["home", "recommendations", "activity", "settings"],
      narrowSections: ["home", "recommendations", "activity", "settings"],
      keyboardFocusCoverage: {
        monochromeMarkers: true,
        activityArrowNavigation: true,
        activationParity: ["pointer", "enter", "space"],
        tabDirections: ["forward", "reverse"],
      },
      deepLinkFocusCoverage: ["activity-errors", "settings-provider", "first-run-home"],
      reactiveLastCycle: true,
      identityResetCoverage: {
        stateClasses: ["confirmation", "consent", "folder-draft", "yolo", "maintenance", "recommendation", "pending-route", "prior-route"],
        transitions: ["key", "projectFingerprint", "stateRootIdentity", "identified-to-identity-less", "identity-less-to-identified"],
        freshReview: true,
      },
      authorityRecoveryCoverage: {
        staleContexts: ["recommendation", "header", "settings", "pending", "expiry"],
        retryFreshActionsOnly: true,
        preparedAuthorityCleared: true,
      },
      requestExpiryCoverage: {
        exactActionIsolation: true,
        unrelatedRecommendationAvailable: true,
        everyRetainedOutcomeVisible: true,
        retryRenegotiatesNonceAuthority: true,
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
