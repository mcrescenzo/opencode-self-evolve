// @bun
// self-evolve-tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { setTimeout as delay } from "timers/promises";
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js";
import { CONTROL_CENTER_SECTIONS, acquireProjectTuiStore, buildControlCenterModel, controlCenterRouteParams, deriveSidebarCard, parseControlCenterDestination, validateApprovedSkillFolderInput } from "./self-evolve-tui-store.js";
var CONTROL_CENTER_COMMAND = TUI_IDENTITIES.command;
var CONTROL_CENTER_ROUTE = TUI_IDENTITIES.route;
var CONTROL_CENTER_MODE = TUI_IDENTITIES.mode;
var CONTROL_CENTER_VIEW_ID = TUI_IDENTITIES.view;
var MAX_DESTINATION_SCROLL_FRAMES = 8;
var activeApis = new WeakSet;
function snapshotIdentity(snapshot) {
  if (!snapshot?.key && !snapshot?.stateRootIdentity && !snapshot?.projectFingerprint)
    return null;
  return JSON.stringify([snapshot.key ?? null, snapshot.stateRootIdentity ?? null, snapshot.projectFingerprint ?? null]);
}
function isActivationKey(event) {
  return event.name === "return" || event.name === "linefeed" || event.name === "space";
}
function reactiveChild(render) {
  return render;
}
function relativeTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60000)
    return "just now";
  if (elapsed < 3600000)
    return `${Math.floor(elapsed / 60000)}m ago`;
  if (elapsed < 86400000)
    return `${Math.floor(elapsed / 3600000)}h ago`;
  return `${Math.floor(elapsed / 86400000)}d ago`;
}
function requestResponseMessage(completedResponse) {
  if (completedResponse.response?.ok === false) {
    return completedResponse.response.status === "expired" ? `${completedResponse.action?.replaceAll("-", " ") ?? "Request"} expired without a server response. Retry creates a new request ID after re-reading current server nonce authority.` : `Server rejected ${completedResponse.action?.replaceAll("-", " ") ?? "the request"}: ${completedResponse.response.reason}`;
  }
  return completedResponse.action === "purge-all" && completedResponse.response?.status === "accepted-terminal" ? "Purge all accepted; Self-evolve authority stopped. Restart OpenCode to reinitialize durable state." : `${completedResponse.action?.replaceAll("-", " ") ?? "Request"} accepted by the server.`;
}
function SidebarCard(props) {
  let cardNode;
  const [focused, setFocused] = createSignal(false);
  const borderColor = () => {
    if (focused())
      return props.api.theme.current.borderActive;
    const tone = props.card()?.tone;
    if (tone === "error")
      return props.api.theme.current.error;
    if (tone === "warning")
      return props.api.theme.current.warning;
    if (tone === "success")
      return props.api.theme.current.success;
    if (tone === "neutral")
      return props.api.theme.current.borderSubtle;
    return props.api.theme.current.info;
  };
  return _$createComponent(Show, {
    get when() {
      return props.card();
    },
    get children() {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("b"), _el$4 = _$createElement("text"), _el$5 = _$createElement("text"), _el$6 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$4);
      _$insertNode(_el$, _el$5);
      _$insertNode(_el$, _el$6);
      _$use((value) => cardNode = value, _el$);
      _$setProp(_el$, "id", "self-evolve-sidebar-card");
      _$setProp(_el$, "focusable", true);
      _$setProp(_el$, "border", true);
      _$setProp(_el$, "width", "100%");
      _$setProp(_el$, "paddingLeft", 1);
      _$setProp(_el$, "paddingRight", 1);
      _$setProp(_el$, "flexDirection", "column");
      _$setProp(_el$, "on:focused", () => setFocused(true));
      _$setProp(_el$, "on:blurred", () => setFocused(false));
      _$setProp(_el$, "onMouseDown", () => cardNode?.focus());
      _$setProp(_el$, "onKeyDown", (event) => {
        if (!isActivationKey(event))
          return;
        event.preventDefault();
        props.open();
      });
      _$insertNode(_el$2, _el$3);
      _$insert(_el$3, () => focused() ? "\u203A " : "  ", null);
      _$insert(_el$3, () => props.card()?.title, null);
      _$setProp(_el$4, "wrapMode", "word");
      _$insert(_el$4, () => props.card()?.summary);
      _$setProp(_el$5, "wrapMode", "word");
      _$insert(_el$5, () => props.card()?.detail);
      _$setProp(_el$6, "wrapMode", "word");
      _$insert(_el$6, () => props.card()?.action);
      _$effect((_p$) => {
        var _v$ = borderColor(), _v$2 = props.open, _v$3 = props.api.theme.current.text, _v$4 = props.api.theme.current.textMuted, _v$5 = props.api.theme.current.textMuted, _v$6 = props.api.theme.current.info;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "borderColor", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$, "onMouseUp", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$2, "fg", _v$3, _p$.a));
        _v$4 !== _p$.o && (_p$.o = _$setProp(_el$4, "fg", _v$4, _p$.o));
        _v$5 !== _p$.i && (_p$.i = _$setProp(_el$5, "fg", _v$5, _p$.i));
        _v$6 !== _p$.n && (_p$.n = _$setProp(_el$6, "fg", _v$6, _p$.n));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined
      });
      return _el$;
    }
  });
}
function ControlCenter(props) {
  const names = CONTROL_CENTER_SECTIONS;
  const [section, setSection] = createSignal(props.initial.section);
  const [selectedIndex, setSelectedIndex] = createSignal(props.initial.selectedIndex ?? 0);
  const initialRecommendationState = props.snapshot().projection?.index?.reviews?.[props.initial.selectedIndex ?? 0]?.state;
  const [recommendationFilter, setRecommendationFilter] = createSignal(["applied", "rolled-back"].includes(initialRecommendationState ?? "") ? "applied" : ["rejected", "superseded"].includes(initialRecommendationState ?? "") ? "dismissed" : "needs-review");
  const [activityFilter, setActivityFilter] = createSignal(props.initial.filter ?? "all");
  const [settingsAnchor, setSettingsAnchor] = createSignal(props.initial.anchor);
  const [rejectionReason, setRejectionReason] = createSignal(null);
  const [rejectionText, setRejectionText] = createSignal("");
  const [technicalExpanded, setTechnicalExpanded] = createSignal(false);
  const [activityExpanded, setActivityExpanded] = createSignal(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false);
  const [feedback, setFeedback] = createSignal(null);
  const [confirmation, setConfirmation] = createSignal(null);
  const [consentIntent, setConsentIntent] = createSignal(null);
  const [folderInput, setFolderInput] = createSignal("");
  const [folderError, setFolderError] = createSignal(null);
  const [folderDraft, setFolderDraft] = createSignal(null);
  const [folderConfirmation, setFolderConfirmation] = createSignal("");
  const [yoloTarget, setYoloTarget] = createSignal(null);
  const [yoloConfirmation, setYoloConfirmation] = createSignal("");
  const [maintenanceScope, setMaintenanceScope] = createSignal("observations");
  const [maintenanceIntent, setMaintenanceIntent] = createSignal(null);
  const [maintenanceConfirmation, setMaintenanceConfirmation] = createSignal("");
  const [focusedControl, setFocusedControl] = createSignal(null);
  const [activityIndex, setActivityIndex] = createSignal(0);
  const recommendationNodes = new Map;
  const activityNodes = new Map;
  const terminalDimensions = useTerminalDimensions();
  const compactShell = () => terminalDimensions().width <= 64 || terminalDimensions().height <= 20;
  const focusId = (key) => `self-evolve-focus-${key.replaceAll(/[^A-Za-z0-9_.-]/gu, "-")}`;
  const focusMark = (key) => focusedControl() === key ? "\u203A " : "  ";
  const focusHandlers = (key) => ({
    focused: () => setFocusedControl(key),
    blurred: () => setFocusedControl((current) => current === key ? null : current)
  });
  let controlCenterNode;
  let contentScrollbox;
  let cancelDestinationFocus = () => {};
  let refreshDestinationFocus = () => {};
  const focusableDescendants = () => {
    const result = [];
    const visit = (node) => {
      for (const child of node.getChildren()) {
        if (child.focusable && child.visible)
          result.push(child);
        visit(child);
      }
    };
    if (controlCenterNode)
      visit(controlCenterNode);
    return result;
  };
  useKeyboard((event) => {
    if (event.name !== "tab")
      return;
    const navigationEvent = event;
    const nodes = focusableDescendants();
    if (!nodes.length)
      return;
    navigationEvent.preventDefault();
    navigationEvent.stopPropagation();
    const current = nodes.findIndex((node) => node.focused);
    const offset = navigationEvent.shift ? -1 : 1;
    const next = current < 0 ? navigationEvent.shift ? nodes.length - 1 : 0 : (current + offset + nodes.length) % nodes.length;
    nodes[next].focus();
  });
  const model = createMemo(() => buildControlCenterModel(props.snapshot(), {
    selectedIndex: selectedIndex(),
    recommendationFilter: recommendationFilter(),
    activityFilter: activityFilter()
  }));
  let popMode = () => {};
  let unsubscribeIdentity = () => {};
  let mountedIdentity = snapshotIdentity(props.snapshot());
  let mountedPhase = props.snapshot().phase;
  const clearPreparedAuthority = () => {
    setRejectionReason(null);
    setRejectionText("");
    setFeedback(null);
    setConfirmation(null);
    setConsentIntent(null);
    setFolderInput("");
    setFolderError(null);
    setFolderDraft(null);
    setFolderConfirmation("");
    setYoloTarget(null);
    setYoloConfirmation("");
    setMaintenanceIntent(null);
    setMaintenanceConfirmation("");
  };
  const resetForProjectIdentity = () => {
    setSection("home");
    setSelectedIndex(0);
    setRecommendationFilter("needs-review");
    setActivityFilter("all");
    setSettingsAnchor(undefined);
    setTechnicalExpanded(false);
    setActivityExpanded(null);
    setDiagnosticsExpanded(false);
    setMaintenanceScope("observations");
    clearPreparedAuthority();
    props.store.selectDetails([]);
  };
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE);
    selectRecommendation(selectedIndex());
    unsubscribeIdentity = props.store.subscribe((next) => {
      const nextIdentity = snapshotIdentity(next);
      if (mountedIdentity !== nextIdentity) {
        resetForProjectIdentity();
      } else if (mountedPhase !== "error" && next.phase === "error") {
        clearPreparedAuthority();
      }
      mountedIdentity = nextIdentity;
      mountedPhase = next.phase;
    });
  });
  onCleanup(() => {
    cancelDestinationFocus();
    unsubscribeIdentity();
    popMode();
  });
  const navigate = (next) => {
    setSection(next.section);
    setSettingsAnchor(next.section === "settings" ? next.anchor : undefined);
    if (Number.isSafeInteger(next.selectedIndex))
      setSelectedIndex(next.selectedIndex);
    if (typeof next.filter === "string")
      setActivityFilter(next.filter);
    scheduleDestinationFocus(next);
  };
  const moveSection = (offset) => {
    const index = names.indexOf(section());
    navigate({
      section: names[(index + offset + names.length) % names.length]
    });
  };
  const selectRecommendation = (sourceIndex) => {
    const reviews = props.snapshot().projection?.index?.reviews ?? [];
    if (!reviews[sourceIndex])
      return;
    setSelectedIndex(sourceIndex);
    const adjacent = reviews[sourceIndex + 1]?.proposalId ?? reviews[sourceIndex - 1]?.proposalId;
    const ids = [reviews[sourceIndex].proposalId, adjacent].filter(Boolean).slice(0, 2);
    props.store.selectDetails(ids);
    setConfirmation(null);
    setRejectionReason(null);
    setRejectionText("");
    setTechnicalExpanded(false);
  };
  const moveRecommendation = (offset) => {
    const queue = recommendations().queue;
    if (!queue.length)
      return;
    const current = Math.max(0, queue.findIndex((item) => item.sourceIndex === selectedIndex()));
    const next = queue[(current + offset + queue.length) % queue.length].sourceIndex;
    selectRecommendation(next);
    recommendationNodes.get(next)?.focus();
  };
  const moveActivity = (offset) => {
    const entries = activity().activity;
    if (!entries.length)
      return;
    const next = (activityIndex() + offset + entries.length) % entries.length;
    setActivityIndex(next);
    activityNodes.get(next)?.focus();
  };
  const invoke = async (key, operation, requiresConfirmation = false) => {
    if (requiresConfirmation && confirmation() !== key) {
      setConfirmation(key);
      setFeedback(`Review the current state, then activate \u201CConfirm ${key.replaceAll("-", " ")}\u201D.`);
      return;
    }
    try {
      await operation();
      setConfirmation(null);
      setFeedback("Request submitted. Server validation and the persistent state below determine the outcome.");
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const requestPending = (action, subject) => props.snapshot().pending.some((entry) => entry.action === action && entry.subject === subject);
  const actionButton = (key, label, operation, requiresConfirmation = false, pendingRequest) => {
    const disabled = () => pendingRequest ? requestPending(pendingRequest.action, pendingRequest.subject) : false;
    const focus = focusHandlers(`action:${key}`);
    return (() => {
      var _el$7 = _$createElement("box"), _el$8 = _$createElement("text");
      _$insertNode(_el$7, _el$8);
      _$setProp(_el$7, "border", true);
      _$setProp(_el$7, "paddingLeft", 1);
      _$setProp(_el$7, "paddingRight", 1);
      _$setProp(_el$7, "onMouseUp", () => {
        if (!disabled())
          invoke(key, operation, requiresConfirmation);
      });
      _$setProp(_el$7, "onKeyDown", (event) => {
        if (!isActivationKey(event) || disabled())
          return;
        event.preventDefault();
        invoke(key, operation, requiresConfirmation);
      });
      _$insert(_el$8, () => focusMark(`action:${key}`), null);
      _$insert(_el$8, (() => {
        var _c$ = _$memo(() => !!disabled());
        return () => _c$() ? `${label} \xB7 Pending` : confirmation() === key ? `Confirm ${label}` : label;
      })(), null);
      _$effect((_p$) => {
        var _v$7 = focusId(`action:${key}`), _v$8 = !disabled(), _v$9 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$0 = focus.focused, _v$1 = focus.blurred, _v$10 = disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text;
        _v$7 !== _p$.e && (_p$.e = _$setProp(_el$7, "id", _v$7, _p$.e));
        _v$8 !== _p$.t && (_p$.t = _$setProp(_el$7, "focusable", _v$8, _p$.t));
        _v$9 !== _p$.a && (_p$.a = _$setProp(_el$7, "borderColor", _v$9, _p$.a));
        _v$0 !== _p$.o && (_p$.o = _$setProp(_el$7, "on:focused", _v$0, _p$.o));
        _v$1 !== _p$.i && (_p$.i = _$setProp(_el$7, "on:blurred", _v$1, _p$.i));
        _v$10 !== _p$.n && (_p$.n = _$setProp(_el$8, "fg", _v$10, _p$.n));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined
      });
      return _el$7;
    })();
  };
  const localActionButton = (label, operation, warning = false, confirmationKey, pendingRequest, focusKey) => {
    const disabled = () => pendingRequest ? requestPending(pendingRequest.action, pendingRequest.subject) : false;
    const key = `local:${focusKey ?? confirmationKey ?? label}`;
    const focus = focusHandlers(key);
    return (() => {
      var _el$9 = _$createElement("box"), _el$0 = _$createElement("text");
      _$insertNode(_el$9, _el$0);
      _$setProp(_el$9, "border", true);
      _$setProp(_el$9, "paddingLeft", 1);
      _$setProp(_el$9, "paddingRight", 1);
      _$setProp(_el$9, "onMouseUp", () => {
        if (!disabled())
          operation();
      });
      _$setProp(_el$9, "onKeyDown", (event) => {
        if (!isActivationKey(event) || disabled())
          return;
        event.preventDefault();
        operation();
      });
      _$insert(_el$0, () => focusMark(key), null);
      _$insert(_el$0, (() => {
        var _c$2 = _$memo(() => !!disabled());
        return () => _c$2() ? `${label} \xB7 Pending` : confirmation() === confirmationKey ? `Confirm ${label}` : label;
      })(), null);
      _$effect((_p$) => {
        var _v$11 = focusId(key), _v$12 = !disabled(), _v$13 = warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$14 = focus.focused, _v$15 = focus.blurred, _v$16 = disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text;
        _v$11 !== _p$.e && (_p$.e = _$setProp(_el$9, "id", _v$11, _p$.e));
        _v$12 !== _p$.t && (_p$.t = _$setProp(_el$9, "focusable", _v$12, _p$.t));
        _v$13 !== _p$.a && (_p$.a = _$setProp(_el$9, "borderColor", _v$13, _p$.a));
        _v$14 !== _p$.o && (_p$.o = _$setProp(_el$9, "on:focused", _v$14, _p$.o));
        _v$15 !== _p$.i && (_p$.i = _$setProp(_el$9, "on:blurred", _v$15, _p$.i));
        _v$16 !== _p$.n && (_p$.n = _$setProp(_el$0, "fg", _v$16, _p$.n));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined
      });
      return _el$9;
    })();
  };
  const paused = () => props.snapshot().dashboard?.settings?.paused === true;
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true;
  const home = () => model().sections.home;
  const recommendations = () => model().sections.recommendations;
  const activity = () => model().sections.activity;
  const settings = () => model().sections.settings;
  const settingsAnchorControl = (anchor) => {
    if (anchor === "modes" || anchor === "setup") {
      return `anchor:${anchor}`;
    }
    if (anchor === "emergency-stop") {
      return `action:${emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop"}`;
    }
    if (anchor === "project-scope") {
      return `action:${settings().projectExcluded ? "include-project" : "exclude-project"}`;
    }
    const consentKey = anchor === "passive-consent" ? "passiveCalls" : anchor === "observation-consent" ? "durableObservations" : null;
    if (consentKey) {
      const consent = settings().consent.find((entry) => entry.key === consentKey);
      return consent?.enabled ? `action:consent-${consentKey}-off` : `local:consent:${consentKey}`;
    }
    if (anchor === "approved-skill-folders")
      return "local:Add folder";
    if (anchor === "maintenance")
      return "local:Export selected scope";
    return `anchor:${anchor}`;
  };
  const scheduleDestinationFocus = (next) => {
    cancelDestinationFocus();
    const destinationCurrent = () => props.api.route.current.name === CONTROL_CENTER_ROUTE && section() === next.section;
    let targetId = focusId(`section:${next.section}`);
    if (next.section === "activity" && typeof next.filter === "string") {
      targetId = focusId(`activity-filter:${next.filter}`);
    } else if (next.section === "settings" && next.anchor) {
      targetId = focusId(settingsAnchorControl(next.anchor));
    } else if (next.section === "home" && home().firstRun) {
      targetId = focusId("action:automatic-recommendations");
    }
    const liveFocusable = (candidate) => Boolean(candidate && candidate.visible && candidate.focusable && controlCenterNode?.findDescendantById(candidate.id) === candidate) ? candidate : undefined;
    const destinationTarget = () => {
      if (!destinationCurrent())
        return;
      if (next.section === "recommendations" && Number.isSafeInteger(next.selectedIndex)) {
        return liveFocusable(recommendationNodes.get(next.selectedIndex));
      }
      return liveFocusable(controlCenterNode?.findDescendantById(targetId));
    };
    const fallbackTarget = () => {
      if (!destinationCurrent())
        return;
      return liveFocusable(controlCenterNode?.findDescendantById(focusId(`anchor:${next.anchor ?? "setup"}`))) ?? liveFocusable(controlCenterNode?.findDescendantById(focusId(`section:${next.section}`)));
    };
    let active = true;
    let watchedTarget;
    let mountGeneration = 0;
    let scrollGeneration = 0;
    const stop = () => {
      if (!active)
        return;
      active = false;
      mountGeneration += 1;
      scrollGeneration += 1;
      watchedTarget?.off("blurred", handleTargetBlurred);
      if (cancelDestinationFocus === stop) {
        cancelDestinationFocus = () => {};
        refreshDestinationFocus = () => {};
      }
    };
    const targetInView = (target) => Boolean(contentScrollbox && (() => {
      const viewport = contentScrollbox.viewport ?? contentScrollbox;
      const viewportBottom = viewport.screenY + viewport.height;
      if (target.height > viewport.height) {
        return target.screenY >= viewport.screenY && target.screenY < viewportBottom;
      }
      return target.screenY >= viewport.screenY && target.screenY + target.height <= viewportBottom;
    })());
    const settleTargetScroll = (target, generation, attempt = 0) => {
      requestAnimationFrame(() => {
        if (!active || generation !== scrollGeneration || watchedTarget !== target || destinationTarget() !== target || attempt >= MAX_DESTINATION_SCROLL_FRAMES)
          return;
        if (contentScrollbox?.findDescendantById(target.id)) {
          contentScrollbox.scrollChildIntoView(target.id);
        }
        requestAnimationFrame(() => {
          if (active && generation === scrollGeneration && watchedTarget === target && destinationTarget() === target && !targetInView(target)) {
            settleTargetScroll(target, generation, attempt + 1);
          }
        });
      });
    };
    const watchAndFocus = (target) => {
      if (watchedTarget !== target) {
        watchedTarget?.off("blurred", handleTargetBlurred);
        watchedTarget = target;
        watchedTarget.on("blurred", handleTargetBlurred);
      }
      target.focus();
    };
    const focusExactTarget = (target) => {
      watchAndFocus(target);
      if (contentScrollbox?.findDescendantById(target.id)) {
        contentScrollbox.scrollChildIntoView(target.id);
      }
      settleTargetScroll(target, ++scrollGeneration);
    };
    const focusDestination = () => {
      if (!active || !destinationCurrent()) {
        stop();
        return;
      }
      const target = destinationTarget();
      if (target) {
        focusExactTarget(target);
        return;
      }
      const fallback = fallbackTarget();
      if (fallback) {
        watchAndFocus(fallback);
        if (contentScrollbox?.findDescendantById(fallback.id)) {
          contentScrollbox.scrollChildIntoView(fallback.id);
        }
      }
    };
    const handleTargetBlurred = () => {
      if (!destinationCurrent()) {
        stop();
        return;
      }
      const current = watchedTarget?.ctx.currentFocusedRenderable;
      if (current == null || current === controlCenterNode || current.id === watchedTarget?.id) {
        focusDestination();
        return;
      }
      stop();
    };
    const refresh = () => {
      focusDestination();
      const generation = ++mountGeneration;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (active && generation === mountGeneration)
          focusDestination();
      }));
    };
    refreshDestinationFocus = refresh;
    cancelDestinationFocus = stop;
    refresh();
  };
  onMount(() => scheduleDestinationFocus(props.initial));
  createEffect(() => {
    props.snapshot();
    refreshDestinationFocus();
  });
  const retryProjection = async () => {
    const refreshed = await props.store.refresh();
    setFeedback(refreshed.phase === "error" ? "Retry did not restore a fresh projection. Read-only stale context remains available." : "Projection refreshed. Only newly negotiated actions are available.");
  };
  const modeRank = (value) => ({
    manual: 0,
    auto: 1,
    yolo: 2
  })[value ?? ""] ?? 0;
  const projectedModeFor = (target, scope) => {
    if (scope === "global")
      return target;
    return target === "inherit" ? settings().mode.global.value : target;
  };
  const submitMode = (scope, mode) => {
    if (mode === "yolo") {
      if (!settings().modes.find((entry) => entry.value === "yolo")?.available) {
        setFeedback("Apply automatically is unavailable until every listed prerequisite passes.");
        return;
      }
      setYoloTarget(scope);
      setYoloConfirmation("");
      setFeedback(`Type ENABLE YOLO to grant Apply automatically for the ${scope === "global" ? "global default" : "current project"}.`);
      return;
    }
    const current = scope === "global" ? settings().mode.global.value : settings().mode.effective.value;
    const riskIncreasing = modeRank(projectedModeFor(mode, scope)) > modeRank(current);
    const action = scope === "global" ? "set-mode" : "set-repo-mode";
    invoke(`${scope}-mode-${mode}`, () => props.store.submitControl(action, {
      mode
    }), riskIncreasing);
  };
  const enableAutomaticRecommendations = () => props.store.submitControl("set-mode", {
    mode: "auto"
  });
  const openConsentDisclosure = (key) => {
    setConsentIntent(key);
    setFeedback("Review the privacy disclosure, then confirm or cancel the consent change.");
  };
  const confirmConsent = async (key) => {
    await props.store.submitControl("set-consent", {
      key,
      enabled: true
    });
    await delay(0);
    setConsentIntent(null);
  };
  const consentDisclosure = (key) => _$createComponent(Show, {
    get when() {
      return _$memo(() => consentIntent() === key)() && settings().consent.find((entry) => entry.key === key);
    },
    children: (entry) => (() => {
      var _el$1 = _$createElement("box"), _el$10 = _$createElement("text"), _el$11 = _$createElement("b"), _el$13 = _$createElement("text"), _el$14 = _$createElement("text"), _el$15 = _$createElement("box");
      _$insertNode(_el$1, _el$10);
      _$insertNode(_el$1, _el$13);
      _$insertNode(_el$1, _el$14);
      _$insertNode(_el$1, _el$15);
      _$setProp(_el$1, "border", true);
      _$setProp(_el$1, "paddingLeft", 1);
      _$setProp(_el$1, "paddingRight", 1);
      _$setProp(_el$1, "flexDirection", "column");
      _$setProp(_el$1, "gap", 1);
      _$insertNode(_el$10, _el$11);
      _$insertNode(_el$11, _$createTextNode(`Consent disclosure`));
      _$setProp(_el$13, "wrapMode", "word");
      _$insert(_el$13, () => entry().description);
      _$setProp(_el$14, "wrapMode", "word");
      _$insert(_el$14, () => entry().dependency);
      _$setProp(_el$15, "flexDirection", "row");
      _$setProp(_el$15, "flexWrap", "wrap");
      _$setProp(_el$15, "gap", 1);
      _$insert(_el$15, () => actionButton(`confirm-consent-${key}`, `Confirm allow ${entry().label}`, () => confirmConsent(key), false, {
        action: "set-consent",
        subject: `consent:${key}`
      }), null);
      _$insert(_el$15, () => localActionButton("Cancel consent change", () => setConsentIntent(null), false, undefined, undefined, `cancel-consent:${key}`), null);
      _$effect((_p$) => {
        var _v$17 = props.api.theme.current.warning, _v$18 = props.api.theme.current.textMuted;
        _v$17 !== _p$.e && (_p$.e = _$setProp(_el$1, "borderColor", _v$17, _p$.e));
        _v$18 !== _p$.t && (_p$.t = _$setProp(_el$14, "fg", _v$18, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$1;
    })()
  });
  const confirmYolo = async () => {
    const target = yoloTarget();
    if (!target || yoloConfirmation() !== "ENABLE YOLO") {
      setFeedback("The exact phrase ENABLE YOLO is required.");
      return;
    }
    try {
      await props.store.submitControl(target === "global" ? "set-mode" : "set-repo-mode", target === "global" ? {
        mode: "yolo",
        allowlist: [...settings().approvedSkillFolders],
        confirmation: "ENABLE YOLO"
      } : {
        mode: "yolo"
      });
      setYoloTarget(null);
      setYoloConfirmation("");
      setFeedback("Apply automatically request submitted for fresh server-side prerequisite validation.");
    } catch (error) {
      setFeedback(`Apply automatically was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const stageFolderList = (next) => {
    if (next.length === 0 && settings().approvedSkillFolderRequiresNonEmpty) {
      setFolderError("At least one approved skill folder is required while Apply automatically is stored globally or for this project.");
      return;
    }
    setFolderDraft(next);
    setFolderConfirmation("");
    setFolderError(null);
    setFeedback("Review the exact folder list below, then type UPDATE ALLOWLIST.");
  };
  const stageFolderAdd = () => {
    const checked = validateApprovedSkillFolderInput(folderInput(), settings().approvedSkillFolders);
    if (!checked.ok) {
      setFolderError(checked.error);
      return;
    }
    setFolderInput("");
    stageFolderList([...settings().approvedSkillFolders, checked.value]);
    setFolderError(checked.warning);
  };
  const submitFolderList = async () => {
    const draft = folderDraft();
    if (!draft || folderConfirmation() !== "UPDATE ALLOWLIST") {
      setFolderError("The exact phrase UPDATE ALLOWLIST is required.");
      return;
    }
    try {
      await props.store.submitControl("update-allowlist", {
        allowlist: draft,
        confirmation: "UPDATE ALLOWLIST"
      });
      setFolderDraft(null);
      setFolderConfirmation("");
      setFolderError(null);
      setFeedback("Approved skill folder replacement submitted for canonical server revalidation.");
    } catch (error) {
      setFolderError(`Folder replacement was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const maintenancePhrase = () => maintenanceIntent() === "export" ? "EXPORT SENSITIVE SELF-EVOLVE DATA" : maintenanceScope() === "all" ? "PURGE ALL SELF-EVOLVE DATA" : `PURGE ${maintenanceScope().toUpperCase()}`;
  const submitMaintenance = async () => {
    const intent = maintenanceIntent();
    const scope = maintenanceScope();
    const phrase = maintenancePhrase();
    if (!intent || maintenanceConfirmation() !== phrase) {
      setFeedback(`The exact phrase ${phrase} is required.`);
      return;
    }
    try {
      if (intent === "export") {
        await props.store.submitOperation("export-data", {
          scope,
          confirmation: phrase
        });
      } else if (scope === "all") {
        await props.store.submitOperation("purge-all", {
          confirmation: phrase
        });
      } else {
        await props.store.submitOperation("purge-scope", {
          scope,
          confirmation: phrase
        });
      }
      setMaintenanceIntent(null);
      setMaintenanceConfirmation("");
      setFeedback(scope === "all" && intent === "delete" ? "Purge all was submitted. An accepted response is terminal and requires restarting OpenCode." : "Maintenance request submitted. Server validation and the mounted outcome determine completion.");
    } catch (error) {
      setFeedback(`Maintenance request was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const openActivityDestination = (entry) => {
    if (entry.destination?.section !== "recommendations")
      return;
    const sourceIndex = entry.destination.selectedIndex ?? 0;
    const state = props.snapshot().projection?.index?.reviews?.[sourceIndex]?.state;
    setRecommendationFilter(["applied", "rolled-back"].includes(state ?? "") ? "applied" : ["rejected", "superseded"].includes(state ?? "") ? "dismissed" : "needs-review");
    selectRecommendation(sourceIndex);
    navigate({
      section: "recommendations",
      selectedIndex: sourceIndex
    });
  };
  const selectedProposalId = () => {
    const sourceIndex = recommendations().selected?.sourceIndex;
    return Number.isSafeInteger(sourceIndex) ? props.snapshot().projection?.index?.reviews?.[sourceIndex]?.proposalId ?? null : null;
  };
  const pendingRecommendation = () => props.snapshot().pending.some((entry) => entry.subject === selectedProposalId());
  const activateRecommendation = async (action, snoozeMs) => {
    const proposalId = selectedProposalId();
    if (!proposalId || requestPending(action, proposalId))
      return;
    if (action === "open-activity") {
      navigate({
        section: "activity",
        filter: "recommendations"
      });
      return;
    }
    if (action === "acknowledge-audit") {
      const auditIds = (props.snapshot().dashboard?.activity ?? []).filter((entry) => entry.outcome === "applied" && entry.proposalId === proposalId).map((entry) => entry.id);
      props.store.acknowledgeAudits([...auditIds, proposalId]);
      setFeedback("Applied result acknowledged locally. Activity history was retained.");
      return;
    }
    const key = `${action}:${snoozeMs ?? ""}`;
    if (confirmation() !== key) {
      setConfirmation(key);
      setFeedback(`Activate \u201CConfirm ${action.replaceAll("-", " ")}\u201D to continue.`);
      return;
    }
    try {
      if (action === "apply-proposal") {
        await props.store.submitDecision({
          proposalId,
          newState: "approved"
        });
      } else if (action === "reject-proposal") {
        const reason = rejectionReason();
        const feedbackValue = reason === null ? undefined : {
          reason,
          text: reason === "other" ? rejectionText().trim() : null
        };
        if (reason === "other" && !feedbackValue.text) {
          setFeedback("Add a short Other reason before rejecting, or clear the optional feedback.");
          return;
        }
        await props.store.submitDecision({
          proposalId,
          newState: "rejected",
          ...feedbackValue ? {
            feedback: feedbackValue
          } : {}
        });
      } else if (action === "snooze-proposal") {
        await props.store.submitOperation("snooze-proposal", {
          snoozedUntil: Date.now() + (snoozeMs ?? 86400000)
        }, {
          proposalId
        });
      } else if (action === "rollback-proposal") {
        await props.store.submitOperation("rollback-proposal", {}, {
          proposalId
        });
      } else {
        throw new Error("unsupported-recommendation-action");
      }
      setConfirmation(null);
      setFeedback("Request submitted. Server validation and the mounted outcome determine completion.");
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (() => {
    var _el$16 = _$createElement("box"), _el$17 = _$createElement("box"), _el$18 = _$createElement("box"), _el$19 = _$createElement("text"), _el$20 = _$createElement("b"), _el$22 = _$createElement("text"), _el$23 = _$createTextNode(` \xB7 `), _el$24 = _$createElement("box"), _el$25 = _$createElement("scrollbox"), _el$189 = _$createElement("box"), _el$190 = _$createElement("text"), _el$191 = _$createTextNode(`Esc returns to `);
    _$insertNode(_el$16, _el$17);
    _$insertNode(_el$16, _el$24);
    _$insertNode(_el$16, _el$25);
    _$insertNode(_el$16, _el$189);
    _$use((value) => controlCenterNode = value, _el$16);
    _$setProp(_el$16, "id", CONTROL_CENTER_VIEW_ID);
    _$setProp(_el$16, "focusable", true);
    _$setProp(_el$16, "width", "100%");
    _$setProp(_el$16, "height", "100%");
    _$setProp(_el$16, "flexDirection", "column");
    _$insertNode(_el$17, _el$18);
    _$setProp(_el$17, "flexDirection", "row");
    _$setProp(_el$17, "gap", 1);
    _$setProp(_el$17, "flexWrap", "wrap");
    _$setProp(_el$17, "flexShrink", 0);
    _$setProp(_el$17, "overflow", "hidden");
    _$insertNode(_el$18, _el$19);
    _$insertNode(_el$18, _el$22);
    _$setProp(_el$18, "flexDirection", "column");
    _$setProp(_el$18, "flexGrow", 1);
    _$insertNode(_el$19, _el$20);
    _$insertNode(_el$20, _$createTextNode(`Self-evolve`));
    _$insertNode(_el$22, _el$23);
    _$setProp(_el$22, "wrapMode", "word");
    _$insert(_el$22, () => model().operational.label, _el$23);
    _$insert(_el$22, () => home().mode.effective.label, null);
    _$insert(_el$17, _$createComponent(Show, {
      get when() {
        return settings().controls.pause;
      },
      get children() {
        return actionButton(paused() ? "resume" : "pause", paused() ? "Resume" : "Pause", () => props.store.submitOperation("set-paused", {
          paused: !paused()
        }), false, {
          action: "set-paused",
          subject: "project"
        });
      }
    }), null);
    _$insert(_el$17, _$createComponent(Show, {
      get when() {
        return settings().controls.emergencyStop;
      },
      get children() {
        return actionButton(emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop", emergencyStop() ? "Turn off Emergency stop" : "Emergency stop", () => props.store.submitOperation("set-kill-switch", {
          enabled: !emergencyStop()
        }), emergencyStop(), {
          action: "set-kill-switch",
          subject: "project"
        });
      }
    }), null);
    _$setProp(_el$24, "flexDirection", "row");
    _$setProp(_el$24, "gap", 1);
    _$setProp(_el$24, "flexWrap", "wrap");
    _$setProp(_el$24, "flexShrink", 0);
    _$setProp(_el$24, "height", 3);
    _$setProp(_el$24, "overflow", "hidden");
    _$insert(_el$24, () => names.map((name) => (() => {
      var _el$193 = _$createElement("box"), _el$194 = _$createElement("text");
      _$insertNode(_el$193, _el$194);
      _$setProp(_el$193, "focusable", true);
      _$setProp(_el$193, "border", true);
      _$setProp(_el$193, "paddingLeft", 1);
      _$setProp(_el$193, "paddingRight", 1);
      _$setProp(_el$193, "on:focused", () => setFocusedControl(`section:${name}`));
      _$setProp(_el$193, "on:blurred", () => setFocusedControl((current) => current === `section:${name}` ? null : current));
      _$setProp(_el$193, "onMouseUp", () => navigate({
        section: name
      }));
      _$setProp(_el$193, "onKeyDown", (event) => {
        if (isActivationKey(event)) {
          event.preventDefault();
          navigate({
            section: name
          });
        } else if (event.name === "left") {
          event.preventDefault();
          moveSection(-1);
        } else if (event.name === "right") {
          event.preventDefault();
          moveSection(1);
        }
      });
      _$insert(_el$194, () => focusMark(`section:${name}`), null);
      _$insert(_el$194, () => name.charAt(0).toUpperCase() + name.slice(1), null);
      _$insert(_el$194, (() => {
        var _c$5 = _$memo(() => !!(name === "recommendations" && model().operational.count > 0));
        return () => _c$5() ? ` (${model().operational.count})` : "";
      })(), null);
      _$effect((_p$) => {
        var _v$39 = focusId(`section:${name}`), _v$40 = section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$41 = section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted;
        _v$39 !== _p$.e && (_p$.e = _$setProp(_el$193, "id", _v$39, _p$.e));
        _v$40 !== _p$.t && (_p$.t = _$setProp(_el$193, "borderColor", _v$40, _p$.t));
        _v$41 !== _p$.a && (_p$.a = _$setProp(_el$194, "fg", _v$41, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$193;
    })()));
    _$use((value) => contentScrollbox = value, _el$25);
    _$setProp(_el$25, "flexGrow", 1);
    _$setProp(_el$25, "minHeight", 1);
    _$setProp(_el$25, "width", "100%");
    _$setProp(_el$25, "onMouseScroll", () => cancelDestinationFocus());
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return model().recovery;
      },
      children: (recovery) => (() => {
        var _el$195 = _$createElement("box"), _el$196 = _$createElement("text"), _el$197 = _$createElement("b"), _el$198 = _$createElement("text"), _el$199 = _$createTextNode(`Latest refresh failed: `), _el$200 = _$createElement("text");
        _$insertNode(_el$195, _el$196);
        _$insertNode(_el$195, _el$198);
        _$insertNode(_el$195, _el$200);
        _$setProp(_el$195, "border", true);
        _$setProp(_el$195, "paddingLeft", 1);
        _$setProp(_el$195, "paddingRight", 1);
        _$setProp(_el$195, "flexDirection", "column");
        _$setProp(_el$195, "gap", 1);
        _$insertNode(_el$196, _el$197);
        _$insert(_el$197, () => recovery().stale ? "Read-only stale snapshot" : "Projection unavailable");
        _$insertNode(_el$198, _el$199);
        _$setProp(_el$198, "wrapMode", "word");
        _$insert(_el$198, () => recovery().diagnostic, null);
        _$insertNode(_el$200, _$createTextNode(`Decision, control, and operation actions are unavailable until a fresh projection is negotiated.`));
        _$setProp(_el$200, "wrapMode", "word");
        _$insert(_el$195, _$createComponent(Show, {
          get when() {
            return recovery().canRetry;
          },
          get children() {
            return localActionButton("Retry", () => void retryProjection());
          }
        }), null);
        _$effect((_p$) => {
          var _v$42 = props.api.theme.current.error, _v$43 = props.api.theme.current.textMuted;
          _v$42 !== _p$.e && (_p$.e = _$setProp(_el$195, "borderColor", _v$42, _p$.e));
          _v$43 !== _p$.t && (_p$.t = _$setProp(_el$200, "fg", _v$43, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$195;
      })()
    }), null);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return section() === "home";
      },
      get children() {
        var _el$26 = _$createElement("box"), _el$27 = _$createElement("text"), _el$28 = _$createElement("b"), _el$30 = _$createElement("text"), _el$31 = _$createElement("b"), _el$32 = _$createElement("text"), _el$33 = _$createElement("text"), _el$34 = _$createElement("box"), _el$35 = _$createElement("text"), _el$36 = _$createElement("b"), _el$38 = _$createElement("text"), _el$39 = _$createTextNode(`Effective: `), _el$40 = _$createElement("text"), _el$41 = _$createTextNode(`Global default: `), _el$42 = _$createElement("text"), _el$43 = _$createTextNode(`This project: `), _el$67 = _$createElement("text");
        _$insertNode(_el$26, _el$27);
        _$insertNode(_el$26, _el$30);
        _$insertNode(_el$26, _el$32);
        _$insertNode(_el$26, _el$33);
        _$insertNode(_el$26, _el$34);
        _$insertNode(_el$26, _el$67);
        _$setProp(_el$26, "flexDirection", "column");
        _$setProp(_el$26, "gap", 1);
        _$insertNode(_el$27, _el$28);
        _$insertNode(_el$28, _$createTextNode(`Home`));
        _$insertNode(_el$30, _el$31);
        _$insert(_el$31, () => home().operational.label);
        _$setProp(_el$32, "wrapMode", "word");
        _$insert(_el$32, () => home().operational.explanation);
        _$setProp(_el$33, "wrapMode", "word");
        _$insert(_el$33, () => home().operational.nextAction);
        _$insertNode(_el$34, _el$35);
        _$insertNode(_el$34, _el$38);
        _$insertNode(_el$34, _el$40);
        _$insertNode(_el$34, _el$42);
        _$setProp(_el$34, "border", true);
        _$setProp(_el$34, "paddingLeft", 1);
        _$setProp(_el$34, "paddingRight", 1);
        _$setProp(_el$34, "flexDirection", "column");
        _$insertNode(_el$35, _el$36);
        _$insertNode(_el$36, _$createTextNode(`Mode and scope`));
        _$insertNode(_el$38, _el$39);
        _$setProp(_el$38, "wrapMode", "word");
        _$insert(_el$38, () => home().mode.effective.label, null);
        _$insertNode(_el$40, _el$41);
        _$setProp(_el$40, "wrapMode", "word");
        _$insert(_el$40, () => home().mode.global.label, null);
        _$insertNode(_el$42, _el$43);
        _$setProp(_el$42, "wrapMode", "word");
        _$insert(_el$42, () => home().mode.repository.label, null);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().firstRun;
          },
          get children() {
            var _el$44 = _$createElement("box"), _el$45 = _$createElement("text"), _el$46 = _$createElement("b"), _el$48 = _$createElement("text"), _el$52 = _$createElement("text"), _el$53 = _$createElement("b"), _el$55 = _$createElement("text");
            _$insertNode(_el$44, _el$45);
            _$insertNode(_el$44, _el$48);
            _$insertNode(_el$44, _el$52);
            _$insertNode(_el$44, _el$55);
            _$setProp(_el$44, "border", true);
            _$setProp(_el$44, "paddingLeft", 1);
            _$setProp(_el$44, "paddingRight", 1);
            _$setProp(_el$44, "flexDirection", "column");
            _$setProp(_el$44, "gap", 1);
            _$insertNode(_el$45, _el$46);
            _$insertNode(_el$46, _$createTextNode(`Get automatic recommendations`));
            _$insertNode(_el$48, _$createTextNode(`Choose proactive review without granting automatic writes or privacy consent. Background AI analysis and saved structured patterns remain separate consent gates in Settings.`));
            _$setProp(_el$48, "wrapMode", "word");
            _$insert(_el$44, _$createComponent(Show, {
              get when() {
                return settings().controls.globalMode;
              },
              get children() {
                return actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true, {
                  action: "set-mode",
                  subject: "global-mode"
                });
              }
            }), _el$52);
            _$insert(_el$44, _$createComponent(Show, {
              get when() {
                return !settings().controls.globalMode;
              },
              get children() {
                var _el$50 = _$createElement("text");
                _$insertNode(_el$50, _$createTextNode(`Controls are unavailable until the aligned server publishes fresh authority.`));
                _$effect((_$p) => _$setProp(_el$50, "fg", props.api.theme.current.textMuted, _$p));
                return _el$50;
              }
            }), _el$52);
            _$insertNode(_el$52, _el$53);
            _$insertNode(_el$53, _$createTextNode(`Optional evidence excerpts`));
            _$insertNode(_el$55, _$createTextNode(`Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations.`));
            _$setProp(_el$55, "wrapMode", "word");
            _$insert(_el$44, _$createComponent(Show, {
              get when() {
                return settings().controls.consent;
              },
              get children() {
                return localActionButton("Review consent for Sanitized evidence excerpts", () => openConsentDisclosure("sanitizedExcerpts"));
              }
            }), null);
            _$insert(_el$44, _$createComponent(Show, {
              get when() {
                return !settings().controls.consent;
              },
              get children() {
                var _el$57 = _$createElement("text");
                _$insertNode(_el$57, _$createTextNode(`Excerpt consent can be changed later in Settings.`));
                _$effect((_$p) => _$setProp(_el$57, "fg", props.api.theme.current.textMuted, _$p));
                return _el$57;
              }
            }), null);
            _$insert(_el$44, () => consentDisclosure("sanitizedExcerpts"), null);
            _$effect((_$p) => _$setProp(_el$44, "borderColor", props.api.theme.current.info, _$p));
            return _el$44;
          }
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().blockers.length;
          },
          get children() {
            var _el$59 = _$createElement("box"), _el$60 = _$createElement("text"), _el$61 = _$createElement("b");
            _$insertNode(_el$59, _el$60);
            _$setProp(_el$59, "flexDirection", "column");
            _$insertNode(_el$60, _el$61);
            _$insertNode(_el$61, _$createTextNode(`Setup`));
            _$insert(_el$59, () => reactiveChild(() => home().blockers.map((blocker) => (() => {
              var _el$202 = _$createElement("box"), _el$203 = _$createElement("text"), _el$204 = _$createTextNode(` \xB7 Open `);
              _$insertNode(_el$202, _el$203);
              _$setProp(_el$202, "focusable", true);
              _$setProp(_el$202, "border", true);
              _$setProp(_el$202, "paddingLeft", 1);
              _$setProp(_el$202, "paddingRight", 1);
              _$setProp(_el$202, "on:focused", () => setFocusedControl(`blocker:${blocker.code}`));
              _$setProp(_el$202, "on:blurred", () => setFocusedControl((current) => current === `blocker:${blocker.code}` ? null : current));
              _$setProp(_el$202, "onMouseUp", () => navigate(blocker.destination));
              _$setProp(_el$202, "onKeyDown", (event) => {
                if (!isActivationKey(event))
                  return;
                event.preventDefault();
                navigate(blocker.destination);
              });
              _$insertNode(_el$203, _el$204);
              _$setProp(_el$203, "wrapMode", "word");
              _$insert(_el$203, () => focusMark(`blocker:${blocker.code}`), _el$204);
              _$insert(_el$203, () => blocker.summary, _el$204);
              _$insert(_el$203, (() => {
                var _c$6 = _$memo(() => blocker.destination.section === "activity");
                return () => _c$6() ? "Activity errors" : blocker.destination.section.charAt(0).toUpperCase() + blocker.destination.section.slice(1);
              })(), null);
              _$effect((_$p) => _$setProp(_el$202, "borderColor", props.api.theme.current.warning, _$p));
              return _el$202;
            })())), null);
            return _el$59;
          }
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().lastCycle;
          },
          children: (lastCycle) => (() => {
            var _el$205 = _$createElement("box"), _el$206 = _$createElement("text"), _el$207 = _$createElement("b"), _el$209 = _$createElement("text"), _el$210 = _$createTextNode(` \xB7 `), _el$211 = _$createTextNode(` observations \xB7 `), _el$212 = _$createTextNode(` eligible`);
            _$insertNode(_el$205, _el$206);
            _$insertNode(_el$205, _el$209);
            _$setProp(_el$205, "flexDirection", "column");
            _$insertNode(_el$206, _el$207);
            _$insertNode(_el$207, _$createTextNode(`Last cycle`));
            _$insertNode(_el$209, _el$210);
            _$insertNode(_el$209, _el$211);
            _$insertNode(_el$209, _el$212);
            _$setProp(_el$209, "wrapMode", "word");
            _$insert(_el$209, () => lastCycle().outcome.replaceAll("-", " "), _el$210);
            _$insert(_el$209, () => lastCycle().observationCount, _el$211);
            _$insert(_el$209, () => lastCycle().eligibilityCount, _el$212);
            return _el$205;
          })()
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().attention;
          },
          children: (attention) => (() => {
            var _el$213 = _$createElement("box"), _el$214 = _$createElement("text"), _el$215 = _$createTextNode(` `), _el$216 = _$createTextNode(` needs attention`);
            _$insertNode(_el$213, _el$214);
            _$setProp(_el$213, "focusable", true);
            _$setProp(_el$213, "border", true);
            _$setProp(_el$213, "paddingLeft", 1);
            _$setProp(_el$213, "paddingRight", 1);
            _$setProp(_el$213, "on:focused", () => setFocusedControl("home:attention"));
            _$setProp(_el$213, "on:blurred", () => setFocusedControl((current) => current === "home:attention" ? null : current));
            _$setProp(_el$213, "onMouseUp", () => navigate(attention().destination));
            _$setProp(_el$213, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              navigate(attention().destination);
            });
            _$insertNode(_el$214, _el$215);
            _$insertNode(_el$214, _el$216);
            _$insert(_el$214, () => focusMark("home:attention"), _el$215);
            _$insert(_el$214, () => attention().count, _el$215);
            _$insert(_el$214, () => attention().kind === "applied" ? "applied change" : "recommendation", _el$216);
            _$effect((_p$) => {
              var _v$44 = focusId("home:attention"), _v$45 = props.api.theme.current.warning;
              _v$44 !== _p$.e && (_p$.e = _$setProp(_el$213, "id", _v$44, _p$.e));
              _v$45 !== _p$.t && (_p$.t = _$setProp(_el$213, "borderColor", _v$45, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$213;
          })()
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().usage;
          },
          children: (usage) => (() => {
            var _el$217 = _$createElement("box"), _el$218 = _$createElement("text"), _el$219 = _$createElement("b"), _el$221 = _$createElement("text"), _el$222 = _$createTextNode(`Background analysis: `), _el$223 = _$createTextNode(` / `), _el$224 = _$createElement("text"), _el$225 = _$createTextNode(`Recommendation synthesis: `), _el$226 = _$createTextNode(` / `), _el$227 = _$createElement("text"), _el$228 = _$createTextNode(`Storage: `), _el$229 = _$createTextNode(` / `), _el$230 = _$createTextNode(` bytes`);
            _$insertNode(_el$217, _el$218);
            _$insertNode(_el$217, _el$221);
            _$insertNode(_el$217, _el$224);
            _$insertNode(_el$217, _el$227);
            _$setProp(_el$217, "flexDirection", "column");
            _$insertNode(_el$218, _el$219);
            _$insertNode(_el$219, _$createTextNode(`Actual usage`));
            _$insertNode(_el$221, _el$222);
            _$insertNode(_el$221, _el$223);
            _$insert(_el$221, () => usage().passive.used, _el$223);
            _$insert(_el$221, () => usage().passive.limit, null);
            _$insertNode(_el$224, _el$225);
            _$insertNode(_el$224, _el$226);
            _$insert(_el$224, () => usage().synthesis.used, _el$226);
            _$insert(_el$224, () => usage().synthesis.limit, null);
            _$insertNode(_el$227, _el$228);
            _$insertNode(_el$227, _el$229);
            _$insertNode(_el$227, _el$230);
            _$insert(_el$227, () => usage().storage.usedBytes, _el$229);
            _$insert(_el$227, () => usage().storage.limitBytes, _el$230);
            return _el$217;
          })()
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().recentActivity.length;
          },
          get children() {
            var _el$63 = _$createElement("box"), _el$64 = _$createElement("text"), _el$65 = _$createElement("b");
            _$insertNode(_el$63, _el$64);
            _$setProp(_el$63, "flexDirection", "column");
            _$insertNode(_el$64, _el$65);
            _$insertNode(_el$65, _$createTextNode(`Recent activity`));
            _$insert(_el$63, () => reactiveChild(() => home().recentActivity.map((entry) => (() => {
              var _el$231 = _$createElement("text"), _el$232 = _$createTextNode(`[`), _el$233 = _$createTextNode(`] `);
              _$insertNode(_el$231, _el$232);
              _$insertNode(_el$231, _el$233);
              _$setProp(_el$231, "wrapMode", "word");
              _$insert(_el$231, () => entry.marker, _el$233);
              _$insert(_el$231, () => entry.summary, null);
              return _el$231;
            })())), null);
            return _el$63;
          }
        }), _el$67);
        _$insert(_el$26, _$createComponent(Show, {
          get when() {
            return home().emptyState;
          },
          children: (emptyState) => (() => {
            var _el$234 = _$createElement("box"), _el$235 = _$createElement("text"), _el$236 = _$createElement("b"), _el$237 = _$createElement("text");
            _$insertNode(_el$234, _el$235);
            _$insertNode(_el$234, _el$237);
            _$setProp(_el$234, "flexDirection", "column");
            _$insertNode(_el$235, _el$236);
            _$insert(_el$236, () => emptyState().heading);
            _$setProp(_el$237, "wrapMode", "word");
            _$insert(_el$237, () => emptyState().explanation);
            return _el$234;
          })()
        }), _el$67);
        _$setProp(_el$67, "wrapMode", "word");
        _$insert(_el$67, () => home().manualFallback);
        _$effect((_p$) => {
          var _v$19 = props.api.theme.current.text, _v$20 = props.api.theme.current.textMuted, _v$21 = props.api.theme.current.borderSubtle, _v$22 = props.api.theme.current.textMuted;
          _v$19 !== _p$.e && (_p$.e = _$setProp(_el$30, "fg", _v$19, _p$.e));
          _v$20 !== _p$.t && (_p$.t = _$setProp(_el$33, "fg", _v$20, _p$.t));
          _v$21 !== _p$.a && (_p$.a = _$setProp(_el$34, "borderColor", _v$21, _p$.a));
          _v$22 !== _p$.o && (_p$.o = _$setProp(_el$67, "fg", _v$22, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$26;
      }
    }), null);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return section() === "recommendations";
      },
      get children() {
        var _el$68 = _$createElement("box"), _el$69 = _$createElement("text"), _el$70 = _$createElement("b"), _el$72 = _$createElement("box");
        _$insertNode(_el$68, _el$69);
        _$insertNode(_el$68, _el$72);
        _$setProp(_el$68, "flexDirection", "column");
        _$setProp(_el$68, "gap", 1);
        _$insertNode(_el$69, _el$70);
        _$insertNode(_el$70, _$createTextNode(`Recommendations`));
        _$setProp(_el$72, "flexDirection", "row");
        _$setProp(_el$72, "gap", 1);
        _$setProp(_el$72, "flexWrap", "wrap");
        _$insert(_el$72, () => [["needs-review", "Needs review"], ["applied", "Applied"], ["dismissed", "Dismissed"], ["all", "All"]].map(([value, label]) => (() => {
          var _el$238 = _$createElement("box"), _el$239 = _$createElement("text");
          _$insertNode(_el$238, _el$239);
          _$setProp(_el$238, "focusable", true);
          _$setProp(_el$238, "border", true);
          _$setProp(_el$238, "paddingLeft", 1);
          _$setProp(_el$238, "paddingRight", 1);
          _$setProp(_el$238, "on:focused", () => setFocusedControl(`recommendation-filter:${value}`));
          _$setProp(_el$238, "on:blurred", () => setFocusedControl((current) => current === `recommendation-filter:${value}` ? null : current));
          _$setProp(_el$238, "onMouseUp", () => {
            setRecommendationFilter(value);
            const first = buildControlCenterModel(props.snapshot(), {
              recommendationFilter: value
            }).sections.recommendations.queue[0];
            if (first)
              selectRecommendation(first.sourceIndex);
          });
          _$setProp(_el$238, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setRecommendationFilter(value);
            const first = buildControlCenterModel(props.snapshot(), {
              recommendationFilter: value
            }).sections.recommendations.queue[0];
            if (first)
              selectRecommendation(first.sourceIndex);
          });
          _$insert(_el$239, () => focusMark(`recommendation-filter:${value}`), null);
          _$insert(_el$239, label, null);
          _$effect((_p$) => {
            var _v$46 = focusId(`recommendation-filter:${value}`), _v$47 = recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$46 !== _p$.e && (_p$.e = _$setProp(_el$238, "id", _v$46, _p$.e));
            _v$47 !== _p$.t && (_p$.t = _$setProp(_el$238, "borderColor", _v$47, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$238;
        })()));
        _$insert(_el$68, _$createComponent(Show, {
          get when() {
            return recommendations().emptyState;
          },
          get children() {
            var _el$73 = _$createElement("text");
            _$insert(_el$73, () => recommendations().emptyState);
            return _el$73;
          }
        }), null);
        _$insert(_el$68, () => reactiveChild(() => recommendations().queue.map((item, index) => (() => {
          var _el$240 = _$createElement("box"), _el$241 = _$createElement("text"), _el$242 = _$createTextNode(` \xB7 `), _el$243 = _$createTextNode(` \xB7 `), _el$244 = _$createElement("text"), _el$245 = _$createElement("text"), _el$246 = _$createTextNode(`Risk: `), _el$247 = _$createTextNode(` \xB7 Evidence: `);
          _$insertNode(_el$240, _el$241);
          _$insertNode(_el$240, _el$244);
          _$insertNode(_el$240, _el$245);
          _$use((value) => recommendationNodes.set(item.sourceIndex, value), _el$240);
          _$setProp(_el$240, "focusable", true);
          _$setProp(_el$240, "border", true);
          _$setProp(_el$240, "paddingLeft", 1);
          _$setProp(_el$240, "paddingRight", 1);
          _$setProp(_el$240, "flexDirection", "column");
          _$setProp(_el$240, "on:focused", () => {
            setFocusedControl(`recommendation-row:${item.sourceIndex}`);
            selectRecommendation(item.sourceIndex);
          });
          _$setProp(_el$240, "on:blurred", () => setFocusedControl((current) => current === `recommendation-row:${item.sourceIndex}` ? null : current));
          _$setProp(_el$240, "onMouseUp", () => {
            selectRecommendation(item.sourceIndex);
            recommendationNodes.get(item.sourceIndex)?.focus();
          });
          _$setProp(_el$240, "onKeyDown", (event) => {
            if (isActivationKey(event)) {
              event.preventDefault();
              selectRecommendation(item.sourceIndex);
            } else if (event.name === "up") {
              event.preventDefault();
              moveRecommendation(-1);
            } else if (event.name === "down") {
              event.preventDefault();
              moveRecommendation(1);
            }
          });
          _$insertNode(_el$241, _el$242);
          _$insertNode(_el$241, _el$243);
          _$setProp(_el$241, "wrapMode", "word");
          _$insert(_el$241, () => focusMark(`recommendation-row:${item.sourceIndex}`), _el$242);
          _$insert(_el$241, (() => {
            var _c$7 = _$memo(() => item.attention === "critical");
            return () => _c$7() ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "";
          })(), _el$242);
          _$insert(_el$241, () => item.target, _el$242);
          _$insert(_el$241, () => item.state.replaceAll("-", " "), _el$243);
          _$insert(_el$241, () => relativeTime(item.updatedAt), null);
          _$setProp(_el$244, "wrapMode", "word");
          _$insert(_el$244, () => item.rationale);
          _$insertNode(_el$245, _el$246);
          _$insertNode(_el$245, _el$247);
          _$insert(_el$245, () => item.risk ?? "Loading", _el$247);
          _$insert(_el$245, () => item.evidenceCount ?? "Loading", null);
          _$effect((_p$) => {
            var _v$48 = focusId(`recommendation-row:${item.sourceIndex}`), _v$49 = recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$50 = props.api.theme.current.textMuted, _v$51 = props.api.theme.current.textMuted;
            _v$48 !== _p$.e && (_p$.e = _$setProp(_el$240, "id", _v$48, _p$.e));
            _v$49 !== _p$.t && (_p$.t = _$setProp(_el$240, "borderColor", _v$49, _p$.t));
            _v$50 !== _p$.a && (_p$.a = _$setProp(_el$244, "fg", _v$50, _p$.a));
            _v$51 !== _p$.o && (_p$.o = _$setProp(_el$245, "fg", _v$51, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$240;
        })())), null);
        _$insert(_el$68, _$createComponent(Show, {
          get when() {
            return recommendations().selected;
          },
          children: (selected) => (() => {
            var _el$248 = _$createElement("box"), _el$249 = _$createElement("text"), _el$250 = _$createElement("b"), _el$258 = _$createElement("box"), _el$259 = _$createElement("box"), _el$260 = _$createElement("text"), _el$261 = _$createTextNode(`Open in Activity`);
            _$insertNode(_el$248, _el$249);
            _$insertNode(_el$248, _el$258);
            _$setProp(_el$248, "border", true);
            _$setProp(_el$248, "paddingLeft", 1);
            _$setProp(_el$248, "paddingRight", 1);
            _$setProp(_el$248, "flexDirection", "column");
            _$setProp(_el$248, "gap", 1);
            _$insertNode(_el$249, _el$250);
            _$insert(_el$250, () => selected().target);
            _$insert(_el$248, _$createComponent(Show, {
              get when() {
                return selected().loading;
              },
              get children() {
                var _el$251 = _$createElement("text");
                _$insertNode(_el$251, _$createTextNode(`Loading authoritative recommendation detail\u2026`));
                return _el$251;
              }
            }), _el$258);
            _$insert(_el$248, _$createComponent(Show, {
              get when() {
                return selected().summary;
              },
              children: (summary) => [(() => {
                var _el$264 = _$createElement("box"), _el$265 = _$createElement("text"), _el$266 = _$createElement("b"), _el$268 = _$createElement("text");
                _$insertNode(_el$264, _el$265);
                _$insertNode(_el$264, _el$268);
                _$setProp(_el$264, "flexDirection", "column");
                _$insertNode(_el$265, _el$266);
                _$insertNode(_el$266, _$createTextNode(`Why this was suggested`));
                _$setProp(_el$268, "wrapMode", "word");
                _$insert(_el$268, () => summary().rationale);
                return _el$264;
              })(), (() => {
                var _el$269 = _$createElement("box"), _el$270 = _$createElement("text"), _el$271 = _$createElement("b");
                _$insertNode(_el$269, _el$270);
                _$setProp(_el$269, "flexDirection", "column");
                _$insertNode(_el$270, _el$271);
                _$insertNode(_el$271, _$createTextNode(`Proposed change`));
                _$insert(_el$269, () => reactiveChild(() => selected().diff?.lines.map((line) => (() => {
                  var _el$312 = _$createElement("text");
                  _$setProp(_el$312, "wrapMode", "word");
                  _$insert(_el$312, line);
                  return _el$312;
                })()) ?? []), null);
                _$insert(_el$269, _$createComponent(Show, {
                  get when() {
                    return selected().diff?.overflow?.truncated;
                  },
                  get children() {
                    var _el$273 = _$createElement("text");
                    _$insertNode(_el$273, _$createTextNode(`The proposed change was truncated by the bounded projection.`));
                    _$effect((_$p) => _$setProp(_el$273, "fg", props.api.theme.current.warning, _$p));
                    return _el$273;
                  }
                }), null);
                return _el$269;
              })(), (() => {
                var _el$275 = _$createElement("box"), _el$276 = _$createElement("text"), _el$277 = _$createElement("b");
                _$insertNode(_el$275, _el$276);
                _$setProp(_el$275, "flexDirection", "column");
                _$insertNode(_el$276, _el$277);
                _$insertNode(_el$277, _$createTextNode(`Evidence`));
                _$insert(_el$275, () => reactiveChild(() => selected().evidence.map((entry) => (() => {
                  var _el$313 = _$createElement("text"), _el$314 = _$createTextNode(`: `);
                  _$insertNode(_el$313, _el$314);
                  _$setProp(_el$313, "wrapMode", "word");
                  _$insert(_el$313, () => entry.kind, _el$314);
                  _$insert(_el$313, () => entry.summary, null);
                  _$insert(_el$313, () => entry.redacted ? " [redacted]" : "", null);
                  return _el$313;
                })())), null);
                _$insert(_el$275, _$createComponent(Show, {
                  get when() {
                    return !selected().evidence.length;
                  },
                  get children() {
                    var _el$279 = _$createElement("text");
                    _$insertNode(_el$279, _$createTextNode(`No bounded evidence detail is loaded.`));
                    return _el$279;
                  }
                }), null);
                return _el$275;
              })(), (() => {
                var _el$281 = _$createElement("box"), _el$282 = _$createElement("text"), _el$283 = _$createElement("b"), _el$285 = _$createElement("text"), _el$286 = _$createTextNode(`Critic: `), _el$287 = _$createElement("text"), _el$288 = _$createTextNode(`Deterministic checks: `), _el$289 = _$createElement("text"), _el$290 = _$createTextNode(`Injection scan: `);
                _$insertNode(_el$281, _el$282);
                _$insertNode(_el$281, _el$285);
                _$insertNode(_el$281, _el$287);
                _$insertNode(_el$281, _el$289);
                _$setProp(_el$281, "flexDirection", "column");
                _$insertNode(_el$282, _el$283);
                _$insertNode(_el$283, _$createTextNode(`Safety checks`));
                _$insertNode(_el$285, _el$286);
                _$insert(_el$285, () => summary().criticPassed ? "Passed" : "Not passed", null);
                _$insertNode(_el$287, _el$288);
                _$insert(_el$287, () => summary().validDeterministic ? "Passed" : "Not passed", null);
                _$insertNode(_el$289, _el$290);
                _$insert(_el$289, () => summary().injectionFlagged ? "Flagged" : "Clear", null);
                _$insert(_el$281, () => reactiveChild(() => summary().eligibility.checks.map((check) => (() => {
                  var _el$315 = _$createElement("text"), _el$316 = _$createTextNode(`[`), _el$317 = _$createTextNode(`] `), _el$318 = _$createTextNode(`: `), _el$319 = _$createTextNode(` / `);
                  _$insertNode(_el$315, _el$316);
                  _$insertNode(_el$315, _el$317);
                  _$insertNode(_el$315, _el$318);
                  _$insertNode(_el$315, _el$319);
                  _$setProp(_el$315, "wrapMode", "word");
                  _$insert(_el$315, () => check.met ? "Passed" : "Blocked", _el$317);
                  _$insert(_el$315, () => check.name, _el$318);
                  _$insert(_el$315, () => check.actual, _el$319);
                  _$insert(_el$315, () => check.required, null);
                  return _el$315;
                })())), null);
                return _el$281;
              })(), (() => {
                var _el$291 = _$createElement("box"), _el$292 = _$createElement("text"), _el$293 = _$createElement("b"), _el$295 = _$createElement("text"), _el$296 = _$createTextNode(` estimated / `), _el$297 = _$createTextNode(` budgeted tokens`);
                _$insertNode(_el$291, _el$292);
                _$insertNode(_el$291, _el$295);
                _$setProp(_el$291, "flexDirection", "column");
                _$insertNode(_el$292, _el$293);
                _$insertNode(_el$293, _$createTextNode(`Token impact`));
                _$insertNode(_el$295, _el$296);
                _$insertNode(_el$295, _el$297);
                _$insert(_el$295, () => summary().tokenImpact.estimatedTokens, _el$296);
                _$insert(_el$295, () => summary().tokenImpact.budgetTokens, _el$297);
                return _el$291;
              })(), (() => {
                var _el$298 = _$createElement("box"), _el$299 = _$createElement("text"), _el$300 = _$createElement("b"), _el$302 = _$createElement("text");
                _$insertNode(_el$298, _el$299);
                _$insertNode(_el$298, _el$302);
                _$setProp(_el$298, "flexDirection", "column");
                _$insertNode(_el$299, _el$300);
                _$insertNode(_el$300, _$createTextNode(`Rollback`));
                _$insert(_el$302, (() => {
                  var _c$8 = _$memo(() => !!summary().rollback.eligible);
                  return () => _c$8() ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`;
                })());
                return _el$298;
              })(), (() => {
                var _el$303 = _$createElement("box"), _el$304 = _$createElement("text"), _el$305 = _$createTextNode(`Technical details `);
                _$insertNode(_el$303, _el$304);
                _$setProp(_el$303, "focusable", true);
                _$setProp(_el$303, "border", true);
                _$setProp(_el$303, "paddingLeft", 1);
                _$setProp(_el$303, "paddingRight", 1);
                _$setProp(_el$303, "on:focused", () => setFocusedControl("recommendation:technical"));
                _$setProp(_el$303, "on:blurred", () => setFocusedControl((current) => current === "recommendation:technical" ? null : current));
                _$setProp(_el$303, "onMouseUp", () => setTechnicalExpanded((value) => !value));
                _$setProp(_el$303, "onKeyDown", (event) => {
                  if (!isActivationKey(event))
                    return;
                  event.preventDefault();
                  setTechnicalExpanded((value) => !value);
                });
                _$insertNode(_el$304, _el$305);
                _$insert(_el$304, () => focusMark("recommendation:technical"), _el$305);
                _$insert(_el$304, () => technicalExpanded() ? "\u25B2" : "\u25BC", null);
                _$effect((_$p) => _$setProp(_el$303, "borderColor", technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                return _el$303;
              })(), _$createComponent(Show, {
                get when() {
                  return technicalExpanded();
                },
                get children() {
                  return [(() => {
                    var _el$306 = _$createElement("text"), _el$307 = _$createTextNode(`State: `);
                    _$insertNode(_el$306, _el$307);
                    _$insert(_el$306, () => summary().state, null);
                    return _el$306;
                  })(), (() => {
                    var _el$308 = _$createElement("text"), _el$309 = _$createTextNode(`Effective mode: `);
                    _$insertNode(_el$308, _el$309);
                    _$insert(_el$308, () => summary().effectiveMode, null);
                    return _el$308;
                  })(), (() => {
                    var _el$310 = _$createElement("text"), _el$311 = _$createTextNode(`Operation: `);
                    _$insertNode(_el$310, _el$311);
                    _$insert(_el$310, () => summary().operation.status, null);
                    return _el$310;
                  })(), _$memo(() => reactiveChild(() => selected().audit.map((entry) => (() => {
                    var _el$320 = _$createElement("text"), _el$321 = _$createTextNode(`: `);
                    _$insertNode(_el$320, _el$321);
                    _$setProp(_el$320, "wrapMode", "word");
                    _$insert(_el$320, () => entry.kind, _el$321);
                    _$insert(_el$320, () => entry.summary, null);
                    return _el$320;
                  })())))];
                }
              })]
            }), _el$258);
            _$insert(_el$248, _$createComponent(Show, {
              get when() {
                return selected().actions.some((action) => action.action === "reject-proposal" && action.feedbackSupported);
              },
              get children() {
                var _el$253 = _$createElement("box"), _el$254 = _$createElement("text"), _el$256 = _$createElement("box");
                _$insertNode(_el$253, _el$254);
                _$insertNode(_el$253, _el$256);
                _$setProp(_el$253, "flexDirection", "column");
                _$insertNode(_el$254, _$createTextNode(`Optional rejection feedback (audit-only)`));
                _$setProp(_el$256, "flexDirection", "row");
                _$setProp(_el$256, "gap", 1);
                _$setProp(_el$256, "flexWrap", "wrap");
                _$insert(_el$256, () => reactiveChild(() => recommendations().rejectionFeedbackOptions.map((option) => (() => {
                  var _el$322 = _$createElement("box"), _el$323 = _$createElement("text");
                  _$insertNode(_el$322, _el$323);
                  _$setProp(_el$322, "focusable", true);
                  _$setProp(_el$322, "border", true);
                  _$setProp(_el$322, "paddingLeft", 1);
                  _$setProp(_el$322, "paddingRight", 1);
                  _$setProp(_el$322, "on:focused", () => setFocusedControl(`rejection:${option.value}`));
                  _$setProp(_el$322, "on:blurred", () => setFocusedControl((current) => current === `rejection:${option.value}` ? null : current));
                  _$setProp(_el$322, "onMouseUp", () => setRejectionReason(rejectionReason() === option.value ? null : option.value));
                  _$setProp(_el$322, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setRejectionReason(rejectionReason() === option.value ? null : option.value);
                  });
                  _$insert(_el$323, () => focusMark(`rejection:${option.value}`), null);
                  _$insert(_el$323, () => option.label, null);
                  _$effect((_$p) => _$setProp(_el$322, "borderColor", rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                  return _el$322;
                })())));
                _$insert(_el$253, _$createComponent(Show, {
                  get when() {
                    return rejectionReason() === "other";
                  },
                  get children() {
                    var _el$257 = _$createElement("input");
                    _$setProp(_el$257, "placeholder", "Optional bounded reason (512 characters)");
                    _$setProp(_el$257, "onInput", (value) => setRejectionText(value.slice(0, 512)));
                    _$effect((_$p) => _$setProp(_el$257, "value", rejectionText(), _$p));
                    return _el$257;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$254, "fg", props.api.theme.current.textMuted, _$p));
                return _el$253;
              }
            }), _el$258);
            _$insertNode(_el$258, _el$259);
            _$setProp(_el$258, "flexDirection", "row");
            _$setProp(_el$258, "gap", 1);
            _$setProp(_el$258, "flexWrap", "wrap");
            _$insert(_el$258, () => reactiveChild(() => selected().actions.flatMap((action) => {
              const choices = action.action === "snooze-proposal" ? [{
                label: "Snooze 1 hour",
                delay: 3600000
              }, {
                label: "Snooze 1 day",
                delay: 86400000
              }, {
                label: "Snooze 7 days",
                delay: 604800000
              }] : [{
                label: action.action === "rollback-proposal" ? "Undo" : action.action === "acknowledge-audit" ? "Acknowledge" : action.label,
                delay: undefined
              }];
              return choices.map((choice) => {
                const key = `${action.action}:${choice.delay ?? ""}`;
                return (() => {
                  var _el$324 = _$createElement("box"), _el$325 = _$createElement("text");
                  _$insertNode(_el$324, _el$325);
                  _$setProp(_el$324, "border", true);
                  _$setProp(_el$324, "paddingLeft", 1);
                  _$setProp(_el$324, "paddingRight", 1);
                  _$setProp(_el$324, "on:focused", () => setFocusedControl(`recommendation-action:${key}`));
                  _$setProp(_el$324, "on:blurred", () => setFocusedControl((current) => current === `recommendation-action:${key}` ? null : current));
                  _$setProp(_el$324, "onMouseUp", () => {
                    if (!action.pending)
                      activateRecommendation(action.action, choice.delay);
                  });
                  _$setProp(_el$324, "onKeyDown", (event) => {
                    if (!isActivationKey(event) || action.pending)
                      return;
                    event.preventDefault();
                    activateRecommendation(action.action, choice.delay);
                  });
                  _$insert(_el$325, () => focusMark(`recommendation-action:${key}`), null);
                  _$insert(_el$325, (() => {
                    var _c$9 = _$memo(() => !!action.pending);
                    return () => _c$9() ? `${choice.label} \xB7 Pending` : _$memo(() => confirmation() === key)() ? `Confirm ${choice.label}` : choice.label;
                  })(), null);
                  _$effect((_p$) => {
                    var _v$54 = !action.pending, _v$55 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$56 = action.pending ? props.api.theme.current.textMuted : props.api.theme.current.text;
                    _v$54 !== _p$.e && (_p$.e = _$setProp(_el$324, "focusable", _v$54, _p$.e));
                    _v$55 !== _p$.t && (_p$.t = _$setProp(_el$324, "borderColor", _v$55, _p$.t));
                    _v$56 !== _p$.a && (_p$.a = _$setProp(_el$325, "fg", _v$56, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$324;
                })();
              });
            })), _el$259);
            _$insertNode(_el$259, _el$260);
            _$setProp(_el$259, "focusable", true);
            _$setProp(_el$259, "border", true);
            _$setProp(_el$259, "paddingLeft", 1);
            _$setProp(_el$259, "paddingRight", 1);
            _$setProp(_el$259, "on:focused", () => setFocusedControl("recommendation:open-activity"));
            _$setProp(_el$259, "on:blurred", () => setFocusedControl((current) => current === "recommendation:open-activity" ? null : current));
            _$setProp(_el$259, "onMouseUp", () => void activateRecommendation("open-activity"));
            _$setProp(_el$259, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              activateRecommendation("open-activity");
            });
            _$insertNode(_el$260, _el$261);
            _$insert(_el$260, () => focusMark("recommendation:open-activity"), _el$261);
            _$insert(_el$248, _$createComponent(Show, {
              get when() {
                return pendingRecommendation();
              },
              get children() {
                var _el$262 = _$createElement("text");
                _$insertNode(_el$262, _$createTextNode(`Request pending server validation\u2026`));
                _$effect((_$p) => _$setProp(_el$262, "fg", props.api.theme.current.info, _$p));
                return _el$262;
              }
            }), null);
            _$effect((_p$) => {
              var _v$52 = props.api.theme.current.borderActive, _v$53 = props.api.theme.current.borderSubtle;
              _v$52 !== _p$.e && (_p$.e = _$setProp(_el$248, "borderColor", _v$52, _p$.e));
              _v$53 !== _p$.t && (_p$.t = _$setProp(_el$259, "borderColor", _v$53, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$248;
          })()
        }), null);
        return _el$68;
      }
    }), null);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return section() === "activity";
      },
      get children() {
        var _el$74 = _$createElement("box"), _el$75 = _$createElement("text"), _el$76 = _$createElement("b"), _el$78 = _$createElement("box"), _el$81 = _$createElement("box"), _el$82 = _$createElement("text"), _el$83 = _$createTextNode(`Diagnostics `);
        _$insertNode(_el$74, _el$75);
        _$insertNode(_el$74, _el$78);
        _$insertNode(_el$74, _el$81);
        _$setProp(_el$74, "flexDirection", "column");
        _$setProp(_el$74, "gap", 1);
        _$insertNode(_el$75, _el$76);
        _$insertNode(_el$76, _$createTextNode(`Activity`));
        _$setProp(_el$78, "flexDirection", "row");
        _$setProp(_el$78, "gap", 1);
        _$setProp(_el$78, "flexWrap", "wrap");
        _$insert(_el$78, () => [["all", "All"], ["recommendations", "Recommendations"], ["system", "System"], ["errors", "Errors"]].map(([value, label]) => (() => {
          var _el$326 = _$createElement("box"), _el$327 = _$createElement("text");
          _$insertNode(_el$326, _el$327);
          _$setProp(_el$326, "focusable", true);
          _$setProp(_el$326, "border", true);
          _$setProp(_el$326, "paddingLeft", 1);
          _$setProp(_el$326, "paddingRight", 1);
          _$setProp(_el$326, "on:focused", () => setFocusedControl(`activity-filter:${value}`));
          _$setProp(_el$326, "on:blurred", () => setFocusedControl((current) => current === `activity-filter:${value}` ? null : current));
          _$setProp(_el$326, "onMouseUp", () => {
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$setProp(_el$326, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$insert(_el$327, () => focusMark(`activity-filter:${value}`), null);
          _$insert(_el$327, label, null);
          _$effect((_p$) => {
            var _v$57 = focusId(`activity-filter:${value}`), _v$58 = activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$57 !== _p$.e && (_p$.e = _$setProp(_el$326, "id", _v$57, _p$.e));
            _v$58 !== _p$.t && (_p$.t = _$setProp(_el$326, "borderColor", _v$58, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$326;
        })()));
        _$insert(_el$74, _$createComponent(Show, {
          get when() {
            return activity().emptyState;
          },
          get children() {
            var _el$79 = _$createElement("text");
            _$setProp(_el$79, "wrapMode", "word");
            _$insert(_el$79, () => activity().emptyState);
            return _el$79;
          }
        }), _el$81);
        _$insert(_el$74, () => reactiveChild(() => activity().activity.map((entry, index) => (() => {
          var _el$328 = _$createElement("box"), _el$329 = _$createElement("text"), _el$330 = _$createTextNode(`[`), _el$331 = _$createTextNode(`] `), _el$332 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$328, _el$329);
          _$use((value) => activityNodes.set(index, value), _el$328);
          _$setProp(_el$328, "focusable", true);
          _$setProp(_el$328, "border", true);
          _$setProp(_el$328, "paddingLeft", 1);
          _$setProp(_el$328, "paddingRight", 1);
          _$setProp(_el$328, "flexDirection", "column");
          _$setProp(_el$328, "on:focused", () => {
            setFocusedControl(`activity-row:${index}`);
            setActivityIndex(index);
          });
          _$setProp(_el$328, "on:blurred", () => setFocusedControl((current) => current === `activity-row:${index}` ? null : current));
          _$setProp(_el$328, "onMouseUp", () => {
            setActivityIndex(index);
            activityNodes.get(index)?.focus();
            setActivityExpanded(activityExpanded() === index ? null : index);
          });
          _$setProp(_el$328, "onKeyDown", (event) => {
            if (isActivationKey(event)) {
              event.preventDefault();
              setActivityExpanded(activityExpanded() === index ? null : index);
            } else if (event.name === "right" && entry.destination?.section === "recommendations") {
              event.preventDefault();
              openActivityDestination(entry);
            } else if (event.name === "up") {
              event.preventDefault();
              moveActivity(-1);
            } else if (event.name === "down") {
              event.preventDefault();
              moveActivity(1);
            }
          });
          _$insertNode(_el$329, _el$330);
          _$insertNode(_el$329, _el$331);
          _$insertNode(_el$329, _el$332);
          _$setProp(_el$329, "wrapMode", "word");
          _$insert(_el$329, () => focusMark(`activity-row:${index}`), _el$330);
          _$insert(_el$329, () => entry.marker, _el$331);
          _$insert(_el$329, () => entry.summary, _el$332);
          _$insert(_el$329, () => relativeTime(entry.occurredAt), null);
          _$insert(_el$328, _$createComponent(Show, {
            get when() {
              return entry.target;
            },
            get children() {
              var _el$333 = _$createElement("text"), _el$334 = _$createTextNode(`Skill: `);
              _$insertNode(_el$333, _el$334);
              _$insert(_el$333, () => entry.target, null);
              _$effect((_$p) => _$setProp(_el$333, "fg", props.api.theme.current.textMuted, _$p));
              return _el$333;
            }
          }), null);
          _$insert(_el$328, _$createComponent(Show, {
            get when() {
              return activityExpanded() === index;
            },
            get children() {
              return [(() => {
                var _el$335 = _$createElement("text"), _el$336 = _$createTextNode(`Category: `);
                _$insertNode(_el$335, _el$336);
                _$insert(_el$335, () => entry.technical.category, null);
                _$effect((_$p) => _$setProp(_el$335, "fg", props.api.theme.current.textMuted, _$p));
                return _el$335;
              })(), (() => {
                var _el$337 = _$createElement("text"), _el$338 = _$createTextNode(`Outcome: `);
                _$insertNode(_el$337, _el$338);
                _$insert(_el$337, () => entry.technical.outcome.replaceAll("-", " "), null);
                _$effect((_$p) => _$setProp(_el$337, "fg", props.api.theme.current.textMuted, _$p));
                return _el$337;
              })(), _$createComponent(Show, {
                get when() {
                  return entry.technical.reason;
                },
                children: (reason) => (() => {
                  var _el$342 = _$createElement("text"), _el$343 = _$createTextNode(`Reason: `);
                  _$insertNode(_el$342, _el$343);
                  _$insert(_el$342, () => reason().replaceAll("-", " "), null);
                  _$effect((_$p) => _$setProp(_el$342, "fg", props.api.theme.current.textMuted, _$p));
                  return _el$342;
                })()
              }), _$createComponent(Show, {
                get when() {
                  return entry.destination?.section === "recommendations";
                },
                get children() {
                  var _el$339 = _$createElement("box"), _el$340 = _$createElement("text"), _el$341 = _$createTextNode(`Open recommendation`);
                  _$insertNode(_el$339, _el$340);
                  _$setProp(_el$339, "focusable", true);
                  _$setProp(_el$339, "border", true);
                  _$setProp(_el$339, "paddingLeft", 1);
                  _$setProp(_el$339, "paddingRight", 1);
                  _$setProp(_el$339, "on:focused", () => setFocusedControl(`activity-open:${index}`));
                  _$setProp(_el$339, "on:blurred", () => setFocusedControl((current) => current === `activity-open:${index}` ? null : current));
                  _$setProp(_el$339, "onMouseUp", () => openActivityDestination(entry));
                  _$setProp(_el$339, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    openActivityDestination(entry);
                  });
                  _$insertNode(_el$340, _el$341);
                  _$insert(_el$340, () => focusMark(`activity-open:${index}`), _el$341);
                  _$effect((_$p) => _$setProp(_el$339, "borderColor", props.api.theme.current.borderSubtle, _$p));
                  return _el$339;
                }
              })];
            }
          }), null);
          _$effect((_p$) => {
            var _v$59 = focusId(`activity-row:${index}`), _v$60 = activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$59 !== _p$.e && (_p$.e = _$setProp(_el$328, "id", _v$59, _p$.e));
            _v$60 !== _p$.t && (_p$.t = _$setProp(_el$328, "borderColor", _v$60, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$328;
        })())), _el$81);
        _$insert(_el$74, _$createComponent(Show, {
          get when() {
            return activity().overflowMessage;
          },
          get children() {
            var _el$80 = _$createElement("text");
            _$setProp(_el$80, "wrapMode", "word");
            _$insert(_el$80, () => activity().overflowMessage);
            _$effect((_$p) => _$setProp(_el$80, "fg", props.api.theme.current.warning, _$p));
            return _el$80;
          }
        }), _el$81);
        _$insertNode(_el$81, _el$82);
        _$setProp(_el$81, "focusable", true);
        _$setProp(_el$81, "border", true);
        _$setProp(_el$81, "paddingLeft", 1);
        _$setProp(_el$81, "paddingRight", 1);
        _$setProp(_el$81, "on:focused", () => setFocusedControl("activity:diagnostics"));
        _$setProp(_el$81, "on:blurred", () => setFocusedControl((current) => current === "activity:diagnostics" ? null : current));
        _$setProp(_el$81, "onMouseUp", () => setDiagnosticsExpanded((value) => !value));
        _$setProp(_el$81, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setDiagnosticsExpanded((value) => !value);
        });
        _$insertNode(_el$82, _el$83);
        _$insert(_el$82, () => focusMark("activity:diagnostics"), _el$83);
        _$insert(_el$82, () => diagnosticsExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$74, _$createComponent(Show, {
          get when() {
            return diagnosticsExpanded();
          },
          get children() {
            var _el$84 = _$createElement("box"), _el$85 = _$createElement("text"), _el$86 = _$createTextNode(`Projection refreshed: `), _el$87 = _$createElement("text"), _el$88 = _$createTextNode(`Core projection: `), _el$89 = _$createElement("text"), _el$90 = _$createTextNode(`Enhanced projection: `), _el$91 = _$createElement("text"), _el$92 = _$createTextNode(`OpenCode: `), _el$93 = _$createTextNode(` (`), _el$94 = _$createTextNode(`)`), _el$95 = _$createElement("text"), _el$96 = _$createTextNode(`Self-evolve: `), _el$97 = _$createElement("text"), _el$98 = _$createTextNode(`Projection protocol: `), _el$99 = _$createElement("text"), _el$100 = _$createTextNode(`Dashboard protocol: `), _el$101 = _$createElement("text"), _el$102 = _$createTextNode(`Refresh watcher: `), _el$103 = _$createElement("text"), _el$104 = _$createTextNode(`Circuit breaker: `);
            _$insertNode(_el$84, _el$85);
            _$insertNode(_el$84, _el$87);
            _$insertNode(_el$84, _el$89);
            _$insertNode(_el$84, _el$91);
            _$insertNode(_el$84, _el$95);
            _$insertNode(_el$84, _el$97);
            _$insertNode(_el$84, _el$99);
            _$insertNode(_el$84, _el$101);
            _$insertNode(_el$84, _el$103);
            _$setProp(_el$84, "flexDirection", "column");
            _$insertNode(_el$85, _el$86);
            _$setProp(_el$85, "wrapMode", "word");
            _$insert(_el$85, (() => {
              var _c$3 = _$memo(() => !!activity().diagnostics.refreshedAt);
              return () => _c$3() ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable";
            })(), null);
            _$insertNode(_el$87, _el$88);
            _$setProp(_el$87, "wrapMode", "word");
            _$insert(_el$87, () => activity().diagnostics.coreProjection, null);
            _$insertNode(_el$89, _el$90);
            _$setProp(_el$89, "wrapMode", "word");
            _$insert(_el$89, () => activity().diagnostics.enhancedProjection, null);
            _$insertNode(_el$91, _el$92);
            _$insertNode(_el$91, _el$93);
            _$insertNode(_el$91, _el$94);
            _$setProp(_el$91, "wrapMode", "word");
            _$insert(_el$91, () => activity().diagnostics.runtime.hostVersion, _el$93);
            _$insert(_el$91, () => activity().diagnostics.runtime.hostVersionSource, _el$94);
            _$insertNode(_el$95, _el$96);
            _$setProp(_el$95, "wrapMode", "word");
            _$insert(_el$95, () => activity().diagnostics.runtime.pluginVersion, null);
            _$insertNode(_el$97, _el$98);
            _$setProp(_el$97, "wrapMode", "word");
            _$insert(_el$97, () => activity().diagnostics.runtime.projectionVersion ?? "Unavailable", null);
            _$insertNode(_el$99, _el$100);
            _$setProp(_el$99, "wrapMode", "word");
            _$insert(_el$99, () => activity().diagnostics.runtime.dashboardVersion ?? "Unavailable", null);
            _$insertNode(_el$101, _el$102);
            _$setProp(_el$101, "wrapMode", "word");
            _$insert(_el$101, () => activity().diagnostics.watcherStatus, null);
            _$insertNode(_el$103, _el$104);
            _$setProp(_el$103, "wrapMode", "word");
            _$insert(_el$103, () => activity().diagnostics.breakerStatus, null);
            _$insert(_el$84, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.automation;
              },
              children: (automation) => (() => {
                var _el$344 = _$createElement("text"), _el$345 = _$createTextNode(`Scheduler: `);
                _$insertNode(_el$344, _el$345);
                _$setProp(_el$344, "wrapMode", "word");
                _$insert(_el$344, () => automation().state.replaceAll("-", " "), null);
                return _el$344;
              })()
            }), null);
            _$insert(_el$84, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.backoffUntil;
              },
              children: (backoffUntil) => (() => {
                var _el$346 = _$createElement("text"), _el$347 = _$createTextNode(`Backoff ends: `);
                _$insertNode(_el$346, _el$347);
                _$setProp(_el$346, "wrapMode", "word");
                _$insert(_el$346, () => new Date(backoffUntil()).toISOString(), null);
                return _el$346;
              })()
            }), null);
            _$insert(_el$84, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.nextEligibleAt;
              },
              children: (nextEligibleAt) => (() => {
                var _el$348 = _$createElement("text"), _el$349 = _$createTextNode(`Next eligible: `);
                _$insertNode(_el$348, _el$349);
                _$setProp(_el$348, "wrapMode", "word");
                _$insert(_el$348, () => new Date(nextEligibleAt()).toISOString(), null);
                return _el$348;
              })()
            }), null);
            _$insert(_el$84, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.usage;
              },
              children: (usage) => [(() => {
                var _el$350 = _$createElement("text"), _el$351 = _$createTextNode(`Background analysis used/remaining: `), _el$352 = _$createTextNode(` / `);
                _$insertNode(_el$350, _el$351);
                _$insertNode(_el$350, _el$352);
                _$setProp(_el$350, "wrapMode", "word");
                _$insert(_el$350, () => usage().passive.used, _el$352);
                _$insert(_el$350, () => usage().passive.remaining, null);
                return _el$350;
              })(), (() => {
                var _el$353 = _$createElement("text"), _el$354 = _$createTextNode(`Recommendation synthesis used/remaining: `), _el$355 = _$createTextNode(` / `);
                _$insertNode(_el$353, _el$354);
                _$insertNode(_el$353, _el$355);
                _$setProp(_el$353, "wrapMode", "word");
                _$insert(_el$353, () => usage().synthesis.used, _el$355);
                _$insert(_el$353, () => usage().synthesis.remaining, null);
                return _el$353;
              })(), (() => {
                var _el$356 = _$createElement("text"), _el$357 = _$createTextNode(`Storage used/quota: `), _el$358 = _$createTextNode(` / `), _el$359 = _$createTextNode(` bytes`);
                _$insertNode(_el$356, _el$357);
                _$insertNode(_el$356, _el$358);
                _$insertNode(_el$356, _el$359);
                _$setProp(_el$356, "wrapMode", "word");
                _$insert(_el$356, () => usage().storage.usedBytes, _el$358);
                _$insert(_el$356, () => usage().storage.limitBytes, _el$359);
                return _el$356;
              })(), _$createComponent(Show, {
                get when() {
                  return activity().diagnostics.budgetResetAt;
                },
                children: (budgetResetAt) => [(() => {
                  var _el$360 = _$createElement("text"), _el$361 = _$createTextNode(`Background analysis resets: `);
                  _$insertNode(_el$360, _el$361);
                  _$setProp(_el$360, "wrapMode", "word");
                  _$insert(_el$360, () => new Date(budgetResetAt().passive).toISOString(), null);
                  return _el$360;
                })(), (() => {
                  var _el$362 = _$createElement("text"), _el$363 = _$createTextNode(`Recommendation synthesis resets: `);
                  _$insertNode(_el$362, _el$363);
                  _$setProp(_el$362, "wrapMode", "word");
                  _$insert(_el$362, () => new Date(budgetResetAt().synthesis).toISOString(), null);
                  return _el$362;
                })()]
              })]
            }), null);
            _$insert(_el$84, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.lastError;
              },
              children: (lastError) => (() => {
                var _el$364 = _$createElement("text"), _el$365 = _$createTextNode(`Last bounded error: `);
                _$insertNode(_el$364, _el$365);
                _$setProp(_el$364, "wrapMode", "word");
                _$insert(_el$364, () => lastError().summary, null);
                return _el$364;
              })()
            }), null);
            return _el$84;
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$81, "borderColor", diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
        return _el$74;
      }
    }), null);
    _$insert(_el$25, _$createComponent(Show, {
      get when() {
        return section() === "settings";
      },
      get children() {
        var _el$105 = _$createElement("box"), _el$106 = _$createElement("text"), _el$107 = _$createElement("b"), _el$112 = _$createElement("text"), _el$113 = _$createElement("b"), _el$115 = _$createElement("text"), _el$116 = _$createTextNode(`Effective result: `), _el$117 = _$createElement("text"), _el$118 = _$createTextNode(`Global default: `), _el$119 = _$createElement("text"), _el$120 = _$createTextNode(`This project: `), _el$121 = _$createElement("text"), _el$137 = _$createElement("text"), _el$138 = _$createElement("b"), _el$140 = _$createElement("box"), _el$141 = _$createElement("text"), _el$142 = _$createElement("b"), _el$144 = _$createTextNode(`: `), _el$145 = _$createElement("text"), _el$147 = _$createElement("text"), _el$148 = _$createTextNode(`Pause automatic work: `), _el$149 = _$createTextNode(`. Pause preserves modes and consent.`), _el$150 = _$createElement("text"), _el$151 = _$createTextNode(`Emergency stop: `), _el$152 = _$createTextNode(`. It overrides every automatic provider and write path.`), _el$153 = _$createElement("text"), _el$154 = _$createElement("b"), _el$156 = _$createElement("text"), _el$164 = _$createElement("text"), _el$165 = _$createElement("b"), _el$167 = _$createElement("text"), _el$169 = _$createElement("text"), _el$170 = _$createElement("b"), _el$172 = _$createElement("text"), _el$174 = _$createElement("box"), _el$175 = _$createElement("text"), _el$176 = _$createElement("box"), _el$183 = _$createElement("text"), _el$184 = _$createTextNode(`OpenCode `), _el$185 = _$createTextNode(` \xB7 Self-evolve `), _el$186 = _$createTextNode(` \xB7 Projection `), _el$187 = _$createTextNode(` \xB7 Dashboard `), _el$188 = _$createElement("text");
        _$insertNode(_el$105, _el$106);
        _$insertNode(_el$105, _el$112);
        _$insertNode(_el$105, _el$115);
        _$insertNode(_el$105, _el$117);
        _$insertNode(_el$105, _el$119);
        _$insertNode(_el$105, _el$121);
        _$insertNode(_el$105, _el$137);
        _$insertNode(_el$105, _el$140);
        _$insertNode(_el$105, _el$147);
        _$insertNode(_el$105, _el$150);
        _$insertNode(_el$105, _el$153);
        _$insertNode(_el$105, _el$156);
        _$insertNode(_el$105, _el$164);
        _$insertNode(_el$105, _el$167);
        _$insertNode(_el$105, _el$169);
        _$insertNode(_el$105, _el$172);
        _$insertNode(_el$105, _el$174);
        _$insertNode(_el$105, _el$175);
        _$insertNode(_el$105, _el$176);
        _$insertNode(_el$105, _el$183);
        _$insertNode(_el$105, _el$188);
        _$setProp(_el$105, "flexDirection", "column");
        _$setProp(_el$105, "gap", 1);
        _$insertNode(_el$106, _el$107);
        _$insertNode(_el$107, _$createTextNode(`Settings`));
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settingsAnchor();
          },
          children: (anchor) => (() => {
            var _el$366 = _$createElement("box"), _el$367 = _$createElement("text"), _el$368 = _$createTextNode(`Opened at `), _el$369 = _$createTextNode(` settings.`);
            _$insertNode(_el$366, _el$367);
            _$setProp(_el$366, "focusable", true);
            _$setProp(_el$366, "border", true);
            _$setProp(_el$366, "paddingLeft", 1);
            _$setProp(_el$366, "paddingRight", 1);
            _$setProp(_el$366, "on:focused", () => setFocusedControl(`anchor:${anchor()}`));
            _$setProp(_el$366, "on:blurred", () => setFocusedControl((current) => current === `anchor:${anchor()}` ? null : current));
            _$insertNode(_el$367, _el$368);
            _$insertNode(_el$367, _el$369);
            _$setProp(_el$367, "wrapMode", "word");
            _$insert(_el$367, () => focusMark(`anchor:${anchor()}`), _el$368);
            _$insert(_el$367, () => anchor().replaceAll("-", " "), _el$369);
            _$effect((_p$) => {
              var _v$61 = focusId(`anchor:${anchor()}`), _v$62 = focusedControl() === `anchor:${anchor()}` ? props.api.theme.current.borderActive : props.api.theme.current.info, _v$63 = props.api.theme.current.info;
              _v$61 !== _p$.e && (_p$.e = _$setProp(_el$366, "id", _v$61, _p$.e));
              _v$62 !== _p$.t && (_p$.t = _$setProp(_el$366, "borderColor", _v$62, _p$.t));
              _v$63 !== _p$.a && (_p$.a = _$setProp(_el$367, "fg", _v$63, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$366;
          })()
        }), _el$112);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().limited;
          },
          get children() {
            var _el$109 = _$createElement("text");
            _$insertNode(_el$109, _$createTextNode(`Limited view: enhanced usage, repository-mode editing, and prerequisite status require an aligned server.`));
            _$setProp(_el$109, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$109, "fg", props.api.theme.current.warning, _$p));
            return _el$109;
          }
        }), _el$112);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().enhancedError;
          },
          get children() {
            var _el$111 = _$createElement("text");
            _$setProp(_el$111, "wrapMode", "word");
            _$insert(_el$111, () => settings().enhancedError);
            _$effect((_$p) => _$setProp(_el$111, "fg", props.api.theme.current.error, _$p));
            return _el$111;
          }
        }), _el$112);
        _$insertNode(_el$112, _el$113);
        _$insertNode(_el$113, _$createTextNode(`Modes`));
        _$insertNode(_el$115, _el$116);
        _$setProp(_el$115, "wrapMode", "word");
        _$insert(_el$115, () => settings().mode.effective.label, null);
        _$insertNode(_el$117, _el$118);
        _$setProp(_el$117, "wrapMode", "word");
        _$insert(_el$117, () => settings().mode.global.label, null);
        _$insertNode(_el$119, _el$120);
        _$setProp(_el$119, "wrapMode", "word");
        _$insert(_el$119, () => settings().mode.repository.label, null);
        _$insertNode(_el$121, _$createTextNode(`The global default applies to every current and future project. \u201CUse for this project\u201D creates an override here only.`));
        _$setProp(_el$121, "wrapMode", "word");
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!settings().controls.globalMode)() && modeRank(settings().mode.global.value) < modeRank("auto");
          },
          get children() {
            var _el$123 = _$createElement("box"), _el$124 = _$createElement("text"), _el$125 = _$createElement("b"), _el$127 = _$createElement("text");
            _$insertNode(_el$123, _el$124);
            _$insertNode(_el$123, _el$127);
            _$setProp(_el$123, "border", true);
            _$setProp(_el$123, "paddingLeft", 1);
            _$setProp(_el$123, "paddingRight", 1);
            _$setProp(_el$123, "flexDirection", "column");
            _$setProp(_el$123, "gap", 1);
            _$insertNode(_el$124, _el$125);
            _$insertNode(_el$125, _$createTextNode(`Automatic recommendations setup`));
            _$insertNode(_el$127, _$createTextNode(`This confirmation changes only the global mode. Background AI analysis, saved structured patterns, and sanitized excerpts remain separate consent choices below.`));
            _$setProp(_el$127, "wrapMode", "word");
            _$insert(_el$123, () => actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true, {
              action: "set-mode",
              subject: "global-mode"
            }), null);
            _$effect((_$p) => _$setProp(_el$123, "borderColor", props.api.theme.current.info, _$p));
            return _el$123;
          }
        }), _el$137);
        _$insert(_el$105, () => reactiveChild(() => settings().modes.map((mode) => (() => {
          var _el$370 = _$createElement("box"), _el$371 = _$createElement("text"), _el$372 = _$createElement("b"), _el$373 = _$createElement("text"), _el$374 = _$createElement("text"), _el$375 = _$createTextNode(`Provider use: `), _el$376 = _$createElement("text"), _el$377 = _$createTextNode(`Saved data: `), _el$378 = _$createElement("text"), _el$379 = _$createTextNode(`Write authority: `), _el$380 = _$createElement("text"), _el$381 = _$createTextNode(`Prerequisites: `);
          _$insertNode(_el$370, _el$371);
          _$insertNode(_el$370, _el$373);
          _$insertNode(_el$370, _el$374);
          _$insertNode(_el$370, _el$376);
          _$insertNode(_el$370, _el$378);
          _$insertNode(_el$370, _el$380);
          _$setProp(_el$370, "border", true);
          _$setProp(_el$370, "paddingLeft", 1);
          _$setProp(_el$370, "paddingRight", 1);
          _$setProp(_el$370, "flexDirection", "column");
          _$insertNode(_el$371, _el$372);
          _$insert(_el$372, () => mode.label);
          _$insert(_el$371, () => settings().mode.effective.value === mode.value ? " \xB7 Effective now" : "", null);
          _$setProp(_el$373, "wrapMode", "word");
          _$insert(_el$373, () => mode.description);
          _$insertNode(_el$374, _el$375);
          _$setProp(_el$374, "wrapMode", "word");
          _$insert(_el$374, () => mode.providerUse, null);
          _$insertNode(_el$376, _el$377);
          _$setProp(_el$376, "wrapMode", "word");
          _$insert(_el$376, () => mode.savedData, null);
          _$insertNode(_el$378, _el$379);
          _$setProp(_el$378, "wrapMode", "word");
          _$insert(_el$378, () => mode.writeAuthority, null);
          _$insertNode(_el$380, _el$381);
          _$setProp(_el$380, "wrapMode", "word");
          _$insert(_el$380, () => mode.prerequisites, null);
          _$insert(_el$370, _$createComponent(Show, {
            get when() {
              return mode.blockers.length;
            },
            get children() {
              return reactiveChild(() => mode.blockers.map((blocker) => (() => {
                var _el$383 = _$createElement("text"), _el$384 = _$createTextNode(`\u2022 `);
                _$insertNode(_el$383, _el$384);
                _$setProp(_el$383, "wrapMode", "word");
                _$insert(_el$383, blocker, null);
                _$effect((_$p) => _$setProp(_el$383, "fg", props.api.theme.current.warning, _$p));
                return _el$383;
              })()));
            }
          }), null);
          _$insert(_el$370, _$createComponent(Show, {
            get when() {
              return mode.available;
            },
            get children() {
              var _el$382 = _$createElement("box");
              _$setProp(_el$382, "flexDirection", "row");
              _$setProp(_el$382, "flexWrap", "wrap");
              _$setProp(_el$382, "gap", 1);
              _$insert(_el$382, _$createComponent(Show, {
                get when() {
                  return settings().controls.globalMode;
                },
                get children() {
                  return localActionButton(settings().mode.global.value === mode.value ? "Global default \u2713" : "Set global default", () => submitMode("global", mode.value), mode.value === "yolo", `global-mode-${mode.value}`, {
                    action: "set-mode",
                    subject: "global-mode"
                  });
                }
              }), null);
              _$insert(_el$382, _$createComponent(Show, {
                get when() {
                  return settings().controls.repositoryMode;
                },
                get children() {
                  return localActionButton(settings().mode.repository.value === mode.value ? "This project \u2713" : "Use for this project", () => submitMode("project", mode.value), mode.value === "yolo", `project-mode-${mode.value}`, {
                    action: "set-repo-mode",
                    subject: "repository-mode"
                  });
                }
              }), null);
              return _el$382;
            }
          }), null);
          _$effect((_p$) => {
            var _v$64 = props.api.theme.current.borderSubtle, _v$65 = props.api.theme.current.textMuted, _v$66 = props.api.theme.current.textMuted, _v$67 = props.api.theme.current.textMuted, _v$68 = props.api.theme.current.textMuted;
            _v$64 !== _p$.e && (_p$.e = _$setProp(_el$370, "borderColor", _v$64, _p$.e));
            _v$65 !== _p$.t && (_p$.t = _$setProp(_el$374, "fg", _v$65, _p$.t));
            _v$66 !== _p$.a && (_p$.a = _$setProp(_el$376, "fg", _v$66, _p$.a));
            _v$67 !== _p$.o && (_p$.o = _$setProp(_el$378, "fg", _v$67, _p$.o));
            _v$68 !== _p$.i && (_p$.i = _$setProp(_el$380, "fg", _v$68, _p$.i));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined
          });
          return _el$370;
        })())), _el$137);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().controls.repositoryMode;
          },
          get children() {
            return localActionButton(settings().mode.repository.value === "inherit" ? "Inherit global default \u2713" : "Make this project inherit global default", () => submitMode("project", "inherit"), false, "project-mode-inherit", {
              action: "set-repo-mode",
              subject: "repository-mode"
            });
          }
        }), _el$137);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return yoloTarget();
          },
          get children() {
            var _el$129 = _$createElement("box"), _el$130 = _$createElement("text"), _el$131 = _$createTextNode(`Apply automatically expands write authority for the `), _el$132 = _$createTextNode(`. Approved folders and every current prerequisite will be revalidated by the server.`), _el$133 = _$createElement("text"), _el$135 = _$createElement("input"), _el$136 = _$createElement("box");
            _$insertNode(_el$129, _el$130);
            _$insertNode(_el$129, _el$133);
            _$insertNode(_el$129, _el$135);
            _$insertNode(_el$129, _el$136);
            _$setProp(_el$129, "border", true);
            _$setProp(_el$129, "paddingLeft", 1);
            _$setProp(_el$129, "paddingRight", 1);
            _$setProp(_el$129, "flexDirection", "column");
            _$insertNode(_el$130, _el$131);
            _$insertNode(_el$130, _el$132);
            _$setProp(_el$130, "wrapMode", "word");
            _$insert(_el$130, () => yoloTarget() === "global" ? "global default" : "current project", _el$132);
            _$insertNode(_el$133, _$createTextNode(`Type exactly: ENABLE YOLO`));
            _$setProp(_el$135, "placeholder", "ENABLE YOLO");
            _$setProp(_el$135, "onInput", (value) => setYoloConfirmation(value.slice(0, 64)));
            _$setProp(_el$136, "flexDirection", "row");
            _$setProp(_el$136, "flexWrap", "wrap");
            _$setProp(_el$136, "gap", 1);
            _$insert(_el$136, () => localActionButton("Submit Apply automatically", () => void confirmYolo(), true, undefined, {
              action: yoloTarget() === "global" ? "set-mode" : "set-repo-mode",
              subject: yoloTarget() === "global" ? "global-mode" : "repository-mode"
            }), null);
            _$insert(_el$136, () => localActionButton("Cancel", () => {
              setYoloTarget(null);
              setYoloConfirmation("");
            }, false, undefined, undefined, "cancel-yolo"), null);
            _$effect((_p$) => {
              var _v$23 = props.api.theme.current.warning, _v$24 = yoloConfirmation();
              _v$23 !== _p$.e && (_p$.e = _$setProp(_el$129, "borderColor", _v$23, _p$.e));
              _v$24 !== _p$.t && (_p$.t = _$setProp(_el$135, "value", _v$24, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$129;
          }
        }), _el$137);
        _$insertNode(_el$137, _el$138);
        _$insertNode(_el$138, _$createTextNode(`Privacy and project scope`));
        _$insertNode(_el$140, _el$141);
        _$insertNode(_el$140, _el$145);
        _$setProp(_el$140, "border", true);
        _$setProp(_el$140, "paddingLeft", 1);
        _$setProp(_el$140, "paddingRight", 1);
        _$setProp(_el$140, "flexDirection", "column");
        _$insertNode(_el$141, _el$142);
        _$insertNode(_el$141, _el$144);
        _$insertNode(_el$142, _$createTextNode(`Include this project`));
        _$insert(_el$141, () => settings().projectExcluded ? "No" : "Yes", null);
        _$insertNode(_el$145, _$createTextNode(`Excluding this project overrides automatic global modes without changing global settings.`));
        _$setProp(_el$145, "wrapMode", "word");
        _$insert(_el$140, _$createComponent(Show, {
          get when() {
            return settings().controls.projectInclusion;
          },
          get children() {
            return actionButton(settings().projectExcluded ? "include-project" : "exclude-project", settings().projectExcluded ? "Include this project" : "Exclude this project", () => props.store.submitControl("set-repo-excluded", {
              excluded: !settings().projectExcluded
            }), settings().projectExcluded === true, {
              action: "set-repo-excluded",
              subject: "project-inclusion"
            });
          }
        }), null);
        _$insert(_el$105, () => reactiveChild(() => settings().consent.map((entry) => (() => {
          var _el$385 = _$createElement("box"), _el$386 = _$createElement("text"), _el$387 = _$createElement("b"), _el$388 = _$createTextNode(`: `), _el$389 = _$createTextNode(` \xB7 `), _el$390 = _$createElement("text"), _el$391 = _$createElement("text");
          _$insertNode(_el$385, _el$386);
          _$insertNode(_el$385, _el$390);
          _$insertNode(_el$385, _el$391);
          _$setProp(_el$385, "border", true);
          _$setProp(_el$385, "paddingLeft", 1);
          _$setProp(_el$385, "paddingRight", 1);
          _$setProp(_el$385, "flexDirection", "column");
          _$insertNode(_el$386, _el$387);
          _$insertNode(_el$386, _el$388);
          _$insertNode(_el$386, _el$389);
          _$insert(_el$387, () => entry.label);
          _$insert(_el$386, () => entry.enabled ? "Allowed" : "Not allowed", _el$389);
          _$insert(_el$386, () => entry.scope, null);
          _$setProp(_el$390, "wrapMode", "word");
          _$insert(_el$390, () => entry.description);
          _$setProp(_el$391, "wrapMode", "word");
          _$insert(_el$391, () => entry.dependency);
          _$insert(_el$385, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!settings().controls.consent)() && (entry.enabled || entry.canEnable);
            },
            get children() {
              return _$memo(() => !!entry.enabled)() ? actionButton(`consent-${entry.key}-off`, `Stop allowing ${entry.label}`, () => props.store.submitControl("set-consent", {
                key: entry.key,
                enabled: false
              }), false, {
                action: "set-consent",
                subject: `consent:${entry.key}`
              }) : localActionButton(`Review consent for ${entry.label}`, () => openConsentDisclosure(entry.key), false, undefined, undefined, `consent:${entry.key}`);
            }
          }), null);
          _$insert(_el$385, () => consentDisclosure(entry.key), null);
          _$insert(_el$385, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!entry.enabled)() && !entry.canEnable;
            },
            get children() {
              var _el$392 = _$createElement("text");
              _$insertNode(_el$392, _$createTextNode(`Resolve the dependency above before enabling this setting.`));
              _$setProp(_el$392, "wrapMode", "word");
              _$effect((_$p) => _$setProp(_el$392, "fg", props.api.theme.current.warning, _$p));
              return _el$392;
            }
          }), null);
          _$effect((_p$) => {
            var _v$69 = props.api.theme.current.borderSubtle, _v$70 = props.api.theme.current.textMuted;
            _v$69 !== _p$.e && (_p$.e = _$setProp(_el$385, "borderColor", _v$69, _p$.e));
            _v$70 !== _p$.t && (_p$.t = _$setProp(_el$391, "fg", _v$70, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$385;
        })())), _el$147);
        _$insertNode(_el$147, _el$148);
        _$insertNode(_el$147, _el$149);
        _$setProp(_el$147, "wrapMode", "word");
        _$insert(_el$147, () => settings().paused ? "Paused" : "Running when eligible", _el$149);
        _$insertNode(_el$150, _el$151);
        _$insertNode(_el$150, _el$152);
        _$setProp(_el$150, "wrapMode", "word");
        _$insert(_el$150, () => settings().emergencyStop ? "On" : "Off", _el$152);
        _$insertNode(_el$153, _el$154);
        _$insertNode(_el$154, _$createTextNode(`Approved skill folders`));
        _$setProp(_el$156, "wrapMode", "word");
        _$insert(_el$156, () => settings().approvedSkillFolderWarning);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return !settings().approvedSkillFolders.length;
          },
          get children() {
            var _el$157 = _$createElement("text");
            _$insertNode(_el$157, _$createTextNode(`No folder is approved; Apply automatically cannot be enabled.`));
            _$setProp(_el$157, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$157, "fg", props.api.theme.current.warning, _$p));
            return _el$157;
          }
        }), _el$164);
        _$insert(_el$105, () => reactiveChild(() => settings().approvedSkillFolders.map((folder) => (() => {
          var _el$394 = _$createElement("box"), _el$395 = _$createElement("text");
          _$insertNode(_el$394, _el$395);
          _$setProp(_el$394, "border", true);
          _$setProp(_el$394, "paddingLeft", 1);
          _$setProp(_el$394, "paddingRight", 1);
          _$setProp(_el$394, "flexDirection", "row");
          _$setProp(_el$394, "flexWrap", "wrap");
          _$setProp(_el$394, "gap", 1);
          _$setProp(_el$395, "wrapMode", "word");
          _$insert(_el$395, folder);
          _$insert(_el$394, _$createComponent(Show, {
            get when() {
              return settings().controls.approvedSkillFolders;
            },
            get children() {
              return localActionButton("Remove", () => stageFolderList(settings().approvedSkillFolders.filter((candidate) => candidate !== folder)), false, undefined, undefined, `remove-folder:${folder}`);
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$394, "borderColor", props.api.theme.current.borderSubtle, _$p));
          return _el$394;
        })())), _el$164);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().controls.approvedSkillFolders;
          },
          get children() {
            var _el$159 = _$createElement("box"), _el$160 = _$createElement("text"), _el$162 = _$createElement("input");
            _$insertNode(_el$159, _el$160);
            _$insertNode(_el$159, _el$162);
            _$setProp(_el$159, "flexDirection", "column");
            _$insertNode(_el$160, _$createTextNode(`Add one canonical absolute folder`));
            _$setProp(_el$162, "placeholder", "/canonical/path/to/skills");
            _$setProp(_el$162, "onInput", (value) => {
              setFolderInput(value.slice(0, 4096));
              setFolderError(null);
            });
            _$insert(_el$159, () => localActionButton("Add folder", stageFolderAdd), null);
            _$effect((_$p) => _$setProp(_el$162, "value", folderInput(), _$p));
            return _el$159;
          }
        }), _el$164);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return folderError();
          },
          get children() {
            var _el$163 = _$createElement("text");
            _$setProp(_el$163, "wrapMode", "word");
            _$insert(_el$163, folderError);
            _$effect((_$p) => _$setProp(_el$163, "fg", props.api.theme.current.warning, _$p));
            return _el$163;
          }
        }), _el$164);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return folderDraft();
          },
          children: (draft) => (() => {
            var _el$396 = _$createElement("box"), _el$397 = _$createElement("text"), _el$398 = _$createElement("b"), _el$402 = _$createElement("text"), _el$404 = _$createElement("input"), _el$405 = _$createElement("box");
            _$insertNode(_el$396, _el$397);
            _$insertNode(_el$396, _el$402);
            _$insertNode(_el$396, _el$404);
            _$insertNode(_el$396, _el$405);
            _$setProp(_el$396, "border", true);
            _$setProp(_el$396, "paddingLeft", 1);
            _$setProp(_el$396, "paddingRight", 1);
            _$setProp(_el$396, "flexDirection", "column");
            _$insertNode(_el$397, _el$398);
            _$insertNode(_el$398, _$createTextNode(`Exact replacement`));
            _$insert(_el$396, _$createComponent(Show, {
              get when() {
                return draft().length;
              },
              get children() {
                return reactiveChild(() => draft().map((folder) => (() => {
                  var _el$406 = _$createElement("text"), _el$407 = _$createTextNode(`\u2022 `);
                  _$insertNode(_el$406, _el$407);
                  _$setProp(_el$406, "wrapMode", "word");
                  _$insert(_el$406, folder, null);
                  return _el$406;
                })()));
              }
            }), _el$402);
            _$insert(_el$396, _$createComponent(Show, {
              get when() {
                return draft().length === 0;
              },
              get children() {
                var _el$400 = _$createElement("text");
                _$insertNode(_el$400, _$createTextNode(`(empty)`));
                return _el$400;
              }
            }), _el$402);
            _$insertNode(_el$402, _$createTextNode(`Type exactly: UPDATE ALLOWLIST`));
            _$setProp(_el$404, "placeholder", "UPDATE ALLOWLIST");
            _$setProp(_el$404, "onInput", (value) => setFolderConfirmation(value.slice(0, 64)));
            _$setProp(_el$405, "flexDirection", "row");
            _$setProp(_el$405, "flexWrap", "wrap");
            _$setProp(_el$405, "gap", 1);
            _$insert(_el$405, () => localActionButton("Replace approved folders", () => void submitFolderList(), true, undefined, {
              action: "update-allowlist",
              subject: "approved-skill-folders"
            }), null);
            _$insert(_el$405, () => localActionButton("Cancel", () => {
              setFolderDraft(null);
              setFolderConfirmation("");
            }, false, undefined, undefined, "cancel-folder-update"), null);
            _$effect((_p$) => {
              var _v$71 = props.api.theme.current.warning, _v$72 = folderConfirmation();
              _v$71 !== _p$.e && (_p$.e = _$setProp(_el$396, "borderColor", _v$71, _p$.e));
              _v$72 !== _p$.t && (_p$.t = _$setProp(_el$404, "value", _v$72, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$396;
          })()
        }), _el$164);
        _$insertNode(_el$164, _el$165);
        _$insertNode(_el$165, _$createTextNode(`Limits and retention`));
        _$insertNode(_el$167, _$createTextNode(`These values are read-only here. Change configured numeric limits through startup configuration.`));
        _$setProp(_el$167, "wrapMode", "word");
        _$insert(_el$105, () => reactiveChild(() => settings().limits.map((limit) => (() => {
          var _el$408 = _$createElement("box"), _el$409 = _$createElement("text"), _el$410 = _$createElement("b"), _el$411 = _$createElement("text"), _el$412 = _$createTextNode(`Actual: `), _el$413 = _$createElement("text"), _el$414 = _$createTextNode(`Configured limit: `), _el$415 = _$createElement("text");
          _$insertNode(_el$408, _el$409);
          _$insertNode(_el$408, _el$411);
          _$insertNode(_el$408, _el$413);
          _$insertNode(_el$408, _el$415);
          _$setProp(_el$408, "border", true);
          _$setProp(_el$408, "paddingLeft", 1);
          _$setProp(_el$408, "paddingRight", 1);
          _$setProp(_el$408, "flexDirection", "column");
          _$insertNode(_el$409, _el$410);
          _$insert(_el$410, () => limit.label);
          _$insertNode(_el$411, _el$412);
          _$setProp(_el$411, "wrapMode", "word");
          _$insert(_el$411, () => limit.actual, null);
          _$insertNode(_el$413, _el$414);
          _$setProp(_el$413, "wrapMode", "word");
          _$insert(_el$413, () => limit.configured, null);
          _$insert(_el$408, _$createComponent(Show, {
            get when() {
              return limit.resetAt;
            },
            children: (resetAt) => (() => {
              var _el$416 = _$createElement("text"), _el$417 = _$createTextNode(`Resets: `);
              _$insertNode(_el$416, _el$417);
              _$setProp(_el$416, "wrapMode", "word");
              _$insert(_el$416, () => new Date(resetAt()).toISOString(), null);
              return _el$416;
            })()
          }), _el$415);
          _$setProp(_el$415, "wrapMode", "word");
          _$insert(_el$415, () => limit.explanation);
          _$effect((_p$) => {
            var _v$73 = props.api.theme.current.borderSubtle, _v$74 = props.api.theme.current.textMuted;
            _v$73 !== _p$.e && (_p$.e = _$setProp(_el$408, "borderColor", _v$73, _p$.e));
            _v$74 !== _p$.t && (_p$.t = _$setProp(_el$415, "fg", _v$74, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$408;
        })())), _el$169);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().rolloutProgress;
          },
          children: (rolloutProgress) => (() => {
            var _el$418 = _$createElement("box"), _el$419 = _$createElement("text"), _el$420 = _$createElement("b"), _el$422 = _$createTextNode(`: `), _el$423 = _$createElement("text"), _el$424 = _$createTextNode(`Actual: `), _el$425 = _$createElement("text"), _el$426 = _$createTextNode(`Configured requirement: `);
            _$insertNode(_el$418, _el$419);
            _$insertNode(_el$418, _el$423);
            _$insertNode(_el$418, _el$425);
            _$setProp(_el$418, "border", true);
            _$setProp(_el$418, "paddingLeft", 1);
            _$setProp(_el$418, "paddingRight", 1);
            _$setProp(_el$418, "flexDirection", "column");
            _$insertNode(_el$419, _el$420);
            _$insertNode(_el$419, _el$422);
            _$insertNode(_el$420, _$createTextNode(`Automatic-apply rollout evidence`));
            _$insert(_el$419, () => rolloutProgress().ready ? "Ready" : "Not ready", null);
            _$insertNode(_el$423, _el$424);
            _$setProp(_el$423, "wrapMode", "word");
            _$insert(_el$423, () => rolloutProgress().actual, null);
            _$insertNode(_el$425, _el$426);
            _$setProp(_el$425, "wrapMode", "word");
            _$insert(_el$425, () => rolloutProgress().configured, null);
            _$effect((_$p) => _$setProp(_el$418, "borderColor", props.api.theme.current.borderSubtle, _$p));
            return _el$418;
          })()
        }), _el$169);
        _$insertNode(_el$169, _el$170);
        _$insertNode(_el$170, _$createTextNode(`Maintenance`));
        _$insertNode(_el$172, _$createTextNode(`Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.`));
        _$setProp(_el$172, "wrapMode", "word");
        _$setProp(_el$174, "flexDirection", "row");
        _$setProp(_el$174, "flexWrap", "wrap");
        _$setProp(_el$174, "gap", 1);
        _$insert(_el$174, () => reactiveChild(() => settings().maintenance.scopes.map((scope) => (() => {
          var _el$427 = _$createElement("box"), _el$428 = _$createElement("text");
          _$insertNode(_el$427, _el$428);
          _$setProp(_el$427, "focusable", true);
          _$setProp(_el$427, "border", true);
          _$setProp(_el$427, "paddingLeft", 1);
          _$setProp(_el$427, "paddingRight", 1);
          _$setProp(_el$427, "on:focused", () => setFocusedControl(`maintenance-scope:${scope.value}`));
          _$setProp(_el$427, "on:blurred", () => setFocusedControl((current) => current === `maintenance-scope:${scope.value}` ? null : current));
          _$setProp(_el$427, "onMouseUp", () => {
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$setProp(_el$427, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$insert(_el$428, () => focusMark(`maintenance-scope:${scope.value}`), null);
          _$insert(_el$428, () => scope.label, null);
          _$effect((_$p) => _$setProp(_el$427, "borderColor", maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$427;
        })())));
        _$setProp(_el$175, "wrapMode", "word");
        _$insert(_el$175, () => settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation);
        _$setProp(_el$176, "flexDirection", "row");
        _$setProp(_el$176, "flexWrap", "wrap");
        _$setProp(_el$176, "gap", 1);
        _$insert(_el$176, _$createComponent(Show, {
          get when() {
            return settings().maintenance.canExport;
          },
          get children() {
            return localActionButton("Export selected scope", () => {
              setMaintenanceIntent("export");
              setMaintenanceConfirmation("");
            }, true);
          }
        }), null);
        _$insert(_el$176, _$createComponent(Show, {
          get when() {
            return _$memo(() => maintenanceScope() === "all")() ? settings().maintenance.canDeleteAll : settings().maintenance.canDeleteScope;
          },
          get children() {
            return localActionButton("Delete selected scope", () => {
              setMaintenanceIntent("delete");
              setMaintenanceConfirmation("");
            }, true);
          }
        }), null);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return maintenanceIntent();
          },
          get children() {
            var _el$177 = _$createElement("box"), _el$178 = _$createElement("text"), _el$179 = _$createElement("text"), _el$180 = _$createTextNode(`Type exactly: `), _el$181 = _$createElement("input"), _el$182 = _$createElement("box");
            _$insertNode(_el$177, _el$178);
            _$insertNode(_el$177, _el$179);
            _$insertNode(_el$177, _el$181);
            _$insertNode(_el$177, _el$182);
            _$setProp(_el$177, "border", true);
            _$setProp(_el$177, "paddingLeft", 1);
            _$setProp(_el$177, "paddingRight", 1);
            _$setProp(_el$177, "flexDirection", "column");
            _$setProp(_el$178, "wrapMode", "word");
            _$insert(_el$178, (() => {
              var _c$4 = _$memo(() => maintenanceIntent() === "export");
              return () => _c$4() ? "The export may contain classified Self-evolve evidence and active skill snapshots." : maintenanceScope() === "all" ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted." : "The selected retained data will be permanently deleted after fresh server validation.";
            })());
            _$insertNode(_el$179, _el$180);
            _$insert(_el$179, maintenancePhrase, null);
            _$setProp(_el$181, "onInput", (value) => setMaintenanceConfirmation(value.slice(0, 64)));
            _$setProp(_el$182, "flexDirection", "row");
            _$setProp(_el$182, "flexWrap", "wrap");
            _$setProp(_el$182, "gap", 1);
            _$insert(_el$182, () => localActionButton(maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently", () => void submitMaintenance(), true, undefined, {
              action: maintenanceIntent() === "export" ? "export-data" : maintenanceScope() === "all" ? "purge-all" : "purge-scope",
              subject: maintenanceScope() === "all" && maintenanceIntent() === "delete" ? "project" : `scope:${maintenanceScope()}`
            }), null);
            _$insert(_el$182, () => localActionButton("Cancel", () => {
              setMaintenanceIntent(null);
              setMaintenanceConfirmation("");
            }, false, undefined, undefined, "cancel-maintenance"), null);
            _$effect((_p$) => {
              var _v$25 = props.api.theme.current.warning, _v$26 = maintenanceConfirmation(), _v$27 = maintenancePhrase();
              _v$25 !== _p$.e && (_p$.e = _$setProp(_el$177, "borderColor", _v$25, _p$.e));
              _v$26 !== _p$.t && (_p$.t = _$setProp(_el$181, "value", _v$26, _p$.t));
              _v$27 !== _p$.a && (_p$.a = _$setProp(_el$181, "placeholder", _v$27, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$177;
          }
        }), _el$183);
        _$insert(_el$105, _$createComponent(Show, {
          get when() {
            return settings().latestExport;
          },
          children: (latestExport) => (() => {
            var _el$429 = _$createElement("box"), _el$430 = _$createElement("text"), _el$431 = _$createElement("b"), _el$433 = _$createElement("text"), _el$434 = _$createTextNode(`Scope: `), _el$435 = _$createElement("text"), _el$436 = _$createTextNode(`Private path: `), _el$437 = _$createElement("text"), _el$438 = _$createTextNode(`Size: `), _el$439 = _$createTextNode(` bytes`), _el$440 = _$createElement("text"), _el$441 = _$createTextNode(`SHA-256: `), _el$442 = _$createElement("text"), _el$443 = _$createTextNode(`Expires: `);
            _$insertNode(_el$429, _el$430);
            _$insertNode(_el$429, _el$433);
            _$insertNode(_el$429, _el$435);
            _$insertNode(_el$429, _el$437);
            _$insertNode(_el$429, _el$440);
            _$insertNode(_el$429, _el$442);
            _$setProp(_el$429, "border", true);
            _$setProp(_el$429, "paddingLeft", 1);
            _$setProp(_el$429, "paddingRight", 1);
            _$setProp(_el$429, "flexDirection", "column");
            _$insertNode(_el$430, _el$431);
            _$insertNode(_el$431, _$createTextNode(`Latest private export`));
            _$insertNode(_el$433, _el$434);
            _$setProp(_el$433, "wrapMode", "word");
            _$insert(_el$433, () => latestExport().scope, null);
            _$insertNode(_el$435, _el$436);
            _$setProp(_el$435, "wrapMode", "word");
            _$insert(_el$435, () => latestExport().path, null);
            _$insertNode(_el$437, _el$438);
            _$insertNode(_el$437, _el$439);
            _$setProp(_el$437, "wrapMode", "word");
            _$insert(_el$437, () => latestExport().bytes, _el$439);
            _$insertNode(_el$440, _el$441);
            _$setProp(_el$440, "wrapMode", "word");
            _$insert(_el$440, () => latestExport().sha256, null);
            _$insertNode(_el$442, _el$443);
            _$setProp(_el$442, "wrapMode", "word");
            _$insert(_el$442, () => new Date(latestExport().expiresAt).toISOString(), null);
            _$effect((_$p) => _$setProp(_el$429, "borderColor", props.api.theme.current.warning, _$p));
            return _el$429;
          })()
        }), _el$183);
        _$insertNode(_el$183, _el$184);
        _$insertNode(_el$183, _el$185);
        _$insertNode(_el$183, _el$186);
        _$insertNode(_el$183, _el$187);
        _$setProp(_el$183, "wrapMode", "word");
        _$insert(_el$183, () => settings().footer.hostVersion, _el$185);
        _$insert(_el$183, () => settings().footer.pluginVersion, _el$186);
        _$insert(_el$183, () => settings().footer.projectionVersion ?? "Unavailable", _el$187);
        _$insert(_el$183, () => settings().footer.dashboardVersion ?? "Unavailable", null);
        _$setProp(_el$188, "wrapMode", "word");
        _$insert(_el$188, () => settings().footer.help);
        _$effect((_p$) => {
          var _v$28 = props.api.theme.current.textMuted, _v$29 = props.api.theme.current.borderSubtle, _v$30 = props.api.theme.current.textMuted, _v$31 = props.api.theme.current.textMuted;
          _v$28 !== _p$.e && (_p$.e = _$setProp(_el$121, "fg", _v$28, _p$.e));
          _v$29 !== _p$.t && (_p$.t = _$setProp(_el$140, "borderColor", _v$29, _p$.t));
          _v$30 !== _p$.a && (_p$.a = _$setProp(_el$183, "fg", _v$30, _p$.a));
          _v$31 !== _p$.o && (_p$.o = _$setProp(_el$188, "fg", _v$31, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$105;
      }
    }), null);
    _$insertNode(_el$189, _el$190);
    _$setProp(_el$189, "flexDirection", "column");
    _$setProp(_el$189, "flexShrink", 0);
    _$setProp(_el$189, "overflow", "hidden");
    _$insertNode(_el$190, _el$191);
    _$insert(_el$190, () => props.prior().name, null);
    _$insert(_el$189, () => reactiveChild(() => props.snapshot().responses.map((completedResponse) => (() => {
      var _el$444 = _$createElement("text");
      _$setProp(_el$444, "wrapMode", "word");
      _$insert(_el$444, () => requestResponseMessage(completedResponse));
      _$effect((_$p) => _$setProp(_el$444, "fg", completedResponse.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info, _$p));
      return _el$444;
    })())), null);
    _$insert(_el$189, _$createComponent(Show, {
      get when() {
        return feedback();
      },
      get children() {
        var _el$192 = _$createElement("text");
        _$setProp(_el$192, "wrapMode", "word");
        _$insert(_el$192, feedback);
        _$effect((_$p) => _$setProp(_el$192, "fg", props.api.theme.current.info, _$p));
        return _el$192;
      }
    }), null);
    _$effect((_p$) => {
      var _v$32 = compactShell() ? 1 : 2, _v$33 = compactShell() ? 1 : 2, _v$34 = compactShell() ? 3 : "auto", _v$35 = props.api.theme.current.text, _v$36 = props.api.theme.current.textMuted, _v$37 = compactShell() ? 2 : "auto", _v$38 = props.api.theme.current.textMuted;
      _v$32 !== _p$.e && (_p$.e = _$setProp(_el$16, "paddingLeft", _v$32, _p$.e));
      _v$33 !== _p$.t && (_p$.t = _$setProp(_el$16, "paddingRight", _v$33, _p$.t));
      _v$34 !== _p$.a && (_p$.a = _$setProp(_el$17, "height", _v$34, _p$.a));
      _v$35 !== _p$.o && (_p$.o = _$setProp(_el$19, "fg", _v$35, _p$.o));
      _v$36 !== _p$.i && (_p$.i = _$setProp(_el$22, "fg", _v$36, _p$.i));
      _v$37 !== _p$.n && (_p$.n = _$setProp(_el$189, "height", _v$37, _p$.n));
      _v$38 !== _p$.s && (_p$.s = _$setProp(_el$190, "fg", _v$38, _p$.s));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined
    });
    return _el$16;
  })();
}
var tui = async (api, options, meta) => {
  if (activeApis.has(api))
    return;
  const surfaceOwnership = claimTuiSurfaceOwnership(api);
  if (!surfaceOwnership.owned) {
    console.warn(`self-evolve TUI registration skipped: ${surfaceOwnership.reason}`.slice(0, 240));
    return;
  }
  if (surfaceOwnership.duplicate)
    return;
  activeApis.add(api);
  let releaseWithNativeCleanup = false;
  api.lifecycle.onDispose(() => {
    activeApis.delete(api);
    if (!releaseWithNativeCleanup)
      surfaceOwnership.release?.();
  });
  let projectStore;
  const projectStoreFactory = options?.__testTuiStoreFactory ?? acquireProjectTuiStore;
  const compatibilityOptions = {
    ...options ?? {},
    __nativeSidebar: true,
    __testTuiStoreFactory(input) {
      projectStore = projectStoreFactory(input);
      return projectStore;
    }
  };
  await legacyModule.tui(api, compatibilityOptions, meta);
  if (!projectStore)
    return;
  releaseWithNativeCleanup = true;
  const [priorRoute, setPriorRoute] = createSignal({
    name: "home"
  });
  const initialSnapshot = projectStore.getSnapshot();
  const [snapshot, setSnapshot] = createSignal(initialSnapshot);
  let activeSnapshotIdentity = snapshotIdentity(initialSnapshot);
  const unsubscribe = projectStore.subscribe((next) => {
    const nextIdentity = snapshotIdentity(next);
    if (activeSnapshotIdentity !== nextIdentity) {
      setPriorRoute({
        name: "home"
      });
      if (api.route.current.name === CONTROL_CENTER_ROUTE) {
        api.route.navigate(CONTROL_CENTER_ROUTE, {
          section: "home"
        });
      }
    }
    activeSnapshotIdentity = nextIdentity;
    setSnapshot(next);
  });
  api.lifecycle.onDispose(unsubscribe);
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE)
      return;
    const prior = priorRoute();
    api.route.navigate(prior.name, prior.params);
  };
  const openControlCenter = (destination = {
    section: "home"
  }) => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      setPriorRoute({
        name: api.route.current.name,
        ..."params" in api.route.current ? {
          params: api.route.current.params
        } : {}
      });
    }
    api.route.navigate(CONTROL_CENTER_ROUTE, controlCenterRouteParams(destination, snapshot()));
  };
  const unregisterRoute = api.route.register([{
    name: CONTROL_CENTER_ROUTE,
    render: () => _$createComponent(ControlCenter, {
      api,
      store: projectStore,
      snapshot,
      prior: priorRoute,
      get initial() {
        return parseControlCenterDestination("params" in api.route.current ? api.route.current.params : undefined, snapshot());
      }
    })
  }]);
  const unregisterPaletteKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.paletteLayer,
    commands: [{
      name: CONTROL_CENTER_COMMAND,
      title: "Self-evolve control center",
      category: "Self-evolve",
      namespace: "palette",
      run: () => openControlCenter({
        section: "home"
      })
    }]
  });
  const unregisterControlCenterKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.modeLayer,
    mode: CONTROL_CENTER_MODE,
    bindings: [{
      key: "escape",
      cmd: closeControlCenter,
      desc: "Close self-evolve control center"
    }]
  });
  api.lifecycle.onDispose(() => {
    if (surfaceOwnership.owns?.() && api.route.current.name === CONTROL_CENTER_ROUTE) {
      const prior = priorRoute();
      api.route.navigate(prior.name, prior.params);
    }
    if (surfaceOwnership.owns?.()) {
      unregisterRoute?.();
      if (typeof unregisterPaletteKeymap === "function")
        unregisterPaletteKeymap();
      if (typeof unregisterControlCenterKeymap === "function")
        unregisterControlCenterKeymap();
    }
    surfaceOwnership.release?.();
  });
  api.slots.register({
    order: 275,
    slots: {
      sidebar_content() {
        return _$createComponent(SidebarCard, {
          api,
          card: () => deriveSidebarCard(snapshot()),
          open: () => {
            const card = deriveSidebarCard(snapshot());
            openControlCenter(card.destination);
          }
        });
      }
    }
  });
};
var SelfEvolveTuiModule = {
  id: "mcrescenzo.self-evolve",
  tui
};
var self_evolve_tui_default = SelfEvolveTuiModule;
export {
  self_evolve_tui_default as default
};
