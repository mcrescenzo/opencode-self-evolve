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
import { batch, createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { setTimeout as delay } from "timers/promises";
import legacyModule, { TUI_IDENTITIES, attemptTuiStartup, claimTuiSurfaceOwnership } from "./self-evolve-tui.js";
import { CONTROL_CENTER_SECTIONS, acquireProjectTuiStore, buildControlCenterModel, controlCenterRouteParams, createInertRecoveryStore, deriveSidebarCard, deriveSidebarModeControl, parseControlCenterDestination, validateApprovedSkillFolderInput } from "./self-evolve-tui-store.js";
var CARD_ID = "self-evolve-sidebar-card";
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
function globalSnapshotIdentity(snapshot) {
  return snapshot?.stateRootIdentity ?? snapshot?.global?.stateRootIdentity ?? null;
}
function recommendationRecords(snapshot) {
  const global = snapshot?.global?.projection?.index?.recommendations;
  if (Array.isArray(global))
    return global.map((entry) => ({
      id: entry.recommendationId,
      state: entry.state
    }));
  return (snapshot?.projection?.index?.reviews ?? []).filter((entry) => entry.state !== "critic-pending").map((entry) => ({
    id: entry.proposalId,
    state: entry.state
  }));
}
function recommendationFilterForState(state) {
  if (state === null || state === undefined)
    return "needs-review";
  if (["pending", "approved"].includes(state ?? ""))
    return "needs-review";
  if (["applied", "rolled-back"].includes(state ?? ""))
    return "applied";
  if (["rejected", "superseded"].includes(state ?? ""))
    return "dismissed";
  return "all";
}
function recommendationFilterIncludesState(filter, state) {
  return filter === "all" || recommendationFilterForState(state) === filter;
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
function SidebarModeControl(props) {
  const [confirmation, setConfirmation] = createSignal(false);
  const [feedback, setFeedback] = createSignal(null);
  const [focused, setFocused] = createSignal(null);
  const nodes = new Map;
  const model = () => deriveSidebarModeControl(props.snapshot());
  let projectIdentity = props.snapshot()?.projectFingerprint ?? null;
  createEffect(() => {
    const snapshot = props.snapshot();
    const nextProject = snapshot?.projectFingerprint ?? null;
    if (nextProject !== projectIdentity || !deriveSidebarModeControl(snapshot).available) {
      projectIdentity = nextProject;
      setConfirmation(false);
      setFeedback(null);
    }
  });
  useKeyboard((event) => {
    if (event.name !== "tab")
      return;
    const node = nodes.get("off") ?? nodes.get("on");
    let root = node;
    while (root?.parent)
      root = root.parent;
    const card = root?.findDescendantById(CARD_ID);
    const candidates = [card, nodes.get("off"), nodes.get("on")].filter((value) => Boolean(value?.focusable && value.visible));
    const current = candidates.findIndex((value) => value.focused);
    if (current < 0)
      return;
    const navigationEvent = event;
    navigationEvent.preventDefault();
    navigationEvent.stopPropagation();
    const offset = navigationEvent.shift ? -1 : 1;
    candidates[(current + offset + candidates.length) % candidates.length].focus();
  });
  const activate = async (value) => {
    const current = model();
    if (!current.available || current.pending || current.current === value)
      return;
    if (value === "on" && !confirmation()) {
      setConfirmation(true);
      setFeedback("Turning On also enables Saved structured patterns, Sanitized evidence excerpts, and Cross-project learning. Recommendations never apply without approval. Activate Confirm On to continue.");
      return;
    }
    try {
      await props.store.submitOperation("set-automatic-recommendations", {
        enabled: value === "on"
      });
      setConfirmation(false);
      setFeedback(value === "off" ? "Automatic recommendations were turned off." : "Automatic recommendations were turned on.");
    } catch (error) {
      setConfirmation(false);
      setFeedback(`Automatic recommendations were not changed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return (() => {
    var _el$7 = _$createElement("box"), _el$8 = _$createElement("box");
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$7, "flexDirection", "column");
    _$setProp(_el$7, "width", "100%");
    _$setProp(_el$8, "flexDirection", "row");
    _$setProp(_el$8, "width", "100%");
    _$insert(_el$8, () => model().options.map((option) => {
      const key = `sidebar-mode:${option.value}`;
      const selected = () => model().current === option.value;
      const enabled = () => model().available;
      const label = () => option.value === "on" && confirmation() ? "Confirm On" : option.label;
      return (() => {
        var _el$0 = _$createElement("box"), _el$1 = _$createElement("text");
        _$insertNode(_el$0, _el$1);
        _$use((value) => nodes.set(option.value, value), _el$0);
        _$setProp(_el$0, "border", true);
        _$setProp(_el$0, "flexGrow", 1);
        _$setProp(_el$0, "paddingLeft", 1);
        _$setProp(_el$0, "paddingRight", 1);
        _$setProp(_el$0, "on:focused", () => setFocused(key));
        _$setProp(_el$0, "on:blurred", () => setFocused((value) => value === key ? null : value));
        _$setProp(_el$0, "onMouseDown", () => nodes.get(option.value)?.focus());
        _$setProp(_el$0, "onMouseUp", () => {
          if (enabled())
            activate(option.value);
        });
        _$setProp(_el$0, "onKeyDown", (event) => {
          if (!isActivationKey(event) || !enabled())
            return;
          event.preventDefault();
          activate(option.value);
        });
        _$insert(_el$1, (() => {
          var _c$ = _$memo(() => focused() === key);
          return () => _c$() ? "\u203A " : selected() ? "\u2022 " : "  ";
        })(), null);
        _$insert(_el$1, label, null);
        _$insert(_el$1, () => model().pending ? " \xB7 Pending" : "", null);
        _$effect((_p$) => {
          var _v$7 = `self-evolve-sidebar-mode-${option.value}`, _v$8 = enabled(), _v$9 = focused() === key ? props.api.theme.current.borderActive : selected() ? props.api.theme.current.info : props.api.theme.current.borderSubtle, _v$0 = enabled() ? props.api.theme.current.text : props.api.theme.current.textMuted;
          _v$7 !== _p$.e && (_p$.e = _$setProp(_el$0, "id", _v$7, _p$.e));
          _v$8 !== _p$.t && (_p$.t = _$setProp(_el$0, "focusable", _v$8, _p$.t));
          _v$9 !== _p$.a && (_p$.a = _$setProp(_el$0, "borderColor", _v$9, _p$.a));
          _v$0 !== _p$.o && (_p$.o = _$setProp(_el$1, "fg", _v$0, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$0;
      })();
    }));
    _$insert(_el$7, _$createComponent(Show, {
      get when() {
        return !model().available || feedback();
      },
      get children() {
        var _el$9 = _$createElement("text");
        _$setProp(_el$9, "wrapMode", "word");
        _$insert(_el$9, () => feedback() ?? `Automatic recommendations are read-only: ${model().status}.`);
        _$effect((_$p) => _$setProp(_el$9, "fg", !model().available ? props.api.theme.current.textMuted : props.api.theme.current.info, _$p));
        return _el$9;
      }
    }), null);
    return _el$7;
  })();
}
function ControlCenter(props) {
  const names = CONTROL_CENTER_SECTIONS;
  const [section, setSection] = createSignal(props.initial.section);
  const initialSelectedIndex = props.initial.section === "recommendations" ? props.initial.selectedIndex ?? 0 : 0;
  const [selectedIndex, setSelectedIndex] = createSignal(initialSelectedIndex);
  const initialRecommendationState = props.initial.section === "recommendations" ? recommendationRecords(props.snapshot())[initialSelectedIndex]?.state : null;
  const [recommendationFilter, setRecommendationFilter] = createSignal(recommendationFilterForState(initialRecommendationState));
  const [activityFilter, setActivityFilter] = createSignal(props.initial.filter ?? "all");
  const [settingsAnchor, setSettingsAnchor] = createSignal(props.initial.anchor);
  const [rejectionReason, setRejectionReason] = createSignal(null);
  const [rejectionText, setRejectionText] = createSignal("");
  const [technicalExpanded, setTechnicalExpanded] = createSignal(false);
  const [activityExpanded, setActivityExpanded] = createSignal(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false);
  const [outcomesExpanded, setOutcomesExpanded] = createSignal(false);
  const [feedback, setFeedback] = createSignal(null);
  const [confirmation, setConfirmation] = createSignal(null);
  const [consentIntent, setConsentIntent] = createSignal(null);
  const [folderInput, setFolderInput] = createSignal("");
  const [folderError, setFolderError] = createSignal(null);
  const [folderDraft, setFolderDraft] = createSignal(null);
  const [folderConfirmation, setFolderConfirmation] = createSignal("");
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
  let mountedGlobalIdentity = globalSnapshotIdentity(props.snapshot());
  let selectedRecommendationId = props.initial.section === "recommendations" ? recommendationRecords(props.snapshot())[props.initial.selectedIndex ?? 0]?.id ?? null : null;
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
    setMaintenanceIntent(null);
    setMaintenanceConfirmation("");
    setOutcomesExpanded(false);
  };
  const resetForGlobalIdentity = () => {
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
  const clearInvalidRecommendation = () => {
    focusableDescendants().find((node) => node.focused)?.blur();
    batch(() => {
      selectedRecommendationId = null;
      setSection("home");
      setSelectedIndex(0);
      setRecommendationFilter("needs-review");
      setSettingsAnchor(undefined);
      setTechnicalExpanded(false);
      setFocusedControl(null);
      clearPreparedAuthority();
      props.store.selectDetails([]);
      if (props.api.route.current.name === CONTROL_CENTER_ROUTE) {
        props.api.route.navigate(CONTROL_CENTER_ROUTE, {
          section: "home"
        });
      }
    });
  };
  const currentRecommendationToken = () => {
    const route = props.api.route.current;
    const params = route.name === CONTROL_CENTER_ROUTE && "params" in route ? route.params : undefined;
    return selectedRecommendationId ?? (params?.section === "recommendations" && typeof params.recommendation === "string" ? params.recommendation : null);
  };
  let observedRouteRevision = props.routeRevision();
  createEffect(() => {
    const revision = props.routeRevision();
    if (revision === observedRouteRevision)
      return;
    observedRouteRevision = revision;
    clearInvalidRecommendation();
  });
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE);
    if (props.initial.section === "recommendations")
      selectRecommendation(selectedIndex());
    unsubscribeIdentity = props.store.subscribe((next) => {
      const nextIdentity = snapshotIdentity(next);
      const nextGlobalIdentity = globalSnapshotIdentity(next);
      if (mountedGlobalIdentity !== nextGlobalIdentity) {
        resetForGlobalIdentity();
        selectedRecommendationId = null;
      } else if (mountedIdentity !== nextIdentity) {
        clearPreparedAuthority();
        setSettingsAnchor(undefined);
        setActivityExpanded(null);
        setDiagnosticsExpanded(false);
        setMaintenanceScope("observations");
      } else if (mountedPhase !== "error" && next.phase === "error") {
        clearPreparedAuthority();
      }
      const recommendationToken = currentRecommendationToken();
      if (recommendationToken !== null) {
        const retained = recommendationRecords(next).findIndex((entry) => entry.id === recommendationToken);
        if (retained < 0)
          clearInvalidRecommendation();
        else {
          const retainedState = recommendationRecords(next)[retained]?.state;
          if (!recommendationFilterIncludesState(recommendationFilter(), retainedState)) {
            setRecommendationFilter(recommendationFilterForState(retainedState));
          }
          selectedRecommendationId = recommendationToken;
          setSelectedIndex(retained);
        }
      }
      mountedIdentity = nextIdentity;
      mountedGlobalIdentity = nextGlobalIdentity;
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
    const reviews = recommendationRecords(props.snapshot());
    if (!reviews[sourceIndex])
      return;
    setSelectedIndex(sourceIndex);
    selectedRecommendationId = reviews[sourceIndex].id;
    const adjacent = reviews[sourceIndex + 1]?.id ?? reviews[sourceIndex - 1]?.id;
    const ids = [reviews[sourceIndex].id, adjacent].filter(Boolean).slice(0, 2);
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
      var _el$10 = _$createElement("box"), _el$11 = _$createElement("text");
      _$insertNode(_el$10, _el$11);
      _$setProp(_el$10, "border", true);
      _$setProp(_el$10, "paddingLeft", 1);
      _$setProp(_el$10, "paddingRight", 1);
      _$setProp(_el$10, "onMouseUp", () => {
        if (!disabled())
          invoke(key, operation, requiresConfirmation);
      });
      _$setProp(_el$10, "onKeyDown", (event) => {
        if (!isActivationKey(event) || disabled())
          return;
        event.preventDefault();
        invoke(key, operation, requiresConfirmation);
      });
      _$insert(_el$11, () => focusMark(`action:${key}`), null);
      _$insert(_el$11, (() => {
        var _c$2 = _$memo(() => !!disabled());
        return () => _c$2() ? `${label} \xB7 Pending` : confirmation() === key ? `Confirm ${label}` : label;
      })(), null);
      _$effect((_p$) => {
        var _v$1 = focusId(`action:${key}`), _v$10 = !disabled(), _v$11 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$12 = focus.focused, _v$13 = focus.blurred, _v$14 = disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text;
        _v$1 !== _p$.e && (_p$.e = _$setProp(_el$10, "id", _v$1, _p$.e));
        _v$10 !== _p$.t && (_p$.t = _$setProp(_el$10, "focusable", _v$10, _p$.t));
        _v$11 !== _p$.a && (_p$.a = _$setProp(_el$10, "borderColor", _v$11, _p$.a));
        _v$12 !== _p$.o && (_p$.o = _$setProp(_el$10, "on:focused", _v$12, _p$.o));
        _v$13 !== _p$.i && (_p$.i = _$setProp(_el$10, "on:blurred", _v$13, _p$.i));
        _v$14 !== _p$.n && (_p$.n = _$setProp(_el$11, "fg", _v$14, _p$.n));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined
      });
      return _el$10;
    })();
  };
  const localActionButton = (label, operation, warning = false, confirmationKey, pendingRequest, focusKey) => {
    const disabled = () => pendingRequest ? requestPending(pendingRequest.action, pendingRequest.subject) : false;
    const key = `local:${focusKey ?? confirmationKey ?? label}`;
    const focus = focusHandlers(key);
    return (() => {
      var _el$12 = _$createElement("box"), _el$13 = _$createElement("text");
      _$insertNode(_el$12, _el$13);
      _$setProp(_el$12, "border", true);
      _$setProp(_el$12, "paddingLeft", 1);
      _$setProp(_el$12, "paddingRight", 1);
      _$setProp(_el$12, "onMouseUp", () => {
        if (!disabled())
          operation();
      });
      _$setProp(_el$12, "onKeyDown", (event) => {
        if (!isActivationKey(event) || disabled())
          return;
        event.preventDefault();
        operation();
      });
      _$insert(_el$13, () => focusMark(key), null);
      _$insert(_el$13, (() => {
        var _c$3 = _$memo(() => !!disabled());
        return () => _c$3() ? `${label} \xB7 Pending` : confirmation() === confirmationKey ? `Confirm ${label}` : label;
      })(), null);
      _$effect((_p$) => {
        var _v$15 = focusId(key), _v$16 = !disabled(), _v$17 = warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$18 = focus.focused, _v$19 = focus.blurred, _v$20 = disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text;
        _v$15 !== _p$.e && (_p$.e = _$setProp(_el$12, "id", _v$15, _p$.e));
        _v$16 !== _p$.t && (_p$.t = _$setProp(_el$12, "focusable", _v$16, _p$.t));
        _v$17 !== _p$.a && (_p$.a = _$setProp(_el$12, "borderColor", _v$17, _p$.a));
        _v$18 !== _p$.o && (_p$.o = _$setProp(_el$12, "on:focused", _v$18, _p$.o));
        _v$19 !== _p$.i && (_p$.i = _$setProp(_el$12, "on:blurred", _v$19, _p$.i));
        _v$20 !== _p$.n && (_p$.n = _$setProp(_el$13, "fg", _v$20, _p$.n));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined
      });
      return _el$12;
    })();
  };
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true;
  const home = () => model().sections.home;
  const recommendations = () => model().sections.recommendations;
  const activity = () => model().sections.activity;
  const settings = () => model().sections.settings;
  const settingsAnchorControl = (anchor) => {
    if (anchor === "automatic-recommendations" || anchor === "setup") {
      return `anchor:${anchor}`;
    }
    if (anchor === "emergency-stop") {
      return `action:${emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop"}`;
    }
    if (anchor === "project-scope") {
      return `action:${settings().projectExcluded ? "include-project" : "exclude-project"}`;
    }
    const consentKey = anchor === "observation-consent" ? "durableObservations" : null;
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
  const setAutomaticRecommendations = (enabled) => props.store.submitOperation("set-automatic-recommendations", {
    enabled
  });
  const openConsentDisclosure = (key) => {
    setConsentIntent(key);
    setFeedback("Review the privacy disclosure, then confirm or cancel the consent change.");
  };
  const confirmConsent = async (key) => {
    await props.store.submitOperation("set-permission", {
      permission: key,
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
      var _el$14 = _$createElement("box"), _el$15 = _$createElement("text"), _el$16 = _$createElement("b"), _el$18 = _$createElement("text"), _el$19 = _$createElement("text"), _el$20 = _$createElement("box");
      _$insertNode(_el$14, _el$15);
      _$insertNode(_el$14, _el$18);
      _$insertNode(_el$14, _el$19);
      _$insertNode(_el$14, _el$20);
      _$setProp(_el$14, "border", true);
      _$setProp(_el$14, "paddingLeft", 1);
      _$setProp(_el$14, "paddingRight", 1);
      _$setProp(_el$14, "flexDirection", "column");
      _$setProp(_el$14, "gap", 1);
      _$insertNode(_el$15, _el$16);
      _$insertNode(_el$16, _$createTextNode(`Consent disclosure`));
      _$setProp(_el$18, "wrapMode", "word");
      _$insert(_el$18, () => entry().description);
      _$setProp(_el$19, "wrapMode", "word");
      _$insert(_el$19, () => entry().dependency);
      _$setProp(_el$20, "flexDirection", "row");
      _$setProp(_el$20, "flexWrap", "wrap");
      _$setProp(_el$20, "gap", 1);
      _$insert(_el$20, () => actionButton(`confirm-consent-${key}`, `Confirm allow ${entry().label}`, () => confirmConsent(key), false, {
        action: "set-permission",
        subject: `permission:${key}`
      }), null);
      _$insert(_el$20, () => localActionButton("Cancel consent change", () => setConsentIntent(null), false, undefined, undefined, `cancel-consent:${key}`), null);
      _$effect((_p$) => {
        var _v$21 = props.api.theme.current.warning, _v$22 = props.api.theme.current.textMuted;
        _v$21 !== _p$.e && (_p$.e = _$setProp(_el$14, "borderColor", _v$21, _p$.e));
        _v$22 !== _p$.t && (_p$.t = _$setProp(_el$19, "fg", _v$22, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$14;
    })()
  });
  const stageFolderList = (next) => {
    if (!next.length) {
      setFolderError("At least one authoritative global root is required.");
      return;
    }
    setFolderDraft(next.map((root) => ({
      ...root
    })));
    setFolderConfirmation("");
    setFolderError(null);
    setFeedback("Review the complete authoritative root policy, then type the version-bound confirmation phrase.");
  };
  const stageFolderAdd = () => {
    const checked = validateApprovedSkillFolderInput(folderInput(), settings().approvedSkillFolders);
    if (!checked.ok) {
      setFolderError(checked.error);
      return;
    }
    setFolderInput("");
    stageFolderList([...settings().globalRoots, {
      canonicalPath: checked.value,
      canUpdate: true,
      canCreate: false,
      primaryCreationRoot: false
    }]);
    setFolderError(checked.warning);
  };
  const updateFolderDraft = (index, change) => {
    setFolderDraft((current) => current?.map((root, currentIndex) => currentIndex === index ? {
      ...root,
      ...change
    } : root) ?? null);
    setFolderConfirmation("");
    setFolderError(null);
  };
  const submitFolderList = async () => {
    const draft = folderDraft();
    const phrase = settings().globalRootPolicyConfirmation;
    if (!draft?.length) {
      setFolderError("At least one authoritative global root is required.");
      return;
    }
    if (!phrase || folderConfirmation() !== phrase) {
      setFolderError(`The exact phrase ${phrase ?? "shown by the fresh server projection"} is required.`);
      return;
    }
    if (draft.some((root) => !root.canUpdate && !root.canCreate)) {
      setFolderError("Every root must allow update, create, or both.");
      return;
    }
    const createRoots = draft.filter((root) => root.canCreate);
    const primaryRoots = draft.filter((root) => root.primaryCreationRoot);
    if (createRoots.length === 0 && primaryRoots.length !== 0 || createRoots.length !== 0 && (createRoots.length !== 1 || primaryRoots.length !== 1 || createRoots[0] !== primaryRoots[0])) {
      setFolderError("Creation authority requires one sole create-capable root selected as the primary creation root.");
      return;
    }
    try {
      const roots = [...draft].sort((left, right) => left.canonicalPath < right.canonicalPath ? -1 : left.canonicalPath > right.canonicalPath ? 1 : 0).map(({
        canonicalPath,
        canUpdate,
        canCreate
      }) => ({
        canonicalPath,
        canUpdate,
        canCreate
      }));
      await props.store.submitOperation("replace-global-root-policy", {
        roots,
        creationRootPath: primaryRoots[0]?.canonicalPath ?? null,
        confirmation: phrase
      });
      setFolderDraft(null);
      setFolderConfirmation("");
      setFolderError(null);
      setFeedback("Authoritative global root replacement submitted for transactional server revalidation.");
    } catch (error) {
      setFolderError(`Root-policy replacement was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const maintenancePhrase = () => maintenanceIntent() === "export" ? "EXPORT SENSITIVE SELF-EVOLVE DATA" : maintenanceScope() === "all" ? "PURGE ALL SELF-EVOLVE 0.4.0" : `PURGE ${maintenanceScope().toUpperCase()}`;
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
    const state = recommendationRecords(props.snapshot())[sourceIndex]?.state;
    setRecommendationFilter(recommendationFilterForState(state));
    selectRecommendation(sourceIndex);
    navigate({
      section: "recommendations",
      selectedIndex: sourceIndex
    });
  };
  const selectedProposalId = () => {
    const sourceIndex = recommendations().selected?.sourceIndex;
    return Number.isSafeInteger(sourceIndex) ? recommendationRecords(props.snapshot())[sourceIndex]?.id ?? null : null;
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
      props.store.acknowledgeOutcome(proposalId);
      setFeedback("Applied result acknowledged locally. Activity history was retained.");
      return;
    }
    const key = `${action}:${snoozeMs ?? ""}`;
    if (["apply", "apply-proposal"].includes(action) && confirmation() !== key) {
      setConfirmation(key);
      setFeedback(`Activate \u201CConfirm ${action.replaceAll("-", " ")}\u201D to continue.`);
      return;
    }
    try {
      if (["apply", "reject", "undo"].includes(action)) {
        await props.store.submitRecommendationAction(proposalId, action);
      } else if (action === "apply-proposal") {
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
    var _el$21 = _$createElement("box"), _el$22 = _$createElement("box"), _el$23 = _$createElement("box"), _el$24 = _$createElement("text"), _el$25 = _$createElement("b"), _el$27 = _$createElement("text"), _el$28 = _$createTextNode(` \xB7 Automatic recommendations `), _el$29 = _$createElement("box"), _el$30 = _$createElement("scrollbox"), _el$176 = _$createElement("box"), _el$177 = _$createElement("text"), _el$178 = _$createTextNode(`Esc returns to `);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$29);
    _$insertNode(_el$21, _el$30);
    _$insertNode(_el$21, _el$176);
    _$use((value) => controlCenterNode = value, _el$21);
    _$setProp(_el$21, "id", CONTROL_CENTER_VIEW_ID);
    _$setProp(_el$21, "focusable", true);
    _$setProp(_el$21, "width", "100%");
    _$setProp(_el$21, "height", "100%");
    _$setProp(_el$21, "flexDirection", "column");
    _$insertNode(_el$22, _el$23);
    _$setProp(_el$22, "flexDirection", "row");
    _$setProp(_el$22, "gap", 1);
    _$setProp(_el$22, "flexWrap", "wrap");
    _$setProp(_el$22, "flexShrink", 0);
    _$setProp(_el$22, "overflow", "hidden");
    _$insertNode(_el$23, _el$24);
    _$insertNode(_el$23, _el$27);
    _$setProp(_el$23, "flexDirection", "column");
    _$setProp(_el$23, "flexGrow", 1);
    _$insertNode(_el$24, _el$25);
    _$insertNode(_el$25, _$createTextNode(`Self-evolve`));
    _$insertNode(_el$27, _el$28);
    _$setProp(_el$27, "wrapMode", "word");
    _$insert(_el$27, () => model().operational.label, _el$28);
    _$insert(_el$27, () => home().automaticRecommendationsEnabled ? "On" : "Off", null);
    _$insert(_el$22, _$createComponent(Show, {
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
    _$setProp(_el$29, "flexDirection", "row");
    _$setProp(_el$29, "gap", 1);
    _$setProp(_el$29, "flexWrap", "wrap");
    _$setProp(_el$29, "flexShrink", 0);
    _$setProp(_el$29, "height", 3);
    _$setProp(_el$29, "overflow", "hidden");
    _$insert(_el$29, () => names.map((name) => (() => {
      var _el$179 = _$createElement("box"), _el$180 = _$createElement("text");
      _$insertNode(_el$179, _el$180);
      _$setProp(_el$179, "focusable", true);
      _$setProp(_el$179, "border", true);
      _$setProp(_el$179, "paddingLeft", 1);
      _$setProp(_el$179, "paddingRight", 1);
      _$setProp(_el$179, "on:focused", () => setFocusedControl(`section:${name}`));
      _$setProp(_el$179, "on:blurred", () => setFocusedControl((current) => current === `section:${name}` ? null : current));
      _$setProp(_el$179, "onMouseUp", () => navigate({
        section: name
      }));
      _$setProp(_el$179, "onKeyDown", (event) => {
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
      _$insert(_el$180, () => focusMark(`section:${name}`), null);
      _$insert(_el$180, () => name.charAt(0).toUpperCase() + name.slice(1), null);
      _$insert(_el$180, (() => {
        var _c$6 = _$memo(() => !!(name === "recommendations" && model().operational.count > 0));
        return () => _c$6() ? ` (${model().operational.count})` : "";
      })(), null);
      _$effect((_p$) => {
        var _v$49 = focusId(`section:${name}`), _v$50 = section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$51 = section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted;
        _v$49 !== _p$.e && (_p$.e = _$setProp(_el$179, "id", _v$49, _p$.e));
        _v$50 !== _p$.t && (_p$.t = _$setProp(_el$179, "borderColor", _v$50, _p$.t));
        _v$51 !== _p$.a && (_p$.a = _$setProp(_el$180, "fg", _v$51, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$179;
    })()));
    _$use((value) => contentScrollbox = value, _el$30);
    _$setProp(_el$30, "id", "self-evolve-content-scrollbox");
    _$setProp(_el$30, "flexGrow", 1);
    _$setProp(_el$30, "minHeight", 1);
    _$setProp(_el$30, "width", "100%");
    _$setProp(_el$30, "onMouseScroll", () => cancelDestinationFocus());
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return model().recovery;
      },
      children: (recovery) => (() => {
        var _el$181 = _$createElement("box"), _el$182 = _$createElement("text"), _el$183 = _$createElement("b"), _el$184 = _$createElement("text"), _el$185 = _$createTextNode(`Latest refresh failed: `), _el$186 = _$createElement("text");
        _$insertNode(_el$181, _el$182);
        _$insertNode(_el$181, _el$184);
        _$insertNode(_el$181, _el$186);
        _$setProp(_el$181, "border", true);
        _$setProp(_el$181, "paddingLeft", 1);
        _$setProp(_el$181, "paddingRight", 1);
        _$setProp(_el$181, "flexDirection", "column");
        _$setProp(_el$181, "gap", 1);
        _$insertNode(_el$182, _el$183);
        _$insert(_el$183, () => recovery().stale ? "Read-only stale snapshot" : "Projection unavailable");
        _$insertNode(_el$184, _el$185);
        _$setProp(_el$184, "wrapMode", "word");
        _$insert(_el$184, () => recovery().diagnostic, null);
        _$insertNode(_el$186, _$createTextNode(`Decision, control, and operation actions are unavailable until a fresh projection is negotiated.`));
        _$setProp(_el$186, "wrapMode", "word");
        _$insert(_el$181, _$createComponent(Show, {
          get when() {
            return recovery().canRetry;
          },
          get children() {
            return localActionButton("Retry", () => void retryProjection());
          }
        }), null);
        _$effect((_p$) => {
          var _v$52 = props.api.theme.current.error, _v$53 = props.api.theme.current.textMuted;
          _v$52 !== _p$.e && (_p$.e = _$setProp(_el$181, "borderColor", _v$52, _p$.e));
          _v$53 !== _p$.t && (_p$.t = _$setProp(_el$186, "fg", _v$53, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$181;
      })()
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "home";
      },
      get children() {
        var _el$31 = _$createElement("box"), _el$32 = _$createElement("text"), _el$33 = _$createElement("b"), _el$35 = _$createElement("text"), _el$36 = _$createElement("b"), _el$37 = _$createElement("text"), _el$38 = _$createElement("text"), _el$39 = _$createElement("box"), _el$40 = _$createElement("text"), _el$41 = _$createElement("b"), _el$43 = _$createElement("text"), _el$44 = _$createTextNode(`Automatic recommendations: `), _el$45 = _$createElement("text"), _el$46 = _$createTextNode(`This project: `);
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$31, _el$35);
        _$insertNode(_el$31, _el$37);
        _$insertNode(_el$31, _el$38);
        _$insertNode(_el$31, _el$39);
        _$setProp(_el$31, "flexDirection", "column");
        _$setProp(_el$31, "gap", 1);
        _$insertNode(_el$32, _el$33);
        _$insertNode(_el$33, _$createTextNode(`Home`));
        _$insertNode(_el$35, _el$36);
        _$insert(_el$36, () => home().operational.label);
        _$setProp(_el$37, "wrapMode", "word");
        _$insert(_el$37, () => home().operational.explanation);
        _$setProp(_el$38, "wrapMode", "word");
        _$insert(_el$38, () => home().operational.nextAction);
        _$insertNode(_el$39, _el$40);
        _$insertNode(_el$39, _el$43);
        _$insertNode(_el$39, _el$45);
        _$setProp(_el$39, "border", true);
        _$setProp(_el$39, "paddingLeft", 1);
        _$setProp(_el$39, "paddingRight", 1);
        _$setProp(_el$39, "flexDirection", "column");
        _$insertNode(_el$40, _el$41);
        _$insertNode(_el$41, _$createTextNode(`Automation and scope`));
        _$insertNode(_el$43, _el$44);
        _$setProp(_el$43, "wrapMode", "word");
        _$insert(_el$43, () => home().automaticRecommendationsEnabled ? "On" : "Off", null);
        _$insertNode(_el$45, _el$46);
        _$setProp(_el$45, "wrapMode", "word");
        _$insert(_el$45, () => settings().projectExcluded ? "Excluded" : "Included", null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().globalReadiness;
          },
          children: (globalReadiness) => (() => {
            var _el$188 = _$createElement("box"), _el$189 = _$createElement("text"), _el$190 = _$createElement("b"), _el$192 = _$createTextNode(`: `), _el$193 = _$createElement("text"), _el$194 = _$createTextNode(`Protocol: `);
            _$insertNode(_el$188, _el$189);
            _$insertNode(_el$188, _el$193);
            _$setProp(_el$188, "border", true);
            _$setProp(_el$188, "paddingLeft", 1);
            _$setProp(_el$188, "paddingRight", 1);
            _$setProp(_el$188, "flexDirection", "column");
            _$insertNode(_el$189, _el$190);
            _$insertNode(_el$189, _el$192);
            _$insertNode(_el$190, _$createTextNode(`Global recommendations`));
            _$insert(_el$189, () => globalReadiness().state === "ready" ? "Ready" : "Limited / read-only", null);
            _$insertNode(_el$193, _el$194);
            _$setProp(_el$193, "wrapMode", "word");
            _$insert(_el$193, () => globalReadiness().label, null);
            _$insert(_el$188, _$createComponent(Show, {
              get when() {
                return globalReadiness().recommendationCount !== null;
              },
              get children() {
                var _el$195 = _$createElement("text"), _el$196 = _$createTextNode(` global recommendation`);
                _$insertNode(_el$195, _el$196);
                _$insert(_el$195, () => globalReadiness().recommendationCount, _el$196);
                _$insert(_el$195, () => globalReadiness().recommendationCount === 1 ? "" : "s", null);
                return _el$195;
              }
            }), null);
            _$insert(_el$188, _$createComponent(Show, {
              get when() {
                return globalReadiness().reason;
              },
              get children() {
                var _el$197 = _$createElement("text");
                _$setProp(_el$197, "wrapMode", "word");
                _$insert(_el$197, () => globalReadiness().reason);
                _$effect((_$p) => _$setProp(_el$197, "fg", props.api.theme.current.textMuted, _$p));
                return _el$197;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$188, "borderColor", globalReadiness().state === "ready" ? props.api.theme.current.borderSubtle : props.api.theme.current.warning, _$p));
            return _el$188;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().blockers.length;
          },
          get children() {
            var _el$47 = _$createElement("box"), _el$48 = _$createElement("text"), _el$49 = _$createElement("b");
            _$insertNode(_el$47, _el$48);
            _$setProp(_el$47, "flexDirection", "column");
            _$insertNode(_el$48, _el$49);
            _$insertNode(_el$49, _$createTextNode(`Setup`));
            _$insert(_el$47, () => reactiveChild(() => home().blockers.map((blocker) => (() => {
              var _el$198 = _$createElement("box"), _el$199 = _$createElement("text"), _el$200 = _$createTextNode(` \xB7 Open `);
              _$insertNode(_el$198, _el$199);
              _$setProp(_el$198, "focusable", true);
              _$setProp(_el$198, "border", true);
              _$setProp(_el$198, "paddingLeft", 1);
              _$setProp(_el$198, "paddingRight", 1);
              _$setProp(_el$198, "on:focused", () => setFocusedControl(`blocker:${blocker.code}`));
              _$setProp(_el$198, "on:blurred", () => setFocusedControl((current) => current === `blocker:${blocker.code}` ? null : current));
              _$setProp(_el$198, "onMouseUp", () => navigate(blocker.destination));
              _$setProp(_el$198, "onKeyDown", (event) => {
                if (!isActivationKey(event))
                  return;
                event.preventDefault();
                navigate(blocker.destination);
              });
              _$insertNode(_el$199, _el$200);
              _$setProp(_el$199, "wrapMode", "word");
              _$insert(_el$199, () => focusMark(`blocker:${blocker.code}`), _el$200);
              _$insert(_el$199, () => blocker.summary, _el$200);
              _$insert(_el$199, (() => {
                var _c$7 = _$memo(() => blocker.destination.section === "activity");
                return () => _c$7() ? "Activity errors" : blocker.destination.section.charAt(0).toUpperCase() + blocker.destination.section.slice(1);
              })(), null);
              _$effect((_$p) => _$setProp(_el$198, "borderColor", props.api.theme.current.warning, _$p));
              return _el$198;
            })())), null);
            return _el$47;
          }
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().lastCycle;
          },
          children: (lastCycle) => (() => {
            var _el$201 = _$createElement("box"), _el$202 = _$createElement("text"), _el$203 = _$createElement("b"), _el$205 = _$createElement("text"), _el$206 = _$createTextNode(` \xB7 `), _el$207 = _$createTextNode(` observations \xB7 `), _el$208 = _$createTextNode(` eligible`);
            _$insertNode(_el$201, _el$202);
            _$insertNode(_el$201, _el$205);
            _$setProp(_el$201, "flexDirection", "column");
            _$insertNode(_el$202, _el$203);
            _$insertNode(_el$203, _$createTextNode(`Last cycle`));
            _$insertNode(_el$205, _el$206);
            _$insertNode(_el$205, _el$207);
            _$insertNode(_el$205, _el$208);
            _$setProp(_el$205, "wrapMode", "word");
            _$insert(_el$205, () => lastCycle().outcome.replaceAll("-", " "), _el$206);
            _$insert(_el$205, () => lastCycle().observationCount, _el$207);
            _$insert(_el$205, () => lastCycle().eligibilityCount, _el$208);
            return _el$201;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().attention;
          },
          children: (attention) => (() => {
            var _el$209 = _$createElement("box"), _el$210 = _$createElement("text"), _el$211 = _$createTextNode(` `), _el$212 = _$createTextNode(` needs attention`);
            _$insertNode(_el$209, _el$210);
            _$setProp(_el$209, "focusable", true);
            _$setProp(_el$209, "border", true);
            _$setProp(_el$209, "paddingLeft", 1);
            _$setProp(_el$209, "paddingRight", 1);
            _$setProp(_el$209, "on:focused", () => setFocusedControl("home:attention"));
            _$setProp(_el$209, "on:blurred", () => setFocusedControl((current) => current === "home:attention" ? null : current));
            _$setProp(_el$209, "onMouseUp", () => navigate(attention().destination));
            _$setProp(_el$209, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              navigate(attention().destination);
            });
            _$insertNode(_el$210, _el$211);
            _$insertNode(_el$210, _el$212);
            _$insert(_el$210, () => focusMark("home:attention"), _el$211);
            _$insert(_el$210, () => attention().count, _el$211);
            _$insert(_el$210, () => attention().kind === "applied" ? "applied change" : "recommendation", _el$212);
            _$effect((_p$) => {
              var _v$54 = focusId("home:attention"), _v$55 = props.api.theme.current.warning;
              _v$54 !== _p$.e && (_p$.e = _$setProp(_el$209, "id", _v$54, _p$.e));
              _v$55 !== _p$.t && (_p$.t = _$setProp(_el$209, "borderColor", _v$55, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$209;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().usage;
          },
          children: (usage) => (() => {
            var _el$213 = _$createElement("box"), _el$214 = _$createElement("text"), _el$215 = _$createElement("b"), _el$217 = _$createElement("text"), _el$218 = _$createTextNode(`Provider calls: `), _el$219 = _$createTextNode(` / `), _el$220 = _$createElement("text"), _el$221 = _$createTextNode(`Provider calls reset: `), _el$222 = _$createElement("text"), _el$223 = _$createTextNode(`Recommendation synthesis: `), _el$224 = _$createTextNode(` / `), _el$225 = _$createElement("text"), _el$226 = _$createTextNode(`Recommendation synthesis resets: `), _el$227 = _$createElement("text"), _el$228 = _$createTextNode(`Storage: `), _el$229 = _$createTextNode(` / `), _el$230 = _$createTextNode(` bytes`);
            _$insertNode(_el$213, _el$214);
            _$insertNode(_el$213, _el$217);
            _$insertNode(_el$213, _el$220);
            _$insertNode(_el$213, _el$222);
            _$insertNode(_el$213, _el$225);
            _$insertNode(_el$213, _el$227);
            _$setProp(_el$213, "flexDirection", "column");
            _$insertNode(_el$214, _el$215);
            _$insertNode(_el$215, _$createTextNode(`Actual usage`));
            _$insertNode(_el$217, _el$218);
            _$insertNode(_el$217, _el$219);
            _$insert(_el$217, () => usage().provider.used, _el$219);
            _$insert(_el$217, () => usage().provider.limit, null);
            _$insertNode(_el$220, _el$221);
            _$insert(_el$220, (() => {
              var _c$8 = _$memo(() => !!usage().provider.resetAt);
              return () => _c$8() ? new Date(usage().provider.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$222, _el$223);
            _$insertNode(_el$222, _el$224);
            _$insert(_el$222, () => usage().synthesis.used, _el$224);
            _$insert(_el$222, () => usage().synthesis.limit, null);
            _$insertNode(_el$225, _el$226);
            _$insert(_el$225, (() => {
              var _c$9 = _$memo(() => !!usage().synthesis.resetAt);
              return () => _c$9() ? new Date(usage().synthesis.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$227, _el$228);
            _$insertNode(_el$227, _el$229);
            _$insertNode(_el$227, _el$230);
            _$insert(_el$227, () => usage().storage.usedBytes, _el$229);
            _$insert(_el$227, () => usage().storage.limitBytes, _el$230);
            return _el$213;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().recentActivity.length;
          },
          get children() {
            var _el$51 = _$createElement("box"), _el$52 = _$createElement("text"), _el$53 = _$createElement("b");
            _$insertNode(_el$51, _el$52);
            _$setProp(_el$51, "flexDirection", "column");
            _$insertNode(_el$52, _el$53);
            _$insertNode(_el$53, _$createTextNode(`Recent activity`));
            _$insert(_el$51, () => reactiveChild(() => home().recentActivity.map((entry) => (() => {
              var _el$231 = _$createElement("text"), _el$232 = _$createTextNode(`[`), _el$233 = _$createTextNode(`] `);
              _$insertNode(_el$231, _el$232);
              _$insertNode(_el$231, _el$233);
              _$setProp(_el$231, "wrapMode", "word");
              _$insert(_el$231, () => entry.marker, _el$233);
              _$insert(_el$231, () => entry.summary, null);
              return _el$231;
            })())), null);
            return _el$51;
          }
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
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
        }), null);
        _$effect((_p$) => {
          var _v$23 = props.api.theme.current.text, _v$24 = props.api.theme.current.textMuted, _v$25 = props.api.theme.current.borderSubtle;
          _v$23 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$23, _p$.e));
          _v$24 !== _p$.t && (_p$.t = _$setProp(_el$38, "fg", _v$24, _p$.t));
          _v$25 !== _p$.a && (_p$.a = _$setProp(_el$39, "borderColor", _v$25, _p$.a));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined
        });
        return _el$31;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "recommendations";
      },
      get children() {
        var _el$55 = _$createElement("box"), _el$56 = _$createElement("text"), _el$57 = _$createElement("b"), _el$62 = _$createElement("box");
        _$insertNode(_el$55, _el$56);
        _$insertNode(_el$55, _el$62);
        _$setProp(_el$55, "flexDirection", "column");
        _$setProp(_el$55, "gap", 1);
        _$insertNode(_el$56, _el$57);
        _$insertNode(_el$57, _$createTextNode(`Recommendations`));
        _$insert(_el$55, _$createComponent(Show, {
          get when() {
            return recommendations().limited;
          },
          get children() {
            var _el$59 = _$createElement("text");
            _$insertNode(_el$59, _$createTextNode(`Limited / read-only global recommendations. Fresh aligned grants are required before Apply, Reject, or Undo appears.`));
            _$setProp(_el$59, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$59, "fg", props.api.theme.current.warning, _$p));
            return _el$59;
          }
        }), _el$62);
        _$insert(_el$55, _$createComponent(Show, {
          get when() {
            return recommendations().enhancedError;
          },
          get children() {
            var _el$61 = _$createElement("text");
            _$setProp(_el$61, "wrapMode", "word");
            _$insert(_el$61, () => recommendations().enhancedError);
            _$effect((_$p) => _$setProp(_el$61, "fg", props.api.theme.current.error, _$p));
            return _el$61;
          }
        }), _el$62);
        _$setProp(_el$62, "flexDirection", "row");
        _$setProp(_el$62, "gap", 1);
        _$setProp(_el$62, "flexWrap", "wrap");
        _$insert(_el$62, () => [["needs-review", "Needs review"], ["applied", "Applied"], ["dismissed", "Dismissed"], ["all", "All"]].map(([value, label]) => (() => {
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
            var _v$56 = focusId(`recommendation-filter:${value}`), _v$57 = recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$56 !== _p$.e && (_p$.e = _$setProp(_el$238, "id", _v$56, _p$.e));
            _v$57 !== _p$.t && (_p$.t = _$setProp(_el$238, "borderColor", _v$57, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$238;
        })()));
        _$insert(_el$55, _$createComponent(Show, {
          get when() {
            return recommendations().emptyState;
          },
          get children() {
            var _el$63 = _$createElement("text");
            _$insert(_el$63, () => recommendations().emptyState);
            return _el$63;
          }
        }), null);
        _$insert(_el$55, () => reactiveChild(() => recommendations().queue.map((item, index) => (() => {
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
            var _c$0 = _$memo(() => item.attention === "critical");
            return () => _c$0() ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "";
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
            var _v$58 = focusId(`recommendation-row:${item.sourceIndex}`), _v$59 = recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$60 = props.api.theme.current.textMuted, _v$61 = props.api.theme.current.textMuted;
            _v$58 !== _p$.e && (_p$.e = _$setProp(_el$240, "id", _v$58, _p$.e));
            _v$59 !== _p$.t && (_p$.t = _$setProp(_el$240, "borderColor", _v$59, _p$.t));
            _v$60 !== _p$.a && (_p$.a = _$setProp(_el$244, "fg", _v$60, _p$.a));
            _v$61 !== _p$.o && (_p$.o = _$setProp(_el$245, "fg", _v$61, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$240;
        })())), null);
        _$insert(_el$55, _$createComponent(Show, {
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
                _$insert(_el$264, _$createComponent(Show, {
                  get when() {
                    return summary().support;
                  },
                  children: (support) => [(() => {
                    var _el$319 = _$createElement("text"), _el$320 = _$createTextNode(`Target: `), _el$321 = _$createTextNode(` \xB7 `);
                    _$insertNode(_el$319, _el$320);
                    _$insertNode(_el$319, _el$321);
                    _$setProp(_el$319, "wrapMode", "word");
                    _$insert(_el$319, () => summary().targetKind === "new-global-skill" ? "New global skill" : "Existing global skill", _el$321);
                    _$insert(_el$319, () => summary().target, null);
                    return _el$319;
                  })(), (() => {
                    var _el$322 = _$createElement("text"), _el$323 = _$createTextNode(`Support: `), _el$324 = _$createTextNode(` \xB7 `), _el$325 = _$createTextNode(` independent domains \xB7 `), _el$326 = _$createTextNode(` incidents \xB7 `), _el$327 = _$createTextNode(` occurrences`);
                    _$insertNode(_el$322, _el$323);
                    _$insertNode(_el$322, _el$324);
                    _$insertNode(_el$322, _el$325);
                    _$insertNode(_el$322, _el$326);
                    _$insertNode(_el$322, _el$327);
                    _$setProp(_el$322, "wrapMode", "word");
                    _$insert(_el$322, () => support().tier.replaceAll("-", " "), _el$324);
                    _$insert(_el$322, () => support().independentDomainCount, _el$325);
                    _$insert(_el$322, () => support().independentIncidentCount, _el$326);
                    _$insert(_el$322, () => support().occurrenceCount, _el$327);
                    return _el$322;
                  })(), (() => {
                    var _el$328 = _$createElement("text"), _el$329 = _$createTextNode(`Observed: `), _el$330 = _$createTextNode(` through `);
                    _$insertNode(_el$328, _el$329);
                    _$insertNode(_el$328, _el$330);
                    _$setProp(_el$328, "wrapMode", "word");
                    _$insert(_el$328, () => support().firstSeenDay, _el$330);
                    _$insert(_el$328, () => support().lastSeenDay, null);
                    return _el$328;
                  })(), (() => {
                    var _el$331 = _$createElement("text"), _el$332 = _$createTextNode(`Current project contributed: `);
                    _$insertNode(_el$331, _el$332);
                    _$setProp(_el$331, "wrapMode", "word");
                    _$insert(_el$331, (() => {
                      var _c$10 = _$memo(() => summary().currentProjectContributed === null);
                      return () => _c$10() ? "Unavailable" : summary().currentProjectContributed ? "Yes" : "No";
                    })(), null);
                    return _el$331;
                  })()]
                }), null);
                return _el$264;
              })(), (() => {
                var _el$269 = _$createElement("box"), _el$270 = _$createElement("text"), _el$271 = _$createElement("b");
                _$insertNode(_el$269, _el$270);
                _$setProp(_el$269, "flexDirection", "column");
                _$insertNode(_el$270, _el$271);
                _$insertNode(_el$271, _$createTextNode(`Proposed change`));
                _$insert(_el$269, () => reactiveChild(() => selected().diff?.lines.map((line) => (() => {
                  var _el$333 = _$createElement("text");
                  _$setProp(_el$333, "wrapMode", "word");
                  _$insert(_el$333, line);
                  return _el$333;
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
                  var _el$334 = _$createElement("text"), _el$335 = _$createTextNode(`: `);
                  _$insertNode(_el$334, _el$335);
                  _$setProp(_el$334, "wrapMode", "word");
                  _$insert(_el$334, () => entry.kind, _el$335);
                  _$insert(_el$334, () => entry.summary, null);
                  _$insert(_el$334, () => entry.redacted ? " [redacted]" : "", null);
                  return _el$334;
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
                var _el$281 = _$createElement("box"), _el$282 = _$createElement("text"), _el$283 = _$createElement("b"), _el$285 = _$createElement("text"), _el$286 = _$createTextNode(`Critic: `), _el$290 = _$createElement("text"), _el$291 = _$createTextNode(`Deterministic checks: `);
                _$insertNode(_el$281, _el$282);
                _$insertNode(_el$281, _el$285);
                _$insertNode(_el$281, _el$290);
                _$setProp(_el$281, "flexDirection", "column");
                _$insertNode(_el$282, _el$283);
                _$insertNode(_el$283, _$createTextNode(`Safety checks`));
                _$insertNode(_el$285, _el$286);
                _$insert(_el$285, () => summary().criticPassed ? "Passed" : "Not passed", null);
                _$insert(_el$281, _$createComponent(Show, {
                  get when() {
                    return summary().criticScoreBasisPoints !== undefined;
                  },
                  get children() {
                    var _el$287 = _$createElement("text"), _el$288 = _$createTextNode(`Critic score: `), _el$289 = _$createTextNode(`%`);
                    _$insertNode(_el$287, _el$288);
                    _$insertNode(_el$287, _el$289);
                    _$insert(_el$287, () => (summary().criticScoreBasisPoints / 100).toFixed(2), _el$289);
                    return _el$287;
                  }
                }), _el$290);
                _$insertNode(_el$290, _el$291);
                _$insert(_el$290, () => summary().validDeterministic ? "Passed" : "Not passed", null);
                _$insert(_el$281, _$createComponent(Show, {
                  get when() {
                    return summary().injectionFlagged !== undefined;
                  },
                  get children() {
                    var _el$292 = _$createElement("text"), _el$293 = _$createTextNode(`Injection scan: `);
                    _$insertNode(_el$292, _el$293);
                    _$insert(_el$292, () => summary().injectionFlagged ? "Flagged" : "Clear", null);
                    return _el$292;
                  }
                }), null);
                _$insert(_el$281, _$createComponent(Show, {
                  get when() {
                    return summary().eligibility;
                  },
                  children: (eligibility) => reactiveChild(() => eligibility().checks.map((check) => (() => {
                    var _el$336 = _$createElement("text"), _el$337 = _$createTextNode(`[`), _el$338 = _$createTextNode(`] `), _el$339 = _$createTextNode(`: `), _el$340 = _$createTextNode(` / `);
                    _$insertNode(_el$336, _el$337);
                    _$insertNode(_el$336, _el$338);
                    _$insertNode(_el$336, _el$339);
                    _$insertNode(_el$336, _el$340);
                    _$setProp(_el$336, "wrapMode", "word");
                    _$insert(_el$336, () => check.met ? "Passed" : "Blocked", _el$338);
                    _$insert(_el$336, () => check.name, _el$339);
                    _$insert(_el$336, () => check.actual, _el$340);
                    _$insert(_el$336, () => check.required, null);
                    return _el$336;
                  })()))
                }), null);
                return _el$281;
              })(), (() => {
                var _el$294 = _$createElement("box"), _el$295 = _$createElement("text"), _el$296 = _$createElement("b"), _el$298 = _$createElement("text"), _el$299 = _$createTextNode(`: `);
                _$insertNode(_el$294, _el$295);
                _$insertNode(_el$294, _el$298);
                _$setProp(_el$294, "flexDirection", "column");
                _$insertNode(_el$295, _el$296);
                _$insertNode(_el$296, _$createTextNode(`Generality`));
                _$insertNode(_el$298, _el$299);
                _$setProp(_el$298, "wrapMode", "word");
                _$insert(_el$298, () => summary().generality.status, _el$299);
                _$insert(_el$298, () => summary().generality.explanation, null);
                return _el$294;
              })(), (() => {
                var _el$300 = _$createElement("box"), _el$301 = _$createElement("text"), _el$302 = _$createElement("b");
                _$insertNode(_el$300, _el$301);
                _$setProp(_el$300, "flexDirection", "column");
                _$insertNode(_el$301, _el$302);
                _$insertNode(_el$302, _$createTextNode(`Token impact`));
                _$insert(_el$300, _$createComponent(Show, {
                  get when() {
                    return summary().tokenImpact.available;
                  },
                  get fallback() {
                    return (() => {
                      var _el$341 = _$createElement("text"), _el$342 = _$createTextNode(`Unavailable: `);
                      _$insertNode(_el$341, _el$342);
                      _$setProp(_el$341, "wrapMode", "word");
                      _$insert(_el$341, () => summary().tokenImpact.explanation, null);
                      return _el$341;
                    })();
                  },
                  get children() {
                    var _el$304 = _$createElement("text"), _el$305 = _$createTextNode(` estimated / `), _el$306 = _$createTextNode(` budgeted tokens`);
                    _$insertNode(_el$304, _el$305);
                    _$insertNode(_el$304, _el$306);
                    _$insert(_el$304, () => summary().tokenImpact.estimatedTokens, _el$305);
                    _$insert(_el$304, () => summary().tokenImpact.budgetTokens, _el$306);
                    return _el$304;
                  }
                }), null);
                return _el$300;
              })(), (() => {
                var _el$307 = _$createElement("box"), _el$308 = _$createElement("text"), _el$309 = _$createElement("b"), _el$311 = _$createElement("text");
                _$insertNode(_el$307, _el$308);
                _$insertNode(_el$307, _el$311);
                _$setProp(_el$307, "flexDirection", "column");
                _$insertNode(_el$308, _el$309);
                _$insertNode(_el$309, _$createTextNode(`Rollback`));
                _$insert(_el$311, (() => {
                  var _c$1 = _$memo(() => !!summary().rollback.eligible);
                  return () => _c$1() ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`;
                })());
                return _el$307;
              })(), (() => {
                var _el$312 = _$createElement("box"), _el$313 = _$createElement("text"), _el$314 = _$createTextNode(`Technical details `);
                _$insertNode(_el$312, _el$313);
                _$setProp(_el$312, "focusable", true);
                _$setProp(_el$312, "border", true);
                _$setProp(_el$312, "paddingLeft", 1);
                _$setProp(_el$312, "paddingRight", 1);
                _$setProp(_el$312, "on:focused", () => setFocusedControl("recommendation:technical"));
                _$setProp(_el$312, "on:blurred", () => setFocusedControl((current) => current === "recommendation:technical" ? null : current));
                _$setProp(_el$312, "onMouseUp", () => setTechnicalExpanded((value) => !value));
                _$setProp(_el$312, "onKeyDown", (event) => {
                  if (!isActivationKey(event))
                    return;
                  event.preventDefault();
                  setTechnicalExpanded((value) => !value);
                });
                _$insertNode(_el$313, _el$314);
                _$insert(_el$313, () => focusMark("recommendation:technical"), _el$314);
                _$insert(_el$313, () => technicalExpanded() ? "\u25B2" : "\u25BC", null);
                _$effect((_$p) => _$setProp(_el$312, "borderColor", technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                return _el$312;
              })(), _$createComponent(Show, {
                get when() {
                  return technicalExpanded();
                },
                get children() {
                  return [(() => {
                    var _el$315 = _$createElement("text"), _el$316 = _$createTextNode(`State: `);
                    _$insertNode(_el$315, _el$316);
                    _$insert(_el$315, () => summary().state, null);
                    return _el$315;
                  })(), _$createComponent(Show, {
                    get when() {
                      return summary().operation;
                    },
                    get children() {
                      var _el$317 = _$createElement("text"), _el$318 = _$createTextNode(`Operation: `);
                      _$insertNode(_el$317, _el$318);
                      _$insert(_el$317, () => summary().operation.status, null);
                      return _el$317;
                    }
                  }), _$memo(() => reactiveChild(() => selected().audit.map((entry) => (() => {
                    var _el$343 = _$createElement("text"), _el$344 = _$createTextNode(`: `);
                    _$insertNode(_el$343, _el$344);
                    _$setProp(_el$343, "wrapMode", "word");
                    _$insert(_el$343, () => entry.kind, _el$344);
                    _$insert(_el$343, () => entry.summary, null);
                    return _el$343;
                  })())))];
                }
              })]
            }), _el$258);
            _$insert(_el$248, _$createComponent(Show, {
              get when() {
                return selected().actions.some((action) => ["reject-proposal", "reject"].includes(action.action) && action.feedbackSupported);
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
                  var _el$345 = _$createElement("box"), _el$346 = _$createElement("text");
                  _$insertNode(_el$345, _el$346);
                  _$setProp(_el$345, "focusable", true);
                  _$setProp(_el$345, "border", true);
                  _$setProp(_el$345, "paddingLeft", 1);
                  _$setProp(_el$345, "paddingRight", 1);
                  _$setProp(_el$345, "on:focused", () => setFocusedControl(`rejection:${option.value}`));
                  _$setProp(_el$345, "on:blurred", () => setFocusedControl((current) => current === `rejection:${option.value}` ? null : current));
                  _$setProp(_el$345, "onMouseUp", () => setRejectionReason(rejectionReason() === option.value ? null : option.value));
                  _$setProp(_el$345, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setRejectionReason(rejectionReason() === option.value ? null : option.value);
                  });
                  _$insert(_el$346, () => focusMark(`rejection:${option.value}`), null);
                  _$insert(_el$346, () => option.label, null);
                  _$effect((_$p) => _$setProp(_el$345, "borderColor", rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                  return _el$345;
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
                label: action.action === "rollback-proposal" || action.action === "undo" ? "Undo" : action.action === "apply" ? "Apply" : action.action === "reject" ? "Reject" : action.action === "acknowledge-audit" ? "Acknowledge" : action.label,
                delay: undefined
              }];
              return choices.map((choice) => {
                const key = `${action.action}:${choice.delay ?? ""}`;
                return (() => {
                  var _el$347 = _$createElement("box"), _el$348 = _$createElement("text");
                  _$insertNode(_el$347, _el$348);
                  _$setProp(_el$347, "border", true);
                  _$setProp(_el$347, "paddingLeft", 1);
                  _$setProp(_el$347, "paddingRight", 1);
                  _$setProp(_el$347, "on:focused", () => setFocusedControl(`recommendation-action:${key}`));
                  _$setProp(_el$347, "on:blurred", () => setFocusedControl((current) => current === `recommendation-action:${key}` ? null : current));
                  _$setProp(_el$347, "onMouseUp", () => {
                    if (!action.pending)
                      activateRecommendation(action.action, choice.delay);
                  });
                  _$setProp(_el$347, "onKeyDown", (event) => {
                    if (!isActivationKey(event) || action.pending)
                      return;
                    event.preventDefault();
                    activateRecommendation(action.action, choice.delay);
                  });
                  _$insert(_el$348, () => focusMark(`recommendation-action:${key}`), null);
                  _$insert(_el$348, (() => {
                    var _c$11 = _$memo(() => !!action.pending);
                    return () => _c$11() ? `${choice.label} \xB7 Pending` : _$memo(() => confirmation() === key)() ? `Confirm ${choice.label}` : choice.label;
                  })(), null);
                  _$effect((_p$) => {
                    var _v$64 = !action.pending, _v$65 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$66 = action.pending ? props.api.theme.current.textMuted : props.api.theme.current.text;
                    _v$64 !== _p$.e && (_p$.e = _$setProp(_el$347, "focusable", _v$64, _p$.e));
                    _v$65 !== _p$.t && (_p$.t = _$setProp(_el$347, "borderColor", _v$65, _p$.t));
                    _v$66 !== _p$.a && (_p$.a = _$setProp(_el$348, "fg", _v$66, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$347;
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
              var _v$62 = props.api.theme.current.borderActive, _v$63 = props.api.theme.current.borderSubtle;
              _v$62 !== _p$.e && (_p$.e = _$setProp(_el$248, "borderColor", _v$62, _p$.e));
              _v$63 !== _p$.t && (_p$.t = _$setProp(_el$259, "borderColor", _v$63, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$248;
          })()
        }), null);
        return _el$55;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "activity";
      },
      get children() {
        var _el$64 = _$createElement("box"), _el$65 = _$createElement("text"), _el$66 = _$createElement("b"), _el$68 = _$createElement("box"), _el$71 = _$createElement("box"), _el$72 = _$createElement("text"), _el$73 = _$createTextNode(`Diagnostics `);
        _$insertNode(_el$64, _el$65);
        _$insertNode(_el$64, _el$68);
        _$insertNode(_el$64, _el$71);
        _$setProp(_el$64, "flexDirection", "column");
        _$setProp(_el$64, "gap", 1);
        _$insertNode(_el$65, _el$66);
        _$insertNode(_el$66, _$createTextNode(`Activity`));
        _$setProp(_el$68, "flexDirection", "row");
        _$setProp(_el$68, "gap", 1);
        _$setProp(_el$68, "flexWrap", "wrap");
        _$insert(_el$68, () => [["all", "All"], ["recommendations", "Recommendations"], ["system", "System"], ["errors", "Errors"]].map(([value, label]) => (() => {
          var _el$349 = _$createElement("box"), _el$350 = _$createElement("text");
          _$insertNode(_el$349, _el$350);
          _$setProp(_el$349, "focusable", true);
          _$setProp(_el$349, "border", true);
          _$setProp(_el$349, "paddingLeft", 1);
          _$setProp(_el$349, "paddingRight", 1);
          _$setProp(_el$349, "on:focused", () => setFocusedControl(`activity-filter:${value}`));
          _$setProp(_el$349, "on:blurred", () => setFocusedControl((current) => current === `activity-filter:${value}` ? null : current));
          _$setProp(_el$349, "onMouseUp", () => {
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$setProp(_el$349, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$insert(_el$350, () => focusMark(`activity-filter:${value}`), null);
          _$insert(_el$350, label, null);
          _$effect((_p$) => {
            var _v$67 = focusId(`activity-filter:${value}`), _v$68 = activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$67 !== _p$.e && (_p$.e = _$setProp(_el$349, "id", _v$67, _p$.e));
            _v$68 !== _p$.t && (_p$.t = _$setProp(_el$349, "borderColor", _v$68, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$349;
        })()));
        _$insert(_el$64, _$createComponent(Show, {
          get when() {
            return activity().emptyState;
          },
          get children() {
            var _el$69 = _$createElement("text");
            _$setProp(_el$69, "wrapMode", "word");
            _$insert(_el$69, () => activity().emptyState);
            return _el$69;
          }
        }), _el$71);
        _$insert(_el$64, () => reactiveChild(() => activity().activity.map((entry, index) => (() => {
          var _el$351 = _$createElement("box"), _el$352 = _$createElement("text"), _el$353 = _$createTextNode(`[`), _el$354 = _$createTextNode(`] [`), _el$355 = _$createTextNode(`] `), _el$356 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$351, _el$352);
          _$use((value) => activityNodes.set(index, value), _el$351);
          _$setProp(_el$351, "focusable", true);
          _$setProp(_el$351, "border", true);
          _$setProp(_el$351, "paddingLeft", 1);
          _$setProp(_el$351, "paddingRight", 1);
          _$setProp(_el$351, "flexDirection", "column");
          _$setProp(_el$351, "on:focused", () => {
            setFocusedControl(`activity-row:${index}`);
            setActivityIndex(index);
          });
          _$setProp(_el$351, "on:blurred", () => setFocusedControl((current) => current === `activity-row:${index}` ? null : current));
          _$setProp(_el$351, "onMouseUp", () => {
            setActivityIndex(index);
            activityNodes.get(index)?.focus();
            setActivityExpanded(activityExpanded() === index ? null : index);
          });
          _$setProp(_el$351, "onKeyDown", (event) => {
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
          _$insertNode(_el$352, _el$353);
          _$insertNode(_el$352, _el$354);
          _$insertNode(_el$352, _el$355);
          _$insertNode(_el$352, _el$356);
          _$setProp(_el$352, "wrapMode", "word");
          _$insert(_el$352, () => focusMark(`activity-row:${index}`), _el$353);
          _$insert(_el$352, () => entry.marker, _el$354);
          _$insert(_el$352, () => entry.scope, _el$355);
          _$insert(_el$352, () => entry.summary, _el$356);
          _$insert(_el$352, () => relativeTime(entry.occurredAt), null);
          _$insert(_el$351, _$createComponent(Show, {
            get when() {
              return entry.target;
            },
            get children() {
              var _el$357 = _$createElement("text"), _el$358 = _$createTextNode(`Skill: `);
              _$insertNode(_el$357, _el$358);
              _$insert(_el$357, () => entry.target, null);
              _$effect((_$p) => _$setProp(_el$357, "fg", props.api.theme.current.textMuted, _$p));
              return _el$357;
            }
          }), null);
          _$insert(_el$351, _$createComponent(Show, {
            get when() {
              return activityExpanded() === index;
            },
            get children() {
              return [(() => {
                var _el$359 = _$createElement("text"), _el$360 = _$createTextNode(`Category: `);
                _$insertNode(_el$359, _el$360);
                _$insert(_el$359, () => entry.technical.category, null);
                _$effect((_$p) => _$setProp(_el$359, "fg", props.api.theme.current.textMuted, _$p));
                return _el$359;
              })(), (() => {
                var _el$361 = _$createElement("text"), _el$362 = _$createTextNode(`Outcome: `);
                _$insertNode(_el$361, _el$362);
                _$insert(_el$361, () => entry.technical.outcome.replaceAll("-", " "), null);
                _$effect((_$p) => _$setProp(_el$361, "fg", props.api.theme.current.textMuted, _$p));
                return _el$361;
              })(), _$createComponent(Show, {
                get when() {
                  return entry.technical.reason;
                },
                children: (reason) => (() => {
                  var _el$366 = _$createElement("text"), _el$367 = _$createTextNode(`Reason: `);
                  _$insertNode(_el$366, _el$367);
                  _$insert(_el$366, () => reason().replaceAll("-", " "), null);
                  _$effect((_$p) => _$setProp(_el$366, "fg", props.api.theme.current.textMuted, _$p));
                  return _el$366;
                })()
              }), _$createComponent(Show, {
                get when() {
                  return entry.acknowledgementRequestId;
                },
                children: (requestId) => localActionButton("Acknowledge global failure", () => props.store.acknowledgeGlobalFailure(requestId()), false, undefined, undefined, `acknowledge-global-failure:${index}`)
              }), _$createComponent(Show, {
                get when() {
                  return entry.destination?.section === "recommendations";
                },
                get children() {
                  var _el$363 = _$createElement("box"), _el$364 = _$createElement("text"), _el$365 = _$createTextNode(`Open recommendation`);
                  _$insertNode(_el$363, _el$364);
                  _$setProp(_el$363, "focusable", true);
                  _$setProp(_el$363, "border", true);
                  _$setProp(_el$363, "paddingLeft", 1);
                  _$setProp(_el$363, "paddingRight", 1);
                  _$setProp(_el$363, "on:focused", () => setFocusedControl(`activity-open:${index}`));
                  _$setProp(_el$363, "on:blurred", () => setFocusedControl((current) => current === `activity-open:${index}` ? null : current));
                  _$setProp(_el$363, "onMouseUp", () => openActivityDestination(entry));
                  _$setProp(_el$363, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    openActivityDestination(entry);
                  });
                  _$insertNode(_el$364, _el$365);
                  _$insert(_el$364, () => focusMark(`activity-open:${index}`), _el$365);
                  _$effect((_$p) => _$setProp(_el$363, "borderColor", props.api.theme.current.borderSubtle, _$p));
                  return _el$363;
                }
              })];
            }
          }), null);
          _$effect((_p$) => {
            var _v$69 = focusId(`activity-row:${index}`), _v$70 = activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$69 !== _p$.e && (_p$.e = _$setProp(_el$351, "id", _v$69, _p$.e));
            _v$70 !== _p$.t && (_p$.t = _$setProp(_el$351, "borderColor", _v$70, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$351;
        })())), _el$71);
        _$insert(_el$64, _$createComponent(Show, {
          get when() {
            return activity().overflowMessage;
          },
          get children() {
            var _el$70 = _$createElement("text");
            _$setProp(_el$70, "wrapMode", "word");
            _$insert(_el$70, () => activity().overflowMessage);
            _$effect((_$p) => _$setProp(_el$70, "fg", props.api.theme.current.warning, _$p));
            return _el$70;
          }
        }), _el$71);
        _$insertNode(_el$71, _el$72);
        _$setProp(_el$71, "focusable", true);
        _$setProp(_el$71, "border", true);
        _$setProp(_el$71, "paddingLeft", 1);
        _$setProp(_el$71, "paddingRight", 1);
        _$setProp(_el$71, "on:focused", () => setFocusedControl("activity:diagnostics"));
        _$setProp(_el$71, "on:blurred", () => setFocusedControl((current) => current === "activity:diagnostics" ? null : current));
        _$setProp(_el$71, "onMouseUp", () => setDiagnosticsExpanded((value) => !value));
        _$setProp(_el$71, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setDiagnosticsExpanded((value) => !value);
        });
        _$insertNode(_el$72, _el$73);
        _$insert(_el$72, () => focusMark("activity:diagnostics"), _el$73);
        _$insert(_el$72, () => diagnosticsExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$64, _$createComponent(Show, {
          get when() {
            return diagnosticsExpanded();
          },
          get children() {
            var _el$74 = _$createElement("box"), _el$75 = _$createElement("text"), _el$76 = _$createTextNode(`Projection refreshed: `), _el$77 = _$createElement("text"), _el$78 = _$createTextNode(`Core projection: `), _el$79 = _$createElement("text"), _el$80 = _$createTextNode(`Enhanced projection: `), _el$81 = _$createElement("text"), _el$82 = _$createTextNode(`Global projection: `), _el$83 = _$createTextNode(` (`), _el$84 = _$createTextNode(`)`), _el$85 = _$createElement("text"), _el$86 = _$createTextNode(`OpenCode: `), _el$87 = _$createTextNode(` (`), _el$88 = _$createTextNode(`)`), _el$89 = _$createElement("text"), _el$90 = _$createTextNode(`Self-evolve: `), _el$91 = _$createElement("text"), _el$92 = _$createTextNode(`Projection protocol: `), _el$93 = _$createElement("text"), _el$94 = _$createTextNode(`Dashboard protocol: `), _el$95 = _$createElement("text"), _el$96 = _$createTextNode(`Refresh watcher: `), _el$97 = _$createElement("text"), _el$98 = _$createTextNode(`Circuit breaker: `);
            _$insertNode(_el$74, _el$75);
            _$insertNode(_el$74, _el$77);
            _$insertNode(_el$74, _el$79);
            _$insertNode(_el$74, _el$81);
            _$insertNode(_el$74, _el$85);
            _$insertNode(_el$74, _el$89);
            _$insertNode(_el$74, _el$91);
            _$insertNode(_el$74, _el$93);
            _$insertNode(_el$74, _el$95);
            _$insertNode(_el$74, _el$97);
            _$setProp(_el$74, "flexDirection", "column");
            _$insertNode(_el$75, _el$76);
            _$setProp(_el$75, "wrapMode", "word");
            _$insert(_el$75, (() => {
              var _c$4 = _$memo(() => !!activity().diagnostics.refreshedAt);
              return () => _c$4() ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable";
            })(), null);
            _$insertNode(_el$77, _el$78);
            _$setProp(_el$77, "wrapMode", "word");
            _$insert(_el$77, () => activity().diagnostics.coreProjection, null);
            _$insertNode(_el$79, _el$80);
            _$setProp(_el$79, "wrapMode", "word");
            _$insert(_el$79, () => activity().diagnostics.enhancedProjection, null);
            _$insertNode(_el$81, _el$82);
            _$insertNode(_el$81, _el$83);
            _$insertNode(_el$81, _el$84);
            _$setProp(_el$81, "wrapMode", "word");
            _$insert(_el$81, () => activity().diagnostics.globalProjection, _el$83);
            _$insert(_el$81, () => activity().diagnostics.globalProtocolLabel ?? "Unavailable", _el$84);
            _$insertNode(_el$85, _el$86);
            _$insertNode(_el$85, _el$87);
            _$insertNode(_el$85, _el$88);
            _$setProp(_el$85, "wrapMode", "word");
            _$insert(_el$85, () => activity().diagnostics.runtime.hostVersion, _el$87);
            _$insert(_el$85, () => activity().diagnostics.runtime.hostVersionSource, _el$88);
            _$insertNode(_el$89, _el$90);
            _$setProp(_el$89, "wrapMode", "word");
            _$insert(_el$89, () => activity().diagnostics.runtime.pluginVersion, null);
            _$insertNode(_el$91, _el$92);
            _$setProp(_el$91, "wrapMode", "word");
            _$insert(_el$91, () => activity().diagnostics.runtime.projectionVersion ?? "Unavailable", null);
            _$insertNode(_el$93, _el$94);
            _$setProp(_el$93, "wrapMode", "word");
            _$insert(_el$93, () => activity().diagnostics.runtime.dashboardVersion ?? "Unavailable", null);
            _$insertNode(_el$95, _el$96);
            _$setProp(_el$95, "wrapMode", "word");
            _$insert(_el$95, () => activity().diagnostics.watcherStatus, null);
            _$insertNode(_el$97, _el$98);
            _$setProp(_el$97, "wrapMode", "word");
            _$insert(_el$97, () => activity().diagnostics.breakerStatus, null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.automation;
              },
              children: (automation) => (() => {
                var _el$368 = _$createElement("text"), _el$369 = _$createTextNode(`Scheduler: `);
                _$insertNode(_el$368, _el$369);
                _$setProp(_el$368, "wrapMode", "word");
                _$insert(_el$368, () => automation().state.replaceAll("-", " "), null);
                return _el$368;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.backoffUntil;
              },
              children: (backoffUntil) => (() => {
                var _el$370 = _$createElement("text"), _el$371 = _$createTextNode(`Backoff ends: `);
                _$insertNode(_el$370, _el$371);
                _$setProp(_el$370, "wrapMode", "word");
                _$insert(_el$370, () => new Date(backoffUntil()).toISOString(), null);
                return _el$370;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.nextEligibleAt;
              },
              children: (nextEligibleAt) => (() => {
                var _el$372 = _$createElement("text"), _el$373 = _$createTextNode(`Next eligible: `);
                _$insertNode(_el$372, _el$373);
                _$setProp(_el$372, "wrapMode", "word");
                _$insert(_el$372, () => new Date(nextEligibleAt()).toISOString(), null);
                return _el$372;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.usage;
              },
              children: (usage) => [(() => {
                var _el$374 = _$createElement("text"), _el$375 = _$createTextNode(`Provider calls used/remaining: `), _el$376 = _$createTextNode(` / `);
                _$insertNode(_el$374, _el$375);
                _$insertNode(_el$374, _el$376);
                _$setProp(_el$374, "wrapMode", "word");
                _$insert(_el$374, () => usage().provider.used, _el$376);
                _$insert(_el$374, () => usage().provider.remaining, null);
                return _el$374;
              })(), (() => {
                var _el$377 = _$createElement("text"), _el$378 = _$createTextNode(`Recommendation synthesis used/remaining: `), _el$379 = _$createTextNode(` / `);
                _$insertNode(_el$377, _el$378);
                _$insertNode(_el$377, _el$379);
                _$setProp(_el$377, "wrapMode", "word");
                _$insert(_el$377, () => usage().synthesis.used, _el$379);
                _$insert(_el$377, () => usage().synthesis.remaining, null);
                return _el$377;
              })(), (() => {
                var _el$380 = _$createElement("text"), _el$381 = _$createTextNode(`Storage used/quota: `), _el$382 = _$createTextNode(` / `), _el$383 = _$createTextNode(` bytes`);
                _$insertNode(_el$380, _el$381);
                _$insertNode(_el$380, _el$382);
                _$insertNode(_el$380, _el$383);
                _$setProp(_el$380, "wrapMode", "word");
                _$insert(_el$380, () => usage().storage.usedBytes, _el$382);
                _$insert(_el$380, () => usage().storage.limitBytes, _el$383);
                return _el$380;
              })(), _$createComponent(Show, {
                get when() {
                  return activity().diagnostics.budgetResetAt;
                },
                children: (budgetResetAt) => [(() => {
                  var _el$384 = _$createElement("text"), _el$385 = _$createTextNode(`Provider calls reset: `);
                  _$insertNode(_el$384, _el$385);
                  _$setProp(_el$384, "wrapMode", "word");
                  _$insert(_el$384, () => new Date(budgetResetAt().provider).toISOString(), null);
                  return _el$384;
                })(), (() => {
                  var _el$386 = _$createElement("text"), _el$387 = _$createTextNode(`Recommendation synthesis resets: `);
                  _$insertNode(_el$386, _el$387);
                  _$setProp(_el$386, "wrapMode", "word");
                  _$insert(_el$386, () => new Date(budgetResetAt().synthesis).toISOString(), null);
                  return _el$386;
                })()]
              })]
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.lastError;
              },
              children: (lastError) => (() => {
                var _el$388 = _$createElement("text"), _el$389 = _$createTextNode(`Last bounded error: `);
                _$insertNode(_el$388, _el$389);
                _$setProp(_el$388, "wrapMode", "word");
                _$insert(_el$388, () => lastError().summary, null);
                return _el$388;
              })()
            }), null);
            return _el$74;
          }
        }), null);
        _$effect((_p$) => {
          var _v$26 = focusId("activity:diagnostics"), _v$27 = diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
          _v$26 !== _p$.e && (_p$.e = _$setProp(_el$71, "id", _v$26, _p$.e));
          _v$27 !== _p$.t && (_p$.t = _$setProp(_el$71, "borderColor", _v$27, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$64;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "settings";
      },
      get children() {
        var _el$99 = _$createElement("box"), _el$100 = _$createElement("text"), _el$101 = _$createElement("b"), _el$106 = _$createElement("text"), _el$107 = _$createElement("b"), _el$109 = _$createElement("box"), _el$110 = _$createElement("text"), _el$111 = _$createElement("b"), _el$112 = _$createElement("text"), _el$113 = _$createElement("text"), _el$115 = _$createElement("text"), _el$117 = _$createElement("text"), _el$118 = _$createElement("b"), _el$120 = _$createElement("box"), _el$121 = _$createElement("text"), _el$122 = _$createElement("b"), _el$124 = _$createTextNode(`: `), _el$125 = _$createElement("text"), _el$127 = _$createElement("text"), _el$128 = _$createTextNode(`Emergency stop: `), _el$129 = _$createTextNode(`. It overrides every automatic provider and write path.`), _el$130 = _$createElement("text"), _el$131 = _$createElement("b"), _el$133 = _$createElement("text"), _el$145 = _$createElement("text"), _el$146 = _$createElement("b"), _el$148 = _$createElement("text"), _el$150 = _$createElement("text"), _el$151 = _$createElement("b"), _el$153 = _$createElement("text"), _el$155 = _$createElement("box"), _el$156 = _$createElement("text"), _el$157 = _$createElement("box"), _el$164 = _$createElement("text"), _el$165 = _$createTextNode(`OpenCode `), _el$166 = _$createTextNode(` \xB7 Self-evolve `), _el$167 = _$createTextNode(` \xB7 Projection `), _el$168 = _$createTextNode(` \xB7 Dashboard `), _el$169 = _$createElement("text");
        _$insertNode(_el$99, _el$100);
        _$insertNode(_el$99, _el$106);
        _$insertNode(_el$99, _el$109);
        _$insertNode(_el$99, _el$117);
        _$insertNode(_el$99, _el$120);
        _$insertNode(_el$99, _el$127);
        _$insertNode(_el$99, _el$130);
        _$insertNode(_el$99, _el$133);
        _$insertNode(_el$99, _el$145);
        _$insertNode(_el$99, _el$148);
        _$insertNode(_el$99, _el$150);
        _$insertNode(_el$99, _el$153);
        _$insertNode(_el$99, _el$155);
        _$insertNode(_el$99, _el$156);
        _$insertNode(_el$99, _el$157);
        _$insertNode(_el$99, _el$164);
        _$insertNode(_el$99, _el$169);
        _$setProp(_el$99, "flexDirection", "column");
        _$setProp(_el$99, "gap", 1);
        _$insertNode(_el$100, _el$101);
        _$insertNode(_el$101, _$createTextNode(`Settings`));
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settingsAnchor();
          },
          children: (anchor) => (() => {
            var _el$390 = _$createElement("box"), _el$391 = _$createElement("text"), _el$392 = _$createTextNode(`Opened at `), _el$393 = _$createTextNode(` settings.`);
            _$insertNode(_el$390, _el$391);
            _$setProp(_el$390, "focusable", true);
            _$setProp(_el$390, "border", true);
            _$setProp(_el$390, "paddingLeft", 1);
            _$setProp(_el$390, "paddingRight", 1);
            _$setProp(_el$390, "on:focused", () => setFocusedControl(`anchor:${anchor()}`));
            _$setProp(_el$390, "on:blurred", () => setFocusedControl((current) => current === `anchor:${anchor()}` ? null : current));
            _$insertNode(_el$391, _el$392);
            _$insertNode(_el$391, _el$393);
            _$setProp(_el$391, "wrapMode", "word");
            _$insert(_el$391, () => focusMark(`anchor:${anchor()}`), _el$392);
            _$insert(_el$391, () => anchor().replaceAll("-", " "), _el$393);
            _$effect((_p$) => {
              var _v$71 = focusId(`anchor:${anchor()}`), _v$72 = focusedControl() === `anchor:${anchor()}` ? props.api.theme.current.borderActive : props.api.theme.current.info, _v$73 = props.api.theme.current.info;
              _v$71 !== _p$.e && (_p$.e = _$setProp(_el$390, "id", _v$71, _p$.e));
              _v$72 !== _p$.t && (_p$.t = _$setProp(_el$390, "borderColor", _v$72, _p$.t));
              _v$73 !== _p$.a && (_p$.a = _$setProp(_el$391, "fg", _v$73, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$390;
          })()
        }), _el$106);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().limited;
          },
          get children() {
            var _el$103 = _$createElement("text");
            _$insertNode(_el$103, _$createTextNode(`Limited view: enhanced usage and automation controls require an aligned server.`));
            _$setProp(_el$103, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$103, "fg", props.api.theme.current.warning, _$p));
            return _el$103;
          }
        }), _el$106);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().enhancedError;
          },
          get children() {
            var _el$105 = _$createElement("text");
            _$setProp(_el$105, "wrapMode", "word");
            _$insert(_el$105, () => settings().enhancedError);
            _$effect((_$p) => _$setProp(_el$105, "fg", props.api.theme.current.error, _$p));
            return _el$105;
          }
        }), _el$106);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().globalProtocol;
          },
          children: (globalProtocol) => (() => {
            var _el$394 = _$createElement("text"), _el$395 = _$createTextNode(`Global protocol: `), _el$396 = _$createTextNode(` \xB7 `);
            _$insertNode(_el$394, _el$395);
            _$insertNode(_el$394, _el$396);
            _$setProp(_el$394, "wrapMode", "word");
            _$insert(_el$394, () => globalProtocol().label, _el$396);
            _$insert(_el$394, () => globalProtocol().authoritative ? "authoritative" : "limited / read-only", null);
            _$effect((_$p) => _$setProp(_el$394, "fg", globalProtocol().authoritative ? props.api.theme.current.textMuted : props.api.theme.current.warning, _$p));
            return _el$394;
          })()
        }), _el$106);
        _$insertNode(_el$106, _el$107);
        _$insertNode(_el$107, _$createTextNode(`Automatic recommendations`));
        _$insertNode(_el$109, _el$110);
        _$insertNode(_el$109, _el$112);
        _$insertNode(_el$109, _el$113);
        _$insertNode(_el$109, _el$115);
        _$setProp(_el$109, "border", true);
        _$setProp(_el$109, "paddingLeft", 1);
        _$setProp(_el$109, "paddingRight", 1);
        _$setProp(_el$109, "flexDirection", "column");
        _$setProp(_el$109, "gap", 1);
        _$insertNode(_el$110, _el$111);
        _$insert(_el$111, () => settings().automaticRecommendations.enabled ? "On" : "Off");
        _$setProp(_el$112, "wrapMode", "word");
        _$insert(_el$112, () => settings().automaticRecommendations.description);
        _$insertNode(_el$113, _$createTextNode(`Turning On enables all three required data permissions in the same server-validated operation. Turning Off does not purge retained data or remove existing recommendations and actions.`));
        _$setProp(_el$113, "wrapMode", "word");
        _$insertNode(_el$115, _$createTextNode(`Emergency Stop, project exclusion, circuit breaker, budgets, and unavailable providers can suppress work without rewriting this preference.`));
        _$setProp(_el$115, "wrapMode", "word");
        _$insert(_el$109, _$createComponent(Show, {
          get when() {
            return settings().controls.automaticRecommendations;
          },
          get children() {
            return actionButton("automatic-recommendations", settings().automaticRecommendations.enabled ? "Turn Off" : "Turn On", () => setAutomaticRecommendations(!settings().automaticRecommendations.enabled), settings().automaticRecommendations.enabled !== true, {
              action: "set-automatic-recommendations",
              subject: "automatic-recommendations"
            });
          }
        }), null);
        _$insertNode(_el$117, _el$118);
        _$insertNode(_el$118, _$createTextNode(`Privacy and project scope`));
        _$insertNode(_el$120, _el$121);
        _$insertNode(_el$120, _el$125);
        _$setProp(_el$120, "border", true);
        _$setProp(_el$120, "paddingLeft", 1);
        _$setProp(_el$120, "paddingRight", 1);
        _$setProp(_el$120, "flexDirection", "column");
        _$insertNode(_el$121, _el$122);
        _$insertNode(_el$121, _el$124);
        _$insertNode(_el$122, _$createTextNode(`Include this project`));
        _$insert(_el$121, () => settings().projectExcluded ? "No" : "Yes", null);
        _$insertNode(_el$125, _$createTextNode(`Excluding this project suppresses automatic work here without changing the global On/Off preference.`));
        _$setProp(_el$125, "wrapMode", "word");
        _$insert(_el$120, _$createComponent(Show, {
          get when() {
            return settings().controls.projectInclusion;
          },
          get children() {
            return actionButton(settings().projectExcluded ? "include-project" : "exclude-project", settings().projectExcluded ? "Include this project" : "Exclude this project", () => props.store.submitOperation("set-repo-excluded", {
              excluded: !settings().projectExcluded
            }), settings().projectExcluded === true, {
              action: "set-repo-excluded",
              subject: "project-inclusion"
            });
          }
        }), null);
        _$insert(_el$99, () => reactiveChild(() => settings().consent.map((entry) => (() => {
          var _el$397 = _$createElement("box"), _el$398 = _$createElement("text"), _el$399 = _$createElement("b"), _el$400 = _$createTextNode(`: `), _el$401 = _$createTextNode(` \xB7 `), _el$402 = _$createElement("text"), _el$403 = _$createElement("text");
          _$insertNode(_el$397, _el$398);
          _$insertNode(_el$397, _el$402);
          _$insertNode(_el$397, _el$403);
          _$setProp(_el$397, "border", true);
          _$setProp(_el$397, "paddingLeft", 1);
          _$setProp(_el$397, "paddingRight", 1);
          _$setProp(_el$397, "flexDirection", "column");
          _$insertNode(_el$398, _el$399);
          _$insertNode(_el$398, _el$400);
          _$insertNode(_el$398, _el$401);
          _$insert(_el$399, () => entry.label);
          _$insert(_el$398, () => entry.enabled ? "Allowed" : "Not allowed", _el$401);
          _$insert(_el$398, () => entry.scope, null);
          _$setProp(_el$402, "wrapMode", "word");
          _$insert(_el$402, () => entry.description);
          _$setProp(_el$403, "wrapMode", "word");
          _$insert(_el$403, () => entry.dependency);
          _$insert(_el$397, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!settings().controls.consent)() && (entry.enabled || entry.canEnable);
            },
            get children() {
              return _$memo(() => !!entry.enabled)() ? actionButton(`consent-${entry.key}-off`, `Stop allowing ${entry.label}`, () => props.store.submitOperation("set-permission", {
                permission: entry.key,
                enabled: false
              }), false, {
                action: "set-permission",
                subject: `permission:${entry.key}`
              }) : localActionButton(`Review consent for ${entry.label}`, () => openConsentDisclosure(entry.key), false, undefined, undefined, `consent:${entry.key}`);
            }
          }), null);
          _$insert(_el$397, () => consentDisclosure(entry.key), null);
          _$insert(_el$397, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!entry.enabled)() && !entry.canEnable;
            },
            get children() {
              var _el$404 = _$createElement("text");
              _$insertNode(_el$404, _$createTextNode(`Resolve the dependency above before enabling this setting.`));
              _$setProp(_el$404, "wrapMode", "word");
              _$effect((_$p) => _$setProp(_el$404, "fg", props.api.theme.current.warning, _$p));
              return _el$404;
            }
          }), null);
          _$effect((_p$) => {
            var _v$74 = props.api.theme.current.borderSubtle, _v$75 = props.api.theme.current.textMuted;
            _v$74 !== _p$.e && (_p$.e = _$setProp(_el$397, "borderColor", _v$74, _p$.e));
            _v$75 !== _p$.t && (_p$.t = _$setProp(_el$403, "fg", _v$75, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$397;
        })())), _el$127);
        _$insertNode(_el$127, _el$128);
        _$insertNode(_el$127, _el$129);
        _$setProp(_el$127, "wrapMode", "word");
        _$insert(_el$127, () => settings().emergencyStop ? "On" : "Off", _el$129);
        _$insertNode(_el$130, _el$131);
        _$insertNode(_el$131, _$createTextNode(`Approved global skill folders`));
        _$setProp(_el$133, "wrapMode", "word");
        _$insert(_el$133, () => settings().approvedSkillFolderWarning);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return !settings().globalRoots.length;
          },
          get children() {
            var _el$134 = _$createElement("text");
            _$insertNode(_el$134, _$createTextNode(`No exact approved global root is available in this projection.`));
            _$setProp(_el$134, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$134, "fg", props.api.theme.current.warning, _$p));
            return _el$134;
          }
        }), _el$145);
        _$insert(_el$99, () => reactiveChild(() => settings().globalRoots.map((root, index) => (() => {
          var _el$406 = _$createElement("box"), _el$407 = _$createElement("text"), _el$408 = _$createElement("text"), _el$409 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$406, _el$407);
          _$insertNode(_el$406, _el$408);
          _$setProp(_el$406, "border", true);
          _$setProp(_el$406, "paddingLeft", 1);
          _$setProp(_el$406, "paddingRight", 1);
          _$setProp(_el$406, "flexDirection", "column");
          _$setProp(_el$407, "wrapMode", "word");
          _$insert(_el$407, () => root.canonicalPath);
          _$insertNode(_el$408, _el$409);
          _$setProp(_el$408, "wrapMode", "word");
          _$insert(_el$408, () => root.canUpdate ? "Update" : "No update", _el$409);
          _$insert(_el$408, () => root.canCreate ? "Create" : "No create", null);
          _$insert(_el$408, () => root.primaryCreationRoot ? " \xB7 Primary creation root" : "", null);
          _$insert(_el$406, _$createComponent(Show, {
            get when() {
              return settings().controls.approvedSkillFolders;
            },
            get children() {
              var _el$410 = _$createElement("box");
              _$setProp(_el$410, "flexDirection", "row");
              _$setProp(_el$410, "flexWrap", "wrap");
              _$setProp(_el$410, "gap", 1);
              _$insert(_el$410, () => localActionButton(`Edit ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots), false, undefined, undefined, `edit-root:${index}`), null);
              _$insert(_el$410, () => localActionButton(`Remove ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots.filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `remove-root:${index}`), null);
              return _el$410;
            }
          }), null);
          _$effect((_p$) => {
            var _v$76 = focusId(`root-row:${index}`), _v$77 = props.api.theme.current.borderSubtle, _v$78 = focusId(`root-capabilities:${index}`), _v$79 = props.api.theme.current.textMuted;
            _v$76 !== _p$.e && (_p$.e = _$setProp(_el$406, "id", _v$76, _p$.e));
            _v$77 !== _p$.t && (_p$.t = _$setProp(_el$406, "borderColor", _v$77, _p$.t));
            _v$78 !== _p$.a && (_p$.a = _$setProp(_el$408, "id", _v$78, _p$.a));
            _v$79 !== _p$.o && (_p$.o = _$setProp(_el$408, "fg", _v$79, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$406;
        })())), _el$145);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().collectionSuggestions.length;
          },
          get children() {
            var _el$136 = _$createElement("box"), _el$137 = _$createElement("text"), _el$138 = _$createElement("b");
            _$insertNode(_el$136, _el$137);
            _$setProp(_el$136, "flexDirection", "column");
            _$insertNode(_el$137, _el$138);
            _$insertNode(_el$138, _$createTextNode(`Legacy collection suggestions (no authority)`));
            _$insert(_el$136, () => reactiveChild(() => settings().collectionSuggestions.map((folder) => (() => {
              var _el$411 = _$createElement("text");
              _$setProp(_el$411, "wrapMode", "word");
              _$insert(_el$411, folder);
              return _el$411;
            })())), null);
            return _el$136;
          }
        }), _el$145);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().controls.approvedSkillFolders;
          },
          get children() {
            var _el$140 = _$createElement("box"), _el$141 = _$createElement("text"), _el$143 = _$createElement("input");
            _$insertNode(_el$140, _el$141);
            _$insertNode(_el$140, _el$143);
            _$setProp(_el$140, "flexDirection", "column");
            _$insertNode(_el$141, _$createTextNode(`Add one canonical absolute folder`));
            _$setProp(_el$143, "placeholder", "/canonical/path/to/skills");
            _$setProp(_el$143, "onInput", (value) => {
              setFolderInput(value.slice(0, 4096));
              setFolderError(null);
            });
            _$insert(_el$140, () => localActionButton("Add folder", stageFolderAdd), null);
            _$effect((_p$) => {
              var _v$28 = focusId("root-path-input"), _v$29 = folderInput();
              _v$28 !== _p$.e && (_p$.e = _$setProp(_el$143, "id", _v$28, _p$.e));
              _v$29 !== _p$.t && (_p$.t = _$setProp(_el$143, "value", _v$29, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$140;
          }
        }), _el$145);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return folderError();
          },
          get children() {
            var _el$144 = _$createElement("text");
            _$setProp(_el$144, "wrapMode", "word");
            _$insert(_el$144, folderError);
            _$effect((_$p) => _$setProp(_el$144, "fg", props.api.theme.current.warning, _$p));
            return _el$144;
          }
        }), _el$145);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return folderDraft();
          },
          children: (draft) => (() => {
            var _el$412 = _$createElement("box"), _el$413 = _$createElement("text"), _el$414 = _$createElement("b"), _el$416 = _$createElement("text"), _el$417 = _$createTextNode(`Type exactly: `), _el$418 = _$createElement("input"), _el$419 = _$createElement("box");
            _$insertNode(_el$412, _el$413);
            _$insertNode(_el$412, _el$416);
            _$insertNode(_el$412, _el$418);
            _$insertNode(_el$412, _el$419);
            _$setProp(_el$412, "border", true);
            _$setProp(_el$412, "paddingLeft", 1);
            _$setProp(_el$412, "paddingRight", 1);
            _$setProp(_el$412, "flexDirection", "column");
            _$insertNode(_el$413, _el$414);
            _$insertNode(_el$414, _$createTextNode(`Complete authoritative replacement`));
            _$insert(_el$412, () => reactiveChild(() => draft().map((root, index) => (() => {
              var _el$420 = _$createElement("box"), _el$421 = _$createElement("text"), _el$422 = _$createElement("box");
              _$insertNode(_el$420, _el$421);
              _$insertNode(_el$420, _el$422);
              _$setProp(_el$420, "border", true);
              _$setProp(_el$420, "paddingLeft", 1);
              _$setProp(_el$420, "paddingRight", 1);
              _$setProp(_el$420, "flexDirection", "column");
              _$setProp(_el$421, "wrapMode", "word");
              _$insert(_el$421, () => root.canonicalPath);
              _$setProp(_el$422, "flexDirection", "row");
              _$setProp(_el$422, "flexWrap", "wrap");
              _$setProp(_el$422, "gap", 1);
              _$insert(_el$422, () => localActionButton(root.canUpdate ? "Update allowed" : "Allow updates", () => updateFolderDraft(index, {
                canUpdate: !root.canUpdate
              }), false, undefined, undefined, `draft-update:${index}`), null);
              _$insert(_el$422, () => localActionButton(root.canCreate ? "Create allowed" : "Allow creation", () => updateFolderDraft(index, {
                canCreate: !root.canCreate,
                ...!root.canCreate ? {} : {
                  primaryCreationRoot: false
                }
              }), false, undefined, undefined, `draft-create:${index}`), null);
              _$insert(_el$422, () => localActionButton(root.primaryCreationRoot ? "Primary creation root" : "Make primary creation root", () => {
                setFolderDraft((current) => current?.map((entry, currentIndex) => ({
                  ...entry,
                  primaryCreationRoot: currentIndex === index,
                  canCreate: currentIndex === index
                })) ?? null);
                setFolderConfirmation("");
                setFolderError(null);
              }, root.primaryCreationRoot, undefined, undefined, `draft-primary:${index}`), null);
              _$insert(_el$422, () => localActionButton("Remove row", () => stageFolderList(draft().filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `draft-remove:${index}`), null);
              _$effect((_$p) => _$setProp(_el$420, "borderColor", props.api.theme.current.borderSubtle, _$p));
              return _el$420;
            })())), _el$416);
            _$insertNode(_el$416, _el$417);
            _$setProp(_el$416, "wrapMode", "word");
            _$insert(_el$416, () => settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable", null);
            _$setProp(_el$418, "onInput", (value) => setFolderConfirmation(value.slice(0, 64)));
            _$setProp(_el$419, "flexDirection", "row");
            _$setProp(_el$419, "flexWrap", "wrap");
            _$setProp(_el$419, "gap", 1);
            _$insert(_el$419, () => localActionButton("Replace authoritative roots", () => void submitFolderList(), true, undefined, {
              action: "replace-global-root-policy",
              subject: "project"
            }), null);
            _$insert(_el$419, () => localActionButton("Cancel", () => {
              setFolderDraft(null);
              setFolderConfirmation("");
            }, false, undefined, undefined, "cancel-folder-update"), null);
            _$effect((_p$) => {
              var _v$80 = props.api.theme.current.warning, _v$81 = focusId("root-policy-confirmation"), _v$82 = folderConfirmation(), _v$83 = settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable";
              _v$80 !== _p$.e && (_p$.e = _$setProp(_el$412, "borderColor", _v$80, _p$.e));
              _v$81 !== _p$.t && (_p$.t = _$setProp(_el$418, "id", _v$81, _p$.t));
              _v$82 !== _p$.a && (_p$.a = _$setProp(_el$418, "value", _v$82, _p$.a));
              _v$83 !== _p$.o && (_p$.o = _$setProp(_el$418, "placeholder", _v$83, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$412;
          })()
        }), _el$145);
        _$insertNode(_el$145, _el$146);
        _$insertNode(_el$146, _$createTextNode(`Limits and retention`));
        _$insertNode(_el$148, _$createTextNode(`These values are read-only here. Change configured numeric limits through startup configuration.`));
        _$setProp(_el$148, "wrapMode", "word");
        _$insert(_el$99, () => reactiveChild(() => settings().limits.map((limit) => (() => {
          var _el$423 = _$createElement("box"), _el$424 = _$createElement("text"), _el$425 = _$createElement("b"), _el$426 = _$createElement("text"), _el$427 = _$createTextNode(`Actual: `), _el$428 = _$createElement("text"), _el$429 = _$createTextNode(`Configured limit: `), _el$430 = _$createElement("text");
          _$insertNode(_el$423, _el$424);
          _$insertNode(_el$423, _el$426);
          _$insertNode(_el$423, _el$428);
          _$insertNode(_el$423, _el$430);
          _$setProp(_el$423, "border", true);
          _$setProp(_el$423, "paddingLeft", 1);
          _$setProp(_el$423, "paddingRight", 1);
          _$setProp(_el$423, "flexDirection", "column");
          _$insertNode(_el$424, _el$425);
          _$insert(_el$425, () => limit.label);
          _$insertNode(_el$426, _el$427);
          _$setProp(_el$426, "wrapMode", "word");
          _$insert(_el$426, () => limit.actual, null);
          _$insertNode(_el$428, _el$429);
          _$setProp(_el$428, "wrapMode", "word");
          _$insert(_el$428, () => limit.configured, null);
          _$insert(_el$423, _$createComponent(Show, {
            get when() {
              return limit.resetAt;
            },
            children: (resetAt) => (() => {
              var _el$431 = _$createElement("text"), _el$432 = _$createTextNode(`Resets: `);
              _$insertNode(_el$431, _el$432);
              _$setProp(_el$431, "wrapMode", "word");
              _$insert(_el$431, () => new Date(resetAt()).toISOString(), null);
              return _el$431;
            })()
          }), _el$430);
          _$setProp(_el$430, "wrapMode", "word");
          _$insert(_el$430, () => limit.explanation);
          _$effect((_p$) => {
            var _v$84 = props.api.theme.current.borderSubtle, _v$85 = props.api.theme.current.textMuted;
            _v$84 !== _p$.e && (_p$.e = _$setProp(_el$423, "borderColor", _v$84, _p$.e));
            _v$85 !== _p$.t && (_p$.t = _$setProp(_el$430, "fg", _v$85, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$423;
        })())), _el$150);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().rolloutProgress;
          },
          children: (rolloutProgress) => (() => {
            var _el$433 = _$createElement("box"), _el$434 = _$createElement("text"), _el$435 = _$createElement("b"), _el$437 = _$createTextNode(`: `), _el$438 = _$createElement("text"), _el$439 = _$createTextNode(`Actual: `), _el$440 = _$createElement("text"), _el$441 = _$createTextNode(`Configured requirement: `);
            _$insertNode(_el$433, _el$434);
            _$insertNode(_el$433, _el$438);
            _$insertNode(_el$433, _el$440);
            _$setProp(_el$433, "border", true);
            _$setProp(_el$433, "paddingLeft", 1);
            _$setProp(_el$433, "paddingRight", 1);
            _$setProp(_el$433, "flexDirection", "column");
            _$insertNode(_el$434, _el$435);
            _$insertNode(_el$434, _el$437);
            _$insertNode(_el$435, _$createTextNode(`Compatibility rollout diagnostics (no authority)`));
            _$insert(_el$434, () => rolloutProgress().ready ? "Threshold met" : "Threshold not met", null);
            _$insertNode(_el$438, _el$439);
            _$setProp(_el$438, "wrapMode", "word");
            _$insert(_el$438, () => rolloutProgress().actual, null);
            _$insertNode(_el$440, _el$441);
            _$setProp(_el$440, "wrapMode", "word");
            _$insert(_el$440, () => rolloutProgress().configured, null);
            _$effect((_$p) => _$setProp(_el$433, "borderColor", props.api.theme.current.borderSubtle, _$p));
            return _el$433;
          })()
        }), _el$150);
        _$insertNode(_el$150, _el$151);
        _$insertNode(_el$151, _$createTextNode(`Maintenance`));
        _$insertNode(_el$153, _$createTextNode(`Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.`));
        _$setProp(_el$153, "wrapMode", "word");
        _$setProp(_el$155, "flexDirection", "row");
        _$setProp(_el$155, "flexWrap", "wrap");
        _$setProp(_el$155, "gap", 1);
        _$insert(_el$155, () => reactiveChild(() => settings().maintenance.scopes.map((scope) => (() => {
          var _el$442 = _$createElement("box"), _el$443 = _$createElement("text");
          _$insertNode(_el$442, _el$443);
          _$setProp(_el$442, "focusable", true);
          _$setProp(_el$442, "border", true);
          _$setProp(_el$442, "paddingLeft", 1);
          _$setProp(_el$442, "paddingRight", 1);
          _$setProp(_el$442, "on:focused", () => setFocusedControl(`maintenance-scope:${scope.value}`));
          _$setProp(_el$442, "on:blurred", () => setFocusedControl((current) => current === `maintenance-scope:${scope.value}` ? null : current));
          _$setProp(_el$442, "onMouseUp", () => {
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$setProp(_el$442, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$insert(_el$443, () => focusMark(`maintenance-scope:${scope.value}`), null);
          _$insert(_el$443, () => scope.label, null);
          _$effect((_$p) => _$setProp(_el$442, "borderColor", maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$442;
        })())));
        _$setProp(_el$156, "wrapMode", "word");
        _$insert(_el$156, () => settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation);
        _$setProp(_el$157, "flexDirection", "row");
        _$setProp(_el$157, "flexWrap", "wrap");
        _$setProp(_el$157, "gap", 1);
        _$insert(_el$157, _$createComponent(Show, {
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
        _$insert(_el$157, _$createComponent(Show, {
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
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return maintenanceIntent();
          },
          get children() {
            var _el$158 = _$createElement("box"), _el$159 = _$createElement("text"), _el$160 = _$createElement("text"), _el$161 = _$createTextNode(`Type exactly: `), _el$162 = _$createElement("input"), _el$163 = _$createElement("box");
            _$insertNode(_el$158, _el$159);
            _$insertNode(_el$158, _el$160);
            _$insertNode(_el$158, _el$162);
            _$insertNode(_el$158, _el$163);
            _$setProp(_el$158, "border", true);
            _$setProp(_el$158, "paddingLeft", 1);
            _$setProp(_el$158, "paddingRight", 1);
            _$setProp(_el$158, "flexDirection", "column");
            _$setProp(_el$159, "wrapMode", "word");
            _$insert(_el$159, (() => {
              var _c$5 = _$memo(() => maintenanceIntent() === "export");
              return () => _c$5() ? "The export may contain classified Self-evolve evidence and active skill snapshots." : maintenanceScope() === "all" ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted." : "The selected retained data will be permanently deleted after fresh server validation.";
            })());
            _$insertNode(_el$160, _el$161);
            _$insert(_el$160, maintenancePhrase, null);
            _$setProp(_el$162, "onInput", (value) => setMaintenanceConfirmation(value.slice(0, 64)));
            _$setProp(_el$163, "flexDirection", "row");
            _$setProp(_el$163, "flexWrap", "wrap");
            _$setProp(_el$163, "gap", 1);
            _$insert(_el$163, () => localActionButton(maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently", () => void submitMaintenance(), true, undefined, {
              action: maintenanceIntent() === "export" ? "export-data" : maintenanceScope() === "all" ? "purge-all" : "purge-scope",
              subject: maintenanceScope() === "all" && maintenanceIntent() === "delete" ? "project" : `scope:${maintenanceScope()}`
            }), null);
            _$insert(_el$163, () => localActionButton("Cancel", () => {
              setMaintenanceIntent(null);
              setMaintenanceConfirmation("");
            }, false, undefined, undefined, "cancel-maintenance"), null);
            _$effect((_p$) => {
              var _v$30 = props.api.theme.current.warning, _v$31 = maintenanceConfirmation(), _v$32 = maintenancePhrase();
              _v$30 !== _p$.e && (_p$.e = _$setProp(_el$158, "borderColor", _v$30, _p$.e));
              _v$31 !== _p$.t && (_p$.t = _$setProp(_el$162, "value", _v$31, _p$.t));
              _v$32 !== _p$.a && (_p$.a = _$setProp(_el$162, "placeholder", _v$32, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$158;
          }
        }), _el$164);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().latestExport;
          },
          children: (latestExport) => (() => {
            var _el$444 = _$createElement("box"), _el$445 = _$createElement("text"), _el$446 = _$createElement("b"), _el$448 = _$createElement("text"), _el$449 = _$createTextNode(`Scope: `), _el$450 = _$createElement("text"), _el$451 = _$createTextNode(`Private path: `), _el$452 = _$createElement("text"), _el$453 = _$createTextNode(`Size: `), _el$454 = _$createTextNode(` bytes`), _el$455 = _$createElement("text"), _el$456 = _$createTextNode(`SHA-256: `), _el$457 = _$createElement("text"), _el$458 = _$createTextNode(`Expires: `);
            _$insertNode(_el$444, _el$445);
            _$insertNode(_el$444, _el$448);
            _$insertNode(_el$444, _el$450);
            _$insertNode(_el$444, _el$452);
            _$insertNode(_el$444, _el$455);
            _$insertNode(_el$444, _el$457);
            _$setProp(_el$444, "border", true);
            _$setProp(_el$444, "paddingLeft", 1);
            _$setProp(_el$444, "paddingRight", 1);
            _$setProp(_el$444, "flexDirection", "column");
            _$insertNode(_el$445, _el$446);
            _$insertNode(_el$446, _$createTextNode(`Latest private export`));
            _$insertNode(_el$448, _el$449);
            _$setProp(_el$448, "wrapMode", "word");
            _$insert(_el$448, () => latestExport().scope, null);
            _$insertNode(_el$450, _el$451);
            _$setProp(_el$450, "wrapMode", "word");
            _$insert(_el$450, () => latestExport().path, null);
            _$insertNode(_el$452, _el$453);
            _$insertNode(_el$452, _el$454);
            _$setProp(_el$452, "wrapMode", "word");
            _$insert(_el$452, () => latestExport().bytes, _el$454);
            _$insertNode(_el$455, _el$456);
            _$setProp(_el$455, "wrapMode", "word");
            _$insert(_el$455, () => latestExport().sha256, null);
            _$insertNode(_el$457, _el$458);
            _$setProp(_el$457, "wrapMode", "word");
            _$insert(_el$457, () => new Date(latestExport().expiresAt).toISOString(), null);
            _$effect((_$p) => _$setProp(_el$444, "borderColor", props.api.theme.current.warning, _$p));
            return _el$444;
          })()
        }), _el$164);
        _$insertNode(_el$164, _el$165);
        _$insertNode(_el$164, _el$166);
        _$insertNode(_el$164, _el$167);
        _$insertNode(_el$164, _el$168);
        _$setProp(_el$164, "wrapMode", "word");
        _$insert(_el$164, () => settings().footer.hostVersion, _el$166);
        _$insert(_el$164, () => settings().footer.pluginVersion, _el$167);
        _$insert(_el$164, () => settings().footer.projectionVersion ?? "Unavailable", _el$168);
        _$insert(_el$164, () => settings().footer.dashboardVersion ?? "Unavailable", null);
        _$setProp(_el$169, "wrapMode", "word");
        _$insert(_el$169, () => settings().footer.help);
        _$effect((_p$) => {
          var _v$33 = focusId("anchor:automatic-recommendations"), _v$34 = props.api.theme.current.borderSubtle, _v$35 = props.api.theme.current.textMuted, _v$36 = props.api.theme.current.textMuted, _v$37 = props.api.theme.current.borderSubtle, _v$38 = props.api.theme.current.textMuted, _v$39 = props.api.theme.current.textMuted;
          _v$33 !== _p$.e && (_p$.e = _$setProp(_el$109, "id", _v$33, _p$.e));
          _v$34 !== _p$.t && (_p$.t = _$setProp(_el$109, "borderColor", _v$34, _p$.t));
          _v$35 !== _p$.a && (_p$.a = _$setProp(_el$113, "fg", _v$35, _p$.a));
          _v$36 !== _p$.o && (_p$.o = _$setProp(_el$115, "fg", _v$36, _p$.o));
          _v$37 !== _p$.i && (_p$.i = _$setProp(_el$120, "borderColor", _v$37, _p$.i));
          _v$38 !== _p$.n && (_p$.n = _$setProp(_el$164, "fg", _v$38, _p$.n));
          _v$39 !== _p$.s && (_p$.s = _$setProp(_el$169, "fg", _v$39, _p$.s));
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
        return _el$99;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return props.snapshot().responses.length || feedback();
      },
      get children() {
        var _el$170 = _$createElement("box"), _el$171 = _$createElement("box"), _el$172 = _$createElement("text"), _el$173 = _$createTextNode(`Outcomes and next steps \xB7 `), _el$174 = _$createTextNode(` retained`), _el$175 = _$createTextNode(` `);
        _$insertNode(_el$170, _el$171);
        _$setProp(_el$170, "id", "self-evolve-outcomes");
        _$setProp(_el$170, "border", true);
        _$setProp(_el$170, "paddingLeft", 1);
        _$setProp(_el$170, "paddingRight", 1);
        _$setProp(_el$170, "flexDirection", "column");
        _$insertNode(_el$171, _el$172);
        _$setProp(_el$171, "focusable", true);
        _$setProp(_el$171, "on:focused", () => setFocusedControl("outcomes-summary"));
        _$setProp(_el$171, "on:blurred", () => setFocusedControl((current) => current === "outcomes-summary" ? null : current));
        _$setProp(_el$171, "onMouseUp", () => setOutcomesExpanded((value) => !value));
        _$setProp(_el$171, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setOutcomesExpanded((value) => !value);
        });
        _$insertNode(_el$172, _el$173);
        _$insertNode(_el$172, _el$174);
        _$insertNode(_el$172, _el$175);
        _$insert(_el$172, () => focusMark("outcomes-summary"), _el$173);
        _$insert(_el$172, () => props.snapshot().responses.length, _el$174);
        _$insert(_el$172, () => feedback() ? " \xB7 current feedback" : "", _el$175);
        _$insert(_el$172, () => outcomesExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$170, _$createComponent(Show, {
          get when() {
            return outcomesExpanded();
          },
          get children() {
            return [_$memo(() => reactiveChild(() => props.snapshot().responses.map((completedResponse, index) => (() => {
              var _el$459 = _$createElement("box"), _el$460 = _$createElement("text");
              _$insertNode(_el$459, _el$460);
              _$setProp(_el$459, "focusable", true);
              _$setProp(_el$459, "on:focused", () => setFocusedControl(`outcome:${index}`));
              _$setProp(_el$459, "on:blurred", () => setFocusedControl((current) => current === `outcome:${index}` ? null : current));
              _$setProp(_el$460, "wrapMode", "word");
              _$insert(_el$460, () => focusMark(`outcome:${index}`), null);
              _$insert(_el$460, () => requestResponseMessage(completedResponse), null);
              _$effect((_p$) => {
                var _v$86 = focusId(`outcome:${index}`), _v$87 = completedResponse.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info;
                _v$86 !== _p$.e && (_p$.e = _$setProp(_el$459, "id", _v$86, _p$.e));
                _v$87 !== _p$.t && (_p$.t = _$setProp(_el$460, "fg", _v$87, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$459;
            })()))), _$createComponent(Show, {
              get when() {
                return feedback();
              },
              children: (message) => (() => {
                var _el$461 = _$createElement("box"), _el$462 = _$createElement("text");
                _$insertNode(_el$461, _el$462);
                _$setProp(_el$461, "focusable", true);
                _$setProp(_el$461, "on:focused", () => setFocusedControl("outcome-feedback"));
                _$setProp(_el$461, "on:blurred", () => setFocusedControl((current) => current === "outcome-feedback" ? null : current));
                _$setProp(_el$462, "wrapMode", "word");
                _$insert(_el$462, () => focusMark("outcome-feedback"), null);
                _$insert(_el$462, message, null);
                _$effect((_p$) => {
                  var _v$88 = focusId("outcome-feedback"), _v$89 = props.api.theme.current.info;
                  _v$88 !== _p$.e && (_p$.e = _$setProp(_el$461, "id", _v$88, _p$.e));
                  _v$89 !== _p$.t && (_p$.t = _$setProp(_el$462, "fg", _v$89, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$461;
              })()
            })];
          }
        }), null);
        _$effect((_p$) => {
          var _v$40 = outcomesExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$41 = focusId("outcomes-summary");
          _v$40 !== _p$.e && (_p$.e = _$setProp(_el$170, "borderColor", _v$40, _p$.e));
          _v$41 !== _p$.t && (_p$.t = _$setProp(_el$171, "id", _v$41, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$170;
      }
    }), null);
    _$insertNode(_el$176, _el$177);
    _$setProp(_el$176, "flexDirection", "column");
    _$setProp(_el$176, "flexShrink", 0);
    _$setProp(_el$176, "overflow", "hidden");
    _$insertNode(_el$177, _el$178);
    _$insert(_el$177, () => props.prior().name, null);
    _$effect((_p$) => {
      var _v$42 = compactShell() ? 1 : 2, _v$43 = compactShell() ? 1 : 2, _v$44 = compactShell() ? 3 : "auto", _v$45 = props.api.theme.current.text, _v$46 = props.api.theme.current.textMuted, _v$47 = compactShell() ? 2 : "auto", _v$48 = props.api.theme.current.textMuted;
      _v$42 !== _p$.e && (_p$.e = _$setProp(_el$21, "paddingLeft", _v$42, _p$.e));
      _v$43 !== _p$.t && (_p$.t = _$setProp(_el$21, "paddingRight", _v$43, _p$.t));
      _v$44 !== _p$.a && (_p$.a = _$setProp(_el$22, "height", _v$44, _p$.a));
      _v$45 !== _p$.o && (_p$.o = _$setProp(_el$24, "fg", _v$45, _p$.o));
      _v$46 !== _p$.i && (_p$.i = _$setProp(_el$27, "fg", _v$46, _p$.i));
      _v$47 !== _p$.n && (_p$.n = _$setProp(_el$176, "height", _v$47, _p$.n));
      _v$48 !== _p$.s && (_p$.s = _$setProp(_el$177, "fg", _v$48, _p$.s));
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
    return _el$21;
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
  let inertStore;
  const startupConfig = options?.selfEvolve ?? options ?? {};
  const retryStartup = async () => {
    const result = await attemptTuiStartup(api, startupConfig);
    return result.ok ? {
      ok: true
    } : {
      ok: false,
      diagnostic: result.diagnostic
    };
  };
  const projectStoreFactory = options?.__testTuiStoreFactory ?? acquireProjectTuiStore;
  const compatibilityOptions = {
    ...options ?? {},
    __nativeSidebar: true,
    __testTuiStoreFactory(input) {
      projectStore = projectStoreFactory(input);
      return projectStore;
    },
    __nativeStartupFailure(failure) {
      if (inertStore || projectStore)
        return;
      inertStore = createInertRecoveryStore({
        diagnostic: failure.diagnostic,
        retry: retryStartup
      });
    }
  };
  await legacyModule.tui(api, compatibilityOptions, meta);
  const store = projectStore ?? inertStore;
  if (!store)
    return;
  releaseWithNativeCleanup = true;
  api.lifecycle.onDispose(() => {
    inertStore?.dispose?.();
  });
  const [priorRoute, setPriorRoute] = createSignal({
    name: "home"
  });
  const [routeRevision, setRouteRevision] = createSignal(0);
  const initialSnapshot = store.getSnapshot();
  const [snapshot, setSnapshot] = createSignal(initialSnapshot);
  let activeGlobalIdentity = globalSnapshotIdentity(initialSnapshot);
  const unsubscribe = store.subscribe((next) => {
    const nextGlobalIdentity = globalSnapshotIdentity(next);
    const currentParams = api.route.current.name === CONTROL_CENTER_ROUTE && "params" in api.route.current ? api.route.current.params : undefined;
    const invalidRecommendationRoute = currentParams?.section === "recommendations" && typeof currentParams.recommendation === "string" && parseControlCenterDestination(currentParams, next).section === "home";
    let clearDetails = false;
    if (activeGlobalIdentity !== nextGlobalIdentity) {
      setPriorRoute({
        name: "home"
      });
      if (api.route.current.name === CONTROL_CENTER_ROUTE) {
        clearDetails = true;
        setRouteRevision((revision) => revision + 1);
        api.route.navigate(CONTROL_CENTER_ROUTE, {
          section: "home"
        });
      }
    } else if (invalidRecommendationRoute) {
      clearDetails = true;
      setRouteRevision((revision) => revision + 1);
      api.route.navigate(CONTROL_CENTER_ROUTE, {
        section: "home"
      });
    }
    activeGlobalIdentity = nextGlobalIdentity;
    setSnapshot(next);
    if (clearDetails)
      projectStore.selectDetails([]);
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
      store,
      snapshot,
      prior: priorRoute,
      routeRevision,
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
        return (() => {
          var _el$463 = _$createElement("box");
          _$setProp(_el$463, "flexDirection", "column");
          _$setProp(_el$463, "width", "100%");
          _$setProp(_el$463, "gap", 1);
          _$insert(_el$463, _$createComponent(SidebarCard, {
            api,
            card: () => deriveSidebarCard(snapshot()),
            open: () => {
              const card = deriveSidebarCard(snapshot());
              openControlCenter(card.destination);
            }
          }), null);
          _$insert(_el$463, _$createComponent(SidebarModeControl, {
            api,
            store,
            snapshot
          }), null);
          return _el$463;
        })();
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
