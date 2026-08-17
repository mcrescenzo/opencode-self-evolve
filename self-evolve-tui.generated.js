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
        return model().health;
      },
      children: (health) => (() => {
        var _el$181 = _$createElement("box"), _el$182 = _$createElement("text"), _el$183 = _$createElement("b"), _el$185 = _$createTextNode(`: polling backed off`), _el$186 = _$createElement("text"), _el$187 = _$createTextNode(` consecutive refresh failures (`), _el$188 = _$createTextNode(`). Data may be stale until a refresh succeeds.`);
        _$insertNode(_el$181, _el$182);
        _$insertNode(_el$181, _el$186);
        _$setProp(_el$181, "border", true);
        _$setProp(_el$181, "paddingLeft", 1);
        _$setProp(_el$181, "paddingRight", 1);
        _$setProp(_el$181, "flexDirection", "column");
        _$insertNode(_el$182, _el$183);
        _$insertNode(_el$182, _el$185);
        _$insertNode(_el$183, _$createTextNode(`Refresh degraded`));
        _$insertNode(_el$186, _el$187);
        _$insertNode(_el$186, _el$188);
        _$setProp(_el$186, "wrapMode", "word");
        _$insert(_el$186, () => health().consecutiveFailures, _el$187);
        _$insert(_el$186, () => health().reason, _el$188);
        _$effect((_p$) => {
          var _v$52 = props.api.theme.current.warning, _v$53 = props.api.theme.current.textMuted;
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
        return model().recovery;
      },
      children: (recovery) => (() => {
        var _el$189 = _$createElement("box"), _el$190 = _$createElement("text"), _el$191 = _$createElement("b"), _el$192 = _$createElement("text"), _el$193 = _$createTextNode(`Latest refresh failed: `), _el$194 = _$createElement("text");
        _$insertNode(_el$189, _el$190);
        _$insertNode(_el$189, _el$192);
        _$insertNode(_el$189, _el$194);
        _$setProp(_el$189, "border", true);
        _$setProp(_el$189, "paddingLeft", 1);
        _$setProp(_el$189, "paddingRight", 1);
        _$setProp(_el$189, "flexDirection", "column");
        _$setProp(_el$189, "gap", 1);
        _$insertNode(_el$190, _el$191);
        _$insert(_el$191, () => recovery().stale ? "Read-only stale snapshot" : "Projection unavailable");
        _$insertNode(_el$192, _el$193);
        _$setProp(_el$192, "wrapMode", "word");
        _$insert(_el$192, () => recovery().diagnostic, null);
        _$insertNode(_el$194, _$createTextNode(`Decision, control, and operation actions are unavailable until a fresh projection is negotiated.`));
        _$setProp(_el$194, "wrapMode", "word");
        _$insert(_el$189, _$createComponent(Show, {
          get when() {
            return recovery().canRetry;
          },
          get children() {
            return localActionButton("Retry", () => void retryProjection());
          }
        }), null);
        _$effect((_p$) => {
          var _v$54 = props.api.theme.current.error, _v$55 = props.api.theme.current.textMuted;
          _v$54 !== _p$.e && (_p$.e = _$setProp(_el$189, "borderColor", _v$54, _p$.e));
          _v$55 !== _p$.t && (_p$.t = _$setProp(_el$194, "fg", _v$55, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$189;
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
            var _el$196 = _$createElement("box"), _el$197 = _$createElement("text"), _el$198 = _$createElement("b"), _el$200 = _$createTextNode(`: `), _el$201 = _$createElement("text"), _el$202 = _$createTextNode(`Protocol: `);
            _$insertNode(_el$196, _el$197);
            _$insertNode(_el$196, _el$201);
            _$setProp(_el$196, "border", true);
            _$setProp(_el$196, "paddingLeft", 1);
            _$setProp(_el$196, "paddingRight", 1);
            _$setProp(_el$196, "flexDirection", "column");
            _$insertNode(_el$197, _el$198);
            _$insertNode(_el$197, _el$200);
            _$insertNode(_el$198, _$createTextNode(`Global recommendations`));
            _$insert(_el$197, () => globalReadiness().state === "ready" ? "Ready" : "Limited / read-only", null);
            _$insertNode(_el$201, _el$202);
            _$setProp(_el$201, "wrapMode", "word");
            _$insert(_el$201, () => globalReadiness().label, null);
            _$insert(_el$196, _$createComponent(Show, {
              get when() {
                return globalReadiness().recommendationCount !== null;
              },
              get children() {
                var _el$203 = _$createElement("text"), _el$204 = _$createTextNode(` global recommendation`);
                _$insertNode(_el$203, _el$204);
                _$insert(_el$203, () => globalReadiness().recommendationCount, _el$204);
                _$insert(_el$203, () => globalReadiness().recommendationCount === 1 ? "" : "s", null);
                return _el$203;
              }
            }), null);
            _$insert(_el$196, _$createComponent(Show, {
              get when() {
                return globalReadiness().reason;
              },
              get children() {
                var _el$205 = _$createElement("text");
                _$setProp(_el$205, "wrapMode", "word");
                _$insert(_el$205, () => globalReadiness().reason);
                _$effect((_$p) => _$setProp(_el$205, "fg", props.api.theme.current.textMuted, _$p));
                return _el$205;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$196, "borderColor", globalReadiness().state === "ready" ? props.api.theme.current.borderSubtle : props.api.theme.current.warning, _$p));
            return _el$196;
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
              var _el$206 = _$createElement("box"), _el$207 = _$createElement("text"), _el$208 = _$createTextNode(` \xB7 Open `);
              _$insertNode(_el$206, _el$207);
              _$setProp(_el$206, "focusable", true);
              _$setProp(_el$206, "border", true);
              _$setProp(_el$206, "paddingLeft", 1);
              _$setProp(_el$206, "paddingRight", 1);
              _$setProp(_el$206, "on:focused", () => setFocusedControl(`blocker:${blocker.code}`));
              _$setProp(_el$206, "on:blurred", () => setFocusedControl((current) => current === `blocker:${blocker.code}` ? null : current));
              _$setProp(_el$206, "onMouseUp", () => navigate(blocker.destination));
              _$setProp(_el$206, "onKeyDown", (event) => {
                if (!isActivationKey(event))
                  return;
                event.preventDefault();
                navigate(blocker.destination);
              });
              _$insertNode(_el$207, _el$208);
              _$setProp(_el$207, "wrapMode", "word");
              _$insert(_el$207, () => focusMark(`blocker:${blocker.code}`), _el$208);
              _$insert(_el$207, () => blocker.summary, _el$208);
              _$insert(_el$207, (() => {
                var _c$7 = _$memo(() => blocker.destination.section === "activity");
                return () => _c$7() ? "Activity errors" : blocker.destination.section.charAt(0).toUpperCase() + blocker.destination.section.slice(1);
              })(), null);
              _$effect((_$p) => _$setProp(_el$206, "borderColor", props.api.theme.current.warning, _$p));
              return _el$206;
            })())), null);
            return _el$47;
          }
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().lastCycle;
          },
          children: (lastCycle) => (() => {
            var _el$209 = _$createElement("box"), _el$210 = _$createElement("text"), _el$211 = _$createElement("b"), _el$213 = _$createElement("text"), _el$214 = _$createTextNode(` \xB7 `), _el$215 = _$createTextNode(` observations \xB7 `), _el$216 = _$createTextNode(` eligible`);
            _$insertNode(_el$209, _el$210);
            _$insertNode(_el$209, _el$213);
            _$setProp(_el$209, "flexDirection", "column");
            _$insertNode(_el$210, _el$211);
            _$insertNode(_el$211, _$createTextNode(`Last cycle`));
            _$insertNode(_el$213, _el$214);
            _$insertNode(_el$213, _el$215);
            _$insertNode(_el$213, _el$216);
            _$setProp(_el$213, "wrapMode", "word");
            _$insert(_el$213, () => lastCycle().outcome.replaceAll("-", " "), _el$214);
            _$insert(_el$213, () => lastCycle().observationCount, _el$215);
            _$insert(_el$213, () => lastCycle().eligibilityCount, _el$216);
            return _el$209;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().attention;
          },
          children: (attention) => (() => {
            var _el$217 = _$createElement("box"), _el$218 = _$createElement("text"), _el$219 = _$createTextNode(` `), _el$220 = _$createTextNode(` needs attention`);
            _$insertNode(_el$217, _el$218);
            _$setProp(_el$217, "focusable", true);
            _$setProp(_el$217, "border", true);
            _$setProp(_el$217, "paddingLeft", 1);
            _$setProp(_el$217, "paddingRight", 1);
            _$setProp(_el$217, "on:focused", () => setFocusedControl("home:attention"));
            _$setProp(_el$217, "on:blurred", () => setFocusedControl((current) => current === "home:attention" ? null : current));
            _$setProp(_el$217, "onMouseUp", () => navigate(attention().destination));
            _$setProp(_el$217, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              navigate(attention().destination);
            });
            _$insertNode(_el$218, _el$219);
            _$insertNode(_el$218, _el$220);
            _$insert(_el$218, () => focusMark("home:attention"), _el$219);
            _$insert(_el$218, () => attention().count, _el$219);
            _$insert(_el$218, () => attention().kind === "applied" ? "applied change" : "recommendation", _el$220);
            _$effect((_p$) => {
              var _v$56 = focusId("home:attention"), _v$57 = props.api.theme.current.warning;
              _v$56 !== _p$.e && (_p$.e = _$setProp(_el$217, "id", _v$56, _p$.e));
              _v$57 !== _p$.t && (_p$.t = _$setProp(_el$217, "borderColor", _v$57, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$217;
          })()
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().usage;
          },
          children: (usage) => (() => {
            var _el$221 = _$createElement("box"), _el$222 = _$createElement("text"), _el$223 = _$createElement("b"), _el$225 = _$createElement("text"), _el$226 = _$createTextNode(`Provider calls: `), _el$227 = _$createTextNode(` / `), _el$228 = _$createElement("text"), _el$229 = _$createTextNode(`Provider calls reset: `), _el$230 = _$createElement("text"), _el$231 = _$createTextNode(`Recommendation synthesis: `), _el$232 = _$createTextNode(` / `), _el$233 = _$createElement("text"), _el$234 = _$createTextNode(`Recommendation synthesis resets: `), _el$235 = _$createElement("text"), _el$236 = _$createTextNode(`Storage: `), _el$237 = _$createTextNode(` / `), _el$238 = _$createTextNode(` bytes`);
            _$insertNode(_el$221, _el$222);
            _$insertNode(_el$221, _el$225);
            _$insertNode(_el$221, _el$228);
            _$insertNode(_el$221, _el$230);
            _$insertNode(_el$221, _el$233);
            _$insertNode(_el$221, _el$235);
            _$setProp(_el$221, "flexDirection", "column");
            _$insertNode(_el$222, _el$223);
            _$insertNode(_el$223, _$createTextNode(`Actual usage`));
            _$insertNode(_el$225, _el$226);
            _$insertNode(_el$225, _el$227);
            _$insert(_el$225, () => usage().provider.used, _el$227);
            _$insert(_el$225, () => usage().provider.limit, null);
            _$insertNode(_el$228, _el$229);
            _$insert(_el$228, (() => {
              var _c$8 = _$memo(() => !!usage().provider.resetAt);
              return () => _c$8() ? new Date(usage().provider.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$230, _el$231);
            _$insertNode(_el$230, _el$232);
            _$insert(_el$230, () => usage().synthesis.used, _el$232);
            _$insert(_el$230, () => usage().synthesis.limit, null);
            _$insertNode(_el$233, _el$234);
            _$insert(_el$233, (() => {
              var _c$9 = _$memo(() => !!usage().synthesis.resetAt);
              return () => _c$9() ? new Date(usage().synthesis.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$235, _el$236);
            _$insertNode(_el$235, _el$237);
            _$insertNode(_el$235, _el$238);
            _$insert(_el$235, () => usage().storage.usedBytes, _el$237);
            _$insert(_el$235, () => usage().storage.limitBytes, _el$238);
            return _el$221;
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
              var _el$239 = _$createElement("text"), _el$240 = _$createTextNode(`[`), _el$241 = _$createTextNode(`] `);
              _$insertNode(_el$239, _el$240);
              _$insertNode(_el$239, _el$241);
              _$setProp(_el$239, "wrapMode", "word");
              _$insert(_el$239, () => entry.marker, _el$241);
              _$insert(_el$239, () => entry.summary, null);
              return _el$239;
            })())), null);
            return _el$51;
          }
        }), null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().emptyState;
          },
          children: (emptyState) => (() => {
            var _el$242 = _$createElement("box"), _el$243 = _$createElement("text"), _el$244 = _$createElement("b"), _el$245 = _$createElement("text");
            _$insertNode(_el$242, _el$243);
            _$insertNode(_el$242, _el$245);
            _$setProp(_el$242, "flexDirection", "column");
            _$insertNode(_el$243, _el$244);
            _$insert(_el$244, () => emptyState().heading);
            _$setProp(_el$245, "wrapMode", "word");
            _$insert(_el$245, () => emptyState().explanation);
            return _el$242;
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
          var _el$246 = _$createElement("box"), _el$247 = _$createElement("text");
          _$insertNode(_el$246, _el$247);
          _$setProp(_el$246, "focusable", true);
          _$setProp(_el$246, "border", true);
          _$setProp(_el$246, "paddingLeft", 1);
          _$setProp(_el$246, "paddingRight", 1);
          _$setProp(_el$246, "on:focused", () => setFocusedControl(`recommendation-filter:${value}`));
          _$setProp(_el$246, "on:blurred", () => setFocusedControl((current) => current === `recommendation-filter:${value}` ? null : current));
          _$setProp(_el$246, "onMouseUp", () => {
            setRecommendationFilter(value);
            const first = buildControlCenterModel(props.snapshot(), {
              recommendationFilter: value
            }).sections.recommendations.queue[0];
            if (first)
              selectRecommendation(first.sourceIndex);
          });
          _$setProp(_el$246, "onKeyDown", (event) => {
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
          _$insert(_el$247, () => focusMark(`recommendation-filter:${value}`), null);
          _$insert(_el$247, label, null);
          _$effect((_p$) => {
            var _v$58 = focusId(`recommendation-filter:${value}`), _v$59 = recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$58 !== _p$.e && (_p$.e = _$setProp(_el$246, "id", _v$58, _p$.e));
            _v$59 !== _p$.t && (_p$.t = _$setProp(_el$246, "borderColor", _v$59, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$246;
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
          var _el$248 = _$createElement("box"), _el$249 = _$createElement("text"), _el$250 = _$createTextNode(` \xB7 `), _el$251 = _$createTextNode(` \xB7 `), _el$252 = _$createElement("text"), _el$253 = _$createElement("text"), _el$254 = _$createTextNode(`Risk: `), _el$255 = _$createTextNode(` \xB7 Evidence: `);
          _$insertNode(_el$248, _el$249);
          _$insertNode(_el$248, _el$252);
          _$insertNode(_el$248, _el$253);
          _$use((value) => recommendationNodes.set(item.sourceIndex, value), _el$248);
          _$setProp(_el$248, "focusable", true);
          _$setProp(_el$248, "border", true);
          _$setProp(_el$248, "paddingLeft", 1);
          _$setProp(_el$248, "paddingRight", 1);
          _$setProp(_el$248, "flexDirection", "column");
          _$setProp(_el$248, "on:focused", () => {
            setFocusedControl(`recommendation-row:${item.sourceIndex}`);
            selectRecommendation(item.sourceIndex);
          });
          _$setProp(_el$248, "on:blurred", () => setFocusedControl((current) => current === `recommendation-row:${item.sourceIndex}` ? null : current));
          _$setProp(_el$248, "onMouseUp", () => {
            selectRecommendation(item.sourceIndex);
            recommendationNodes.get(item.sourceIndex)?.focus();
          });
          _$setProp(_el$248, "onKeyDown", (event) => {
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
          _$insertNode(_el$249, _el$250);
          _$insertNode(_el$249, _el$251);
          _$setProp(_el$249, "wrapMode", "word");
          _$insert(_el$249, () => focusMark(`recommendation-row:${item.sourceIndex}`), _el$250);
          _$insert(_el$249, (() => {
            var _c$0 = _$memo(() => item.attention === "critical");
            return () => _c$0() ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "";
          })(), _el$250);
          _$insert(_el$249, () => item.target, _el$250);
          _$insert(_el$249, () => item.state.replaceAll("-", " "), _el$251);
          _$insert(_el$249, () => relativeTime(item.updatedAt), null);
          _$setProp(_el$252, "wrapMode", "word");
          _$insert(_el$252, () => item.rationale);
          _$insertNode(_el$253, _el$254);
          _$insertNode(_el$253, _el$255);
          _$insert(_el$253, () => item.risk ?? "Loading", _el$255);
          _$insert(_el$253, () => item.evidenceCount ?? "Loading", null);
          _$effect((_p$) => {
            var _v$60 = focusId(`recommendation-row:${item.sourceIndex}`), _v$61 = recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$62 = props.api.theme.current.textMuted, _v$63 = props.api.theme.current.textMuted;
            _v$60 !== _p$.e && (_p$.e = _$setProp(_el$248, "id", _v$60, _p$.e));
            _v$61 !== _p$.t && (_p$.t = _$setProp(_el$248, "borderColor", _v$61, _p$.t));
            _v$62 !== _p$.a && (_p$.a = _$setProp(_el$252, "fg", _v$62, _p$.a));
            _v$63 !== _p$.o && (_p$.o = _$setProp(_el$253, "fg", _v$63, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$248;
        })())), null);
        _$insert(_el$55, _$createComponent(Show, {
          get when() {
            return recommendations().selected;
          },
          children: (selected) => (() => {
            var _el$256 = _$createElement("box"), _el$257 = _$createElement("text"), _el$258 = _$createElement("b"), _el$266 = _$createElement("box"), _el$267 = _$createElement("box"), _el$268 = _$createElement("text"), _el$269 = _$createTextNode(`Open in Activity`);
            _$insertNode(_el$256, _el$257);
            _$insertNode(_el$256, _el$266);
            _$setProp(_el$256, "border", true);
            _$setProp(_el$256, "paddingLeft", 1);
            _$setProp(_el$256, "paddingRight", 1);
            _$setProp(_el$256, "flexDirection", "column");
            _$setProp(_el$256, "gap", 1);
            _$insertNode(_el$257, _el$258);
            _$insert(_el$258, () => selected().target);
            _$insert(_el$256, _$createComponent(Show, {
              get when() {
                return selected().loading;
              },
              get children() {
                var _el$259 = _$createElement("text");
                _$insertNode(_el$259, _$createTextNode(`Loading authoritative recommendation detail\u2026`));
                return _el$259;
              }
            }), _el$266);
            _$insert(_el$256, _$createComponent(Show, {
              get when() {
                return selected().summary;
              },
              children: (summary) => [(() => {
                var _el$272 = _$createElement("box"), _el$273 = _$createElement("text"), _el$274 = _$createElement("b"), _el$276 = _$createElement("text");
                _$insertNode(_el$272, _el$273);
                _$insertNode(_el$272, _el$276);
                _$setProp(_el$272, "flexDirection", "column");
                _$insertNode(_el$273, _el$274);
                _$insertNode(_el$274, _$createTextNode(`Why this was suggested`));
                _$setProp(_el$276, "wrapMode", "word");
                _$insert(_el$276, () => summary().rationale);
                _$insert(_el$272, _$createComponent(Show, {
                  get when() {
                    return summary().support;
                  },
                  children: (support) => [(() => {
                    var _el$327 = _$createElement("text"), _el$328 = _$createTextNode(`Target: `), _el$329 = _$createTextNode(` \xB7 `);
                    _$insertNode(_el$327, _el$328);
                    _$insertNode(_el$327, _el$329);
                    _$setProp(_el$327, "wrapMode", "word");
                    _$insert(_el$327, () => summary().targetKind === "new-global-skill" ? "New global skill" : "Existing global skill", _el$329);
                    _$insert(_el$327, () => summary().target, null);
                    return _el$327;
                  })(), (() => {
                    var _el$330 = _$createElement("text"), _el$331 = _$createTextNode(`Support: `), _el$332 = _$createTextNode(` \xB7 `), _el$333 = _$createTextNode(` independent domains \xB7 `), _el$334 = _$createTextNode(` incidents \xB7 `), _el$335 = _$createTextNode(` occurrences`);
                    _$insertNode(_el$330, _el$331);
                    _$insertNode(_el$330, _el$332);
                    _$insertNode(_el$330, _el$333);
                    _$insertNode(_el$330, _el$334);
                    _$insertNode(_el$330, _el$335);
                    _$setProp(_el$330, "wrapMode", "word");
                    _$insert(_el$330, () => support().tier.replaceAll("-", " "), _el$332);
                    _$insert(_el$330, () => support().independentDomainCount, _el$333);
                    _$insert(_el$330, () => support().independentIncidentCount, _el$334);
                    _$insert(_el$330, () => support().occurrenceCount, _el$335);
                    return _el$330;
                  })(), (() => {
                    var _el$336 = _$createElement("text"), _el$337 = _$createTextNode(`Observed: `), _el$338 = _$createTextNode(` through `);
                    _$insertNode(_el$336, _el$337);
                    _$insertNode(_el$336, _el$338);
                    _$setProp(_el$336, "wrapMode", "word");
                    _$insert(_el$336, () => support().firstSeenDay, _el$338);
                    _$insert(_el$336, () => support().lastSeenDay, null);
                    return _el$336;
                  })(), (() => {
                    var _el$339 = _$createElement("text"), _el$340 = _$createTextNode(`Current project contributed: `);
                    _$insertNode(_el$339, _el$340);
                    _$setProp(_el$339, "wrapMode", "word");
                    _$insert(_el$339, (() => {
                      var _c$10 = _$memo(() => summary().currentProjectContributed === null);
                      return () => _c$10() ? "Unavailable" : summary().currentProjectContributed ? "Yes" : "No";
                    })(), null);
                    return _el$339;
                  })()]
                }), null);
                return _el$272;
              })(), (() => {
                var _el$277 = _$createElement("box"), _el$278 = _$createElement("text"), _el$279 = _$createElement("b");
                _$insertNode(_el$277, _el$278);
                _$setProp(_el$277, "flexDirection", "column");
                _$insertNode(_el$278, _el$279);
                _$insertNode(_el$279, _$createTextNode(`Proposed change`));
                _$insert(_el$277, () => reactiveChild(() => selected().diff?.lines.map((line) => (() => {
                  var _el$341 = _$createElement("text");
                  _$setProp(_el$341, "wrapMode", "word");
                  _$insert(_el$341, line);
                  return _el$341;
                })()) ?? []), null);
                _$insert(_el$277, _$createComponent(Show, {
                  get when() {
                    return selected().diff?.overflow?.truncated;
                  },
                  get children() {
                    var _el$281 = _$createElement("text");
                    _$insertNode(_el$281, _$createTextNode(`The proposed change was truncated by the bounded projection.`));
                    _$effect((_$p) => _$setProp(_el$281, "fg", props.api.theme.current.warning, _$p));
                    return _el$281;
                  }
                }), null);
                return _el$277;
              })(), (() => {
                var _el$283 = _$createElement("box"), _el$284 = _$createElement("text"), _el$285 = _$createElement("b");
                _$insertNode(_el$283, _el$284);
                _$setProp(_el$283, "flexDirection", "column");
                _$insertNode(_el$284, _el$285);
                _$insertNode(_el$285, _$createTextNode(`Evidence`));
                _$insert(_el$283, () => reactiveChild(() => selected().evidence.map((entry) => (() => {
                  var _el$342 = _$createElement("text"), _el$343 = _$createTextNode(`: `);
                  _$insertNode(_el$342, _el$343);
                  _$setProp(_el$342, "wrapMode", "word");
                  _$insert(_el$342, () => entry.kind, _el$343);
                  _$insert(_el$342, () => entry.summary, null);
                  _$insert(_el$342, () => entry.redacted ? " [redacted]" : "", null);
                  return _el$342;
                })())), null);
                _$insert(_el$283, _$createComponent(Show, {
                  get when() {
                    return !selected().evidence.length;
                  },
                  get children() {
                    var _el$287 = _$createElement("text");
                    _$insertNode(_el$287, _$createTextNode(`No bounded evidence detail is loaded.`));
                    return _el$287;
                  }
                }), null);
                return _el$283;
              })(), (() => {
                var _el$289 = _$createElement("box"), _el$290 = _$createElement("text"), _el$291 = _$createElement("b"), _el$293 = _$createElement("text"), _el$294 = _$createTextNode(`Critic: `), _el$298 = _$createElement("text"), _el$299 = _$createTextNode(`Deterministic checks: `);
                _$insertNode(_el$289, _el$290);
                _$insertNode(_el$289, _el$293);
                _$insertNode(_el$289, _el$298);
                _$setProp(_el$289, "flexDirection", "column");
                _$insertNode(_el$290, _el$291);
                _$insertNode(_el$291, _$createTextNode(`Safety checks`));
                _$insertNode(_el$293, _el$294);
                _$insert(_el$293, () => summary().criticPassed ? "Passed" : "Not passed", null);
                _$insert(_el$289, _$createComponent(Show, {
                  get when() {
                    return summary().criticScoreBasisPoints !== undefined;
                  },
                  get children() {
                    var _el$295 = _$createElement("text"), _el$296 = _$createTextNode(`Critic score: `), _el$297 = _$createTextNode(`%`);
                    _$insertNode(_el$295, _el$296);
                    _$insertNode(_el$295, _el$297);
                    _$insert(_el$295, () => (summary().criticScoreBasisPoints / 100).toFixed(2), _el$297);
                    return _el$295;
                  }
                }), _el$298);
                _$insertNode(_el$298, _el$299);
                _$insert(_el$298, () => summary().validDeterministic ? "Passed" : "Not passed", null);
                _$insert(_el$289, _$createComponent(Show, {
                  get when() {
                    return summary().injectionFlagged !== undefined;
                  },
                  get children() {
                    var _el$300 = _$createElement("text"), _el$301 = _$createTextNode(`Injection scan: `);
                    _$insertNode(_el$300, _el$301);
                    _$insert(_el$300, () => summary().injectionFlagged ? "Flagged" : "Clear", null);
                    return _el$300;
                  }
                }), null);
                _$insert(_el$289, _$createComponent(Show, {
                  get when() {
                    return summary().eligibility;
                  },
                  children: (eligibility) => reactiveChild(() => eligibility().checks.map((check) => (() => {
                    var _el$344 = _$createElement("text"), _el$345 = _$createTextNode(`[`), _el$346 = _$createTextNode(`] `), _el$347 = _$createTextNode(`: `), _el$348 = _$createTextNode(` / `);
                    _$insertNode(_el$344, _el$345);
                    _$insertNode(_el$344, _el$346);
                    _$insertNode(_el$344, _el$347);
                    _$insertNode(_el$344, _el$348);
                    _$setProp(_el$344, "wrapMode", "word");
                    _$insert(_el$344, () => check.met ? "Passed" : "Blocked", _el$346);
                    _$insert(_el$344, () => check.name, _el$347);
                    _$insert(_el$344, () => check.actual, _el$348);
                    _$insert(_el$344, () => check.required, null);
                    return _el$344;
                  })()))
                }), null);
                return _el$289;
              })(), (() => {
                var _el$302 = _$createElement("box"), _el$303 = _$createElement("text"), _el$304 = _$createElement("b"), _el$306 = _$createElement("text"), _el$307 = _$createTextNode(`: `);
                _$insertNode(_el$302, _el$303);
                _$insertNode(_el$302, _el$306);
                _$setProp(_el$302, "flexDirection", "column");
                _$insertNode(_el$303, _el$304);
                _$insertNode(_el$304, _$createTextNode(`Generality`));
                _$insertNode(_el$306, _el$307);
                _$setProp(_el$306, "wrapMode", "word");
                _$insert(_el$306, () => summary().generality.status, _el$307);
                _$insert(_el$306, () => summary().generality.explanation, null);
                return _el$302;
              })(), (() => {
                var _el$308 = _$createElement("box"), _el$309 = _$createElement("text"), _el$310 = _$createElement("b");
                _$insertNode(_el$308, _el$309);
                _$setProp(_el$308, "flexDirection", "column");
                _$insertNode(_el$309, _el$310);
                _$insertNode(_el$310, _$createTextNode(`Token impact`));
                _$insert(_el$308, _$createComponent(Show, {
                  get when() {
                    return summary().tokenImpact.available;
                  },
                  get fallback() {
                    return (() => {
                      var _el$349 = _$createElement("text"), _el$350 = _$createTextNode(`Unavailable: `);
                      _$insertNode(_el$349, _el$350);
                      _$setProp(_el$349, "wrapMode", "word");
                      _$insert(_el$349, () => summary().tokenImpact.explanation, null);
                      return _el$349;
                    })();
                  },
                  get children() {
                    var _el$312 = _$createElement("text"), _el$313 = _$createTextNode(` estimated / `), _el$314 = _$createTextNode(` budgeted tokens`);
                    _$insertNode(_el$312, _el$313);
                    _$insertNode(_el$312, _el$314);
                    _$insert(_el$312, () => summary().tokenImpact.estimatedTokens, _el$313);
                    _$insert(_el$312, () => summary().tokenImpact.budgetTokens, _el$314);
                    return _el$312;
                  }
                }), null);
                return _el$308;
              })(), (() => {
                var _el$315 = _$createElement("box"), _el$316 = _$createElement("text"), _el$317 = _$createElement("b"), _el$319 = _$createElement("text");
                _$insertNode(_el$315, _el$316);
                _$insertNode(_el$315, _el$319);
                _$setProp(_el$315, "flexDirection", "column");
                _$insertNode(_el$316, _el$317);
                _$insertNode(_el$317, _$createTextNode(`Rollback`));
                _$insert(_el$319, (() => {
                  var _c$1 = _$memo(() => !!summary().rollback.eligible);
                  return () => _c$1() ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`;
                })());
                return _el$315;
              })(), (() => {
                var _el$320 = _$createElement("box"), _el$321 = _$createElement("text"), _el$322 = _$createTextNode(`Technical details `);
                _$insertNode(_el$320, _el$321);
                _$setProp(_el$320, "focusable", true);
                _$setProp(_el$320, "border", true);
                _$setProp(_el$320, "paddingLeft", 1);
                _$setProp(_el$320, "paddingRight", 1);
                _$setProp(_el$320, "on:focused", () => setFocusedControl("recommendation:technical"));
                _$setProp(_el$320, "on:blurred", () => setFocusedControl((current) => current === "recommendation:technical" ? null : current));
                _$setProp(_el$320, "onMouseUp", () => setTechnicalExpanded((value) => !value));
                _$setProp(_el$320, "onKeyDown", (event) => {
                  if (!isActivationKey(event))
                    return;
                  event.preventDefault();
                  setTechnicalExpanded((value) => !value);
                });
                _$insertNode(_el$321, _el$322);
                _$insert(_el$321, () => focusMark("recommendation:technical"), _el$322);
                _$insert(_el$321, () => technicalExpanded() ? "\u25B2" : "\u25BC", null);
                _$effect((_$p) => _$setProp(_el$320, "borderColor", technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                return _el$320;
              })(), _$createComponent(Show, {
                get when() {
                  return technicalExpanded();
                },
                get children() {
                  return [(() => {
                    var _el$323 = _$createElement("text"), _el$324 = _$createTextNode(`State: `);
                    _$insertNode(_el$323, _el$324);
                    _$insert(_el$323, () => summary().state, null);
                    return _el$323;
                  })(), _$createComponent(Show, {
                    get when() {
                      return summary().operation;
                    },
                    get children() {
                      var _el$325 = _$createElement("text"), _el$326 = _$createTextNode(`Operation: `);
                      _$insertNode(_el$325, _el$326);
                      _$insert(_el$325, () => summary().operation.status, null);
                      return _el$325;
                    }
                  }), _$memo(() => reactiveChild(() => selected().audit.map((entry) => (() => {
                    var _el$351 = _$createElement("text"), _el$352 = _$createTextNode(`: `);
                    _$insertNode(_el$351, _el$352);
                    _$setProp(_el$351, "wrapMode", "word");
                    _$insert(_el$351, () => entry.kind, _el$352);
                    _$insert(_el$351, () => entry.summary, null);
                    return _el$351;
                  })())))];
                }
              })]
            }), _el$266);
            _$insert(_el$256, _$createComponent(Show, {
              get when() {
                return selected().actions.some((action) => ["reject-proposal", "reject"].includes(action.action) && action.feedbackSupported);
              },
              get children() {
                var _el$261 = _$createElement("box"), _el$262 = _$createElement("text"), _el$264 = _$createElement("box");
                _$insertNode(_el$261, _el$262);
                _$insertNode(_el$261, _el$264);
                _$setProp(_el$261, "flexDirection", "column");
                _$insertNode(_el$262, _$createTextNode(`Optional rejection feedback (audit-only)`));
                _$setProp(_el$264, "flexDirection", "row");
                _$setProp(_el$264, "gap", 1);
                _$setProp(_el$264, "flexWrap", "wrap");
                _$insert(_el$264, () => reactiveChild(() => recommendations().rejectionFeedbackOptions.map((option) => (() => {
                  var _el$353 = _$createElement("box"), _el$354 = _$createElement("text");
                  _$insertNode(_el$353, _el$354);
                  _$setProp(_el$353, "focusable", true);
                  _$setProp(_el$353, "border", true);
                  _$setProp(_el$353, "paddingLeft", 1);
                  _$setProp(_el$353, "paddingRight", 1);
                  _$setProp(_el$353, "on:focused", () => setFocusedControl(`rejection:${option.value}`));
                  _$setProp(_el$353, "on:blurred", () => setFocusedControl((current) => current === `rejection:${option.value}` ? null : current));
                  _$setProp(_el$353, "onMouseUp", () => setRejectionReason(rejectionReason() === option.value ? null : option.value));
                  _$setProp(_el$353, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setRejectionReason(rejectionReason() === option.value ? null : option.value);
                  });
                  _$insert(_el$354, () => focusMark(`rejection:${option.value}`), null);
                  _$insert(_el$354, () => option.label, null);
                  _$effect((_$p) => _$setProp(_el$353, "borderColor", rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                  return _el$353;
                })())));
                _$insert(_el$261, _$createComponent(Show, {
                  get when() {
                    return rejectionReason() === "other";
                  },
                  get children() {
                    var _el$265 = _$createElement("input");
                    _$setProp(_el$265, "placeholder", "Optional bounded reason (512 characters)");
                    _$setProp(_el$265, "onInput", (value) => setRejectionText(value.slice(0, 512)));
                    _$effect((_$p) => _$setProp(_el$265, "value", rejectionText(), _$p));
                    return _el$265;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$262, "fg", props.api.theme.current.textMuted, _$p));
                return _el$261;
              }
            }), _el$266);
            _$insertNode(_el$266, _el$267);
            _$setProp(_el$266, "flexDirection", "row");
            _$setProp(_el$266, "gap", 1);
            _$setProp(_el$266, "flexWrap", "wrap");
            _$insert(_el$266, () => reactiveChild(() => selected().actions.flatMap((action) => {
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
                  var _el$355 = _$createElement("box"), _el$356 = _$createElement("text");
                  _$insertNode(_el$355, _el$356);
                  _$setProp(_el$355, "border", true);
                  _$setProp(_el$355, "paddingLeft", 1);
                  _$setProp(_el$355, "paddingRight", 1);
                  _$setProp(_el$355, "on:focused", () => setFocusedControl(`recommendation-action:${key}`));
                  _$setProp(_el$355, "on:blurred", () => setFocusedControl((current) => current === `recommendation-action:${key}` ? null : current));
                  _$setProp(_el$355, "onMouseUp", () => {
                    if (!action.pending)
                      activateRecommendation(action.action, choice.delay);
                  });
                  _$setProp(_el$355, "onKeyDown", (event) => {
                    if (!isActivationKey(event) || action.pending)
                      return;
                    event.preventDefault();
                    activateRecommendation(action.action, choice.delay);
                  });
                  _$insert(_el$356, () => focusMark(`recommendation-action:${key}`), null);
                  _$insert(_el$356, (() => {
                    var _c$11 = _$memo(() => !!action.pending);
                    return () => _c$11() ? `${choice.label} \xB7 Pending` : _$memo(() => confirmation() === key)() ? `Confirm ${choice.label}` : choice.label;
                  })(), null);
                  _$effect((_p$) => {
                    var _v$66 = !action.pending, _v$67 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$68 = action.pending ? props.api.theme.current.textMuted : props.api.theme.current.text;
                    _v$66 !== _p$.e && (_p$.e = _$setProp(_el$355, "focusable", _v$66, _p$.e));
                    _v$67 !== _p$.t && (_p$.t = _$setProp(_el$355, "borderColor", _v$67, _p$.t));
                    _v$68 !== _p$.a && (_p$.a = _$setProp(_el$356, "fg", _v$68, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$355;
                })();
              });
            })), _el$267);
            _$insertNode(_el$267, _el$268);
            _$setProp(_el$267, "focusable", true);
            _$setProp(_el$267, "border", true);
            _$setProp(_el$267, "paddingLeft", 1);
            _$setProp(_el$267, "paddingRight", 1);
            _$setProp(_el$267, "on:focused", () => setFocusedControl("recommendation:open-activity"));
            _$setProp(_el$267, "on:blurred", () => setFocusedControl((current) => current === "recommendation:open-activity" ? null : current));
            _$setProp(_el$267, "onMouseUp", () => void activateRecommendation("open-activity"));
            _$setProp(_el$267, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              activateRecommendation("open-activity");
            });
            _$insertNode(_el$268, _el$269);
            _$insert(_el$268, () => focusMark("recommendation:open-activity"), _el$269);
            _$insert(_el$256, _$createComponent(Show, {
              get when() {
                return pendingRecommendation();
              },
              get children() {
                var _el$270 = _$createElement("text");
                _$insertNode(_el$270, _$createTextNode(`Request pending server validation\u2026`));
                _$effect((_$p) => _$setProp(_el$270, "fg", props.api.theme.current.info, _$p));
                return _el$270;
              }
            }), null);
            _$effect((_p$) => {
              var _v$64 = props.api.theme.current.borderActive, _v$65 = props.api.theme.current.borderSubtle;
              _v$64 !== _p$.e && (_p$.e = _$setProp(_el$256, "borderColor", _v$64, _p$.e));
              _v$65 !== _p$.t && (_p$.t = _$setProp(_el$267, "borderColor", _v$65, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$256;
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
          var _el$357 = _$createElement("box"), _el$358 = _$createElement("text");
          _$insertNode(_el$357, _el$358);
          _$setProp(_el$357, "focusable", true);
          _$setProp(_el$357, "border", true);
          _$setProp(_el$357, "paddingLeft", 1);
          _$setProp(_el$357, "paddingRight", 1);
          _$setProp(_el$357, "on:focused", () => setFocusedControl(`activity-filter:${value}`));
          _$setProp(_el$357, "on:blurred", () => setFocusedControl((current) => current === `activity-filter:${value}` ? null : current));
          _$setProp(_el$357, "onMouseUp", () => {
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$setProp(_el$357, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$insert(_el$358, () => focusMark(`activity-filter:${value}`), null);
          _$insert(_el$358, label, null);
          _$effect((_p$) => {
            var _v$69 = focusId(`activity-filter:${value}`), _v$70 = activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$69 !== _p$.e && (_p$.e = _$setProp(_el$357, "id", _v$69, _p$.e));
            _v$70 !== _p$.t && (_p$.t = _$setProp(_el$357, "borderColor", _v$70, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$357;
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
          var _el$359 = _$createElement("box"), _el$360 = _$createElement("text"), _el$361 = _$createTextNode(`[`), _el$362 = _$createTextNode(`] [`), _el$363 = _$createTextNode(`] `), _el$364 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$359, _el$360);
          _$use((value) => activityNodes.set(index, value), _el$359);
          _$setProp(_el$359, "focusable", true);
          _$setProp(_el$359, "border", true);
          _$setProp(_el$359, "paddingLeft", 1);
          _$setProp(_el$359, "paddingRight", 1);
          _$setProp(_el$359, "flexDirection", "column");
          _$setProp(_el$359, "on:focused", () => {
            setFocusedControl(`activity-row:${index}`);
            setActivityIndex(index);
          });
          _$setProp(_el$359, "on:blurred", () => setFocusedControl((current) => current === `activity-row:${index}` ? null : current));
          _$setProp(_el$359, "onMouseUp", () => {
            setActivityIndex(index);
            activityNodes.get(index)?.focus();
            setActivityExpanded(activityExpanded() === index ? null : index);
          });
          _$setProp(_el$359, "onKeyDown", (event) => {
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
          _$insertNode(_el$360, _el$361);
          _$insertNode(_el$360, _el$362);
          _$insertNode(_el$360, _el$363);
          _$insertNode(_el$360, _el$364);
          _$setProp(_el$360, "wrapMode", "word");
          _$insert(_el$360, () => focusMark(`activity-row:${index}`), _el$361);
          _$insert(_el$360, () => entry.marker, _el$362);
          _$insert(_el$360, () => entry.scope, _el$363);
          _$insert(_el$360, () => entry.summary, _el$364);
          _$insert(_el$360, () => relativeTime(entry.occurredAt), null);
          _$insert(_el$359, _$createComponent(Show, {
            get when() {
              return entry.target;
            },
            get children() {
              var _el$365 = _$createElement("text"), _el$366 = _$createTextNode(`Skill: `);
              _$insertNode(_el$365, _el$366);
              _$insert(_el$365, () => entry.target, null);
              _$effect((_$p) => _$setProp(_el$365, "fg", props.api.theme.current.textMuted, _$p));
              return _el$365;
            }
          }), null);
          _$insert(_el$359, _$createComponent(Show, {
            get when() {
              return activityExpanded() === index;
            },
            get children() {
              return [(() => {
                var _el$367 = _$createElement("text"), _el$368 = _$createTextNode(`Category: `);
                _$insertNode(_el$367, _el$368);
                _$insert(_el$367, () => entry.technical.category, null);
                _$effect((_$p) => _$setProp(_el$367, "fg", props.api.theme.current.textMuted, _$p));
                return _el$367;
              })(), (() => {
                var _el$369 = _$createElement("text"), _el$370 = _$createTextNode(`Outcome: `);
                _$insertNode(_el$369, _el$370);
                _$insert(_el$369, () => entry.technical.outcome.replaceAll("-", " "), null);
                _$effect((_$p) => _$setProp(_el$369, "fg", props.api.theme.current.textMuted, _$p));
                return _el$369;
              })(), _$createComponent(Show, {
                get when() {
                  return entry.technical.reason;
                },
                children: (reason) => (() => {
                  var _el$374 = _$createElement("text"), _el$375 = _$createTextNode(`Reason: `);
                  _$insertNode(_el$374, _el$375);
                  _$insert(_el$374, () => reason().replaceAll("-", " "), null);
                  _$effect((_$p) => _$setProp(_el$374, "fg", props.api.theme.current.textMuted, _$p));
                  return _el$374;
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
                  var _el$371 = _$createElement("box"), _el$372 = _$createElement("text"), _el$373 = _$createTextNode(`Open recommendation`);
                  _$insertNode(_el$371, _el$372);
                  _$setProp(_el$371, "focusable", true);
                  _$setProp(_el$371, "border", true);
                  _$setProp(_el$371, "paddingLeft", 1);
                  _$setProp(_el$371, "paddingRight", 1);
                  _$setProp(_el$371, "on:focused", () => setFocusedControl(`activity-open:${index}`));
                  _$setProp(_el$371, "on:blurred", () => setFocusedControl((current) => current === `activity-open:${index}` ? null : current));
                  _$setProp(_el$371, "onMouseUp", () => openActivityDestination(entry));
                  _$setProp(_el$371, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    openActivityDestination(entry);
                  });
                  _$insertNode(_el$372, _el$373);
                  _$insert(_el$372, () => focusMark(`activity-open:${index}`), _el$373);
                  _$effect((_$p) => _$setProp(_el$371, "borderColor", props.api.theme.current.borderSubtle, _$p));
                  return _el$371;
                }
              })];
            }
          }), null);
          _$effect((_p$) => {
            var _v$71 = focusId(`activity-row:${index}`), _v$72 = activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$71 !== _p$.e && (_p$.e = _$setProp(_el$359, "id", _v$71, _p$.e));
            _v$72 !== _p$.t && (_p$.t = _$setProp(_el$359, "borderColor", _v$72, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$359;
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
                var _el$376 = _$createElement("text"), _el$377 = _$createTextNode(`Scheduler: `);
                _$insertNode(_el$376, _el$377);
                _$setProp(_el$376, "wrapMode", "word");
                _$insert(_el$376, () => automation().state.replaceAll("-", " "), null);
                return _el$376;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.backoffUntil;
              },
              children: (backoffUntil) => (() => {
                var _el$378 = _$createElement("text"), _el$379 = _$createTextNode(`Backoff ends: `);
                _$insertNode(_el$378, _el$379);
                _$setProp(_el$378, "wrapMode", "word");
                _$insert(_el$378, () => new Date(backoffUntil()).toISOString(), null);
                return _el$378;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.nextEligibleAt;
              },
              children: (nextEligibleAt) => (() => {
                var _el$380 = _$createElement("text"), _el$381 = _$createTextNode(`Next eligible: `);
                _$insertNode(_el$380, _el$381);
                _$setProp(_el$380, "wrapMode", "word");
                _$insert(_el$380, () => new Date(nextEligibleAt()).toISOString(), null);
                return _el$380;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.usage;
              },
              children: (usage) => [(() => {
                var _el$382 = _$createElement("text"), _el$383 = _$createTextNode(`Provider calls used/remaining: `), _el$384 = _$createTextNode(` / `);
                _$insertNode(_el$382, _el$383);
                _$insertNode(_el$382, _el$384);
                _$setProp(_el$382, "wrapMode", "word");
                _$insert(_el$382, () => usage().provider.used, _el$384);
                _$insert(_el$382, () => usage().provider.remaining, null);
                return _el$382;
              })(), (() => {
                var _el$385 = _$createElement("text"), _el$386 = _$createTextNode(`Recommendation synthesis used/remaining: `), _el$387 = _$createTextNode(` / `);
                _$insertNode(_el$385, _el$386);
                _$insertNode(_el$385, _el$387);
                _$setProp(_el$385, "wrapMode", "word");
                _$insert(_el$385, () => usage().synthesis.used, _el$387);
                _$insert(_el$385, () => usage().synthesis.remaining, null);
                return _el$385;
              })(), (() => {
                var _el$388 = _$createElement("text"), _el$389 = _$createTextNode(`Storage used/quota: `), _el$390 = _$createTextNode(` / `), _el$391 = _$createTextNode(` bytes`);
                _$insertNode(_el$388, _el$389);
                _$insertNode(_el$388, _el$390);
                _$insertNode(_el$388, _el$391);
                _$setProp(_el$388, "wrapMode", "word");
                _$insert(_el$388, () => usage().storage.usedBytes, _el$390);
                _$insert(_el$388, () => usage().storage.limitBytes, _el$391);
                return _el$388;
              })(), _$createComponent(Show, {
                get when() {
                  return activity().diagnostics.budgetResetAt;
                },
                children: (budgetResetAt) => [(() => {
                  var _el$392 = _$createElement("text"), _el$393 = _$createTextNode(`Provider calls reset: `);
                  _$insertNode(_el$392, _el$393);
                  _$setProp(_el$392, "wrapMode", "word");
                  _$insert(_el$392, () => new Date(budgetResetAt().provider).toISOString(), null);
                  return _el$392;
                })(), (() => {
                  var _el$394 = _$createElement("text"), _el$395 = _$createTextNode(`Recommendation synthesis resets: `);
                  _$insertNode(_el$394, _el$395);
                  _$setProp(_el$394, "wrapMode", "word");
                  _$insert(_el$394, () => new Date(budgetResetAt().synthesis).toISOString(), null);
                  return _el$394;
                })()]
              })]
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.lastError;
              },
              children: (lastError) => (() => {
                var _el$396 = _$createElement("text"), _el$397 = _$createTextNode(`Last bounded error: `);
                _$insertNode(_el$396, _el$397);
                _$setProp(_el$396, "wrapMode", "word");
                _$insert(_el$396, () => lastError().summary, null);
                return _el$396;
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
            var _el$398 = _$createElement("box"), _el$399 = _$createElement("text"), _el$400 = _$createTextNode(`Opened at `), _el$401 = _$createTextNode(` settings.`);
            _$insertNode(_el$398, _el$399);
            _$setProp(_el$398, "focusable", true);
            _$setProp(_el$398, "border", true);
            _$setProp(_el$398, "paddingLeft", 1);
            _$setProp(_el$398, "paddingRight", 1);
            _$setProp(_el$398, "on:focused", () => setFocusedControl(`anchor:${anchor()}`));
            _$setProp(_el$398, "on:blurred", () => setFocusedControl((current) => current === `anchor:${anchor()}` ? null : current));
            _$insertNode(_el$399, _el$400);
            _$insertNode(_el$399, _el$401);
            _$setProp(_el$399, "wrapMode", "word");
            _$insert(_el$399, () => focusMark(`anchor:${anchor()}`), _el$400);
            _$insert(_el$399, () => anchor().replaceAll("-", " "), _el$401);
            _$effect((_p$) => {
              var _v$73 = focusId(`anchor:${anchor()}`), _v$74 = focusedControl() === `anchor:${anchor()}` ? props.api.theme.current.borderActive : props.api.theme.current.info, _v$75 = props.api.theme.current.info;
              _v$73 !== _p$.e && (_p$.e = _$setProp(_el$398, "id", _v$73, _p$.e));
              _v$74 !== _p$.t && (_p$.t = _$setProp(_el$398, "borderColor", _v$74, _p$.t));
              _v$75 !== _p$.a && (_p$.a = _$setProp(_el$399, "fg", _v$75, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$398;
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
            var _el$402 = _$createElement("text"), _el$403 = _$createTextNode(`Global protocol: `), _el$404 = _$createTextNode(` \xB7 `);
            _$insertNode(_el$402, _el$403);
            _$insertNode(_el$402, _el$404);
            _$setProp(_el$402, "wrapMode", "word");
            _$insert(_el$402, () => globalProtocol().label, _el$404);
            _$insert(_el$402, () => globalProtocol().authoritative ? "authoritative" : "limited / read-only", null);
            _$effect((_$p) => _$setProp(_el$402, "fg", globalProtocol().authoritative ? props.api.theme.current.textMuted : props.api.theme.current.warning, _$p));
            return _el$402;
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
          var _el$405 = _$createElement("box"), _el$406 = _$createElement("text"), _el$407 = _$createElement("b"), _el$408 = _$createTextNode(`: `), _el$409 = _$createTextNode(` \xB7 `), _el$410 = _$createElement("text"), _el$411 = _$createElement("text");
          _$insertNode(_el$405, _el$406);
          _$insertNode(_el$405, _el$410);
          _$insertNode(_el$405, _el$411);
          _$setProp(_el$405, "border", true);
          _$setProp(_el$405, "paddingLeft", 1);
          _$setProp(_el$405, "paddingRight", 1);
          _$setProp(_el$405, "flexDirection", "column");
          _$insertNode(_el$406, _el$407);
          _$insertNode(_el$406, _el$408);
          _$insertNode(_el$406, _el$409);
          _$insert(_el$407, () => entry.label);
          _$insert(_el$406, () => entry.enabled ? "Allowed" : "Not allowed", _el$409);
          _$insert(_el$406, () => entry.scope, null);
          _$setProp(_el$410, "wrapMode", "word");
          _$insert(_el$410, () => entry.description);
          _$setProp(_el$411, "wrapMode", "word");
          _$insert(_el$411, () => entry.dependency);
          _$insert(_el$405, _$createComponent(Show, {
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
          _$insert(_el$405, () => consentDisclosure(entry.key), null);
          _$insert(_el$405, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!entry.enabled)() && !entry.canEnable;
            },
            get children() {
              var _el$412 = _$createElement("text");
              _$insertNode(_el$412, _$createTextNode(`Resolve the dependency above before enabling this setting.`));
              _$setProp(_el$412, "wrapMode", "word");
              _$effect((_$p) => _$setProp(_el$412, "fg", props.api.theme.current.warning, _$p));
              return _el$412;
            }
          }), null);
          _$effect((_p$) => {
            var _v$76 = props.api.theme.current.borderSubtle, _v$77 = props.api.theme.current.textMuted;
            _v$76 !== _p$.e && (_p$.e = _$setProp(_el$405, "borderColor", _v$76, _p$.e));
            _v$77 !== _p$.t && (_p$.t = _$setProp(_el$411, "fg", _v$77, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$405;
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
          var _el$414 = _$createElement("box"), _el$415 = _$createElement("text"), _el$416 = _$createElement("text"), _el$417 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$414, _el$415);
          _$insertNode(_el$414, _el$416);
          _$setProp(_el$414, "border", true);
          _$setProp(_el$414, "paddingLeft", 1);
          _$setProp(_el$414, "paddingRight", 1);
          _$setProp(_el$414, "flexDirection", "column");
          _$setProp(_el$415, "wrapMode", "word");
          _$insert(_el$415, () => root.canonicalPath);
          _$insertNode(_el$416, _el$417);
          _$setProp(_el$416, "wrapMode", "word");
          _$insert(_el$416, () => root.canUpdate ? "Update" : "No update", _el$417);
          _$insert(_el$416, () => root.canCreate ? "Create" : "No create", null);
          _$insert(_el$416, () => root.primaryCreationRoot ? " \xB7 Primary creation root" : "", null);
          _$insert(_el$414, _$createComponent(Show, {
            get when() {
              return settings().controls.approvedSkillFolders;
            },
            get children() {
              var _el$418 = _$createElement("box");
              _$setProp(_el$418, "flexDirection", "row");
              _$setProp(_el$418, "flexWrap", "wrap");
              _$setProp(_el$418, "gap", 1);
              _$insert(_el$418, () => localActionButton(`Edit ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots), false, undefined, undefined, `edit-root:${index}`), null);
              _$insert(_el$418, () => localActionButton(`Remove ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots.filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `remove-root:${index}`), null);
              return _el$418;
            }
          }), null);
          _$effect((_p$) => {
            var _v$78 = focusId(`root-row:${index}`), _v$79 = props.api.theme.current.borderSubtle, _v$80 = focusId(`root-capabilities:${index}`), _v$81 = props.api.theme.current.textMuted;
            _v$78 !== _p$.e && (_p$.e = _$setProp(_el$414, "id", _v$78, _p$.e));
            _v$79 !== _p$.t && (_p$.t = _$setProp(_el$414, "borderColor", _v$79, _p$.t));
            _v$80 !== _p$.a && (_p$.a = _$setProp(_el$416, "id", _v$80, _p$.a));
            _v$81 !== _p$.o && (_p$.o = _$setProp(_el$416, "fg", _v$81, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$414;
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
              var _el$419 = _$createElement("text");
              _$setProp(_el$419, "wrapMode", "word");
              _$insert(_el$419, folder);
              return _el$419;
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
            var _el$420 = _$createElement("box"), _el$421 = _$createElement("text"), _el$422 = _$createElement("b"), _el$424 = _$createElement("text"), _el$425 = _$createTextNode(`Type exactly: `), _el$426 = _$createElement("input"), _el$427 = _$createElement("box");
            _$insertNode(_el$420, _el$421);
            _$insertNode(_el$420, _el$424);
            _$insertNode(_el$420, _el$426);
            _$insertNode(_el$420, _el$427);
            _$setProp(_el$420, "border", true);
            _$setProp(_el$420, "paddingLeft", 1);
            _$setProp(_el$420, "paddingRight", 1);
            _$setProp(_el$420, "flexDirection", "column");
            _$insertNode(_el$421, _el$422);
            _$insertNode(_el$422, _$createTextNode(`Complete authoritative replacement`));
            _$insert(_el$420, () => reactiveChild(() => draft().map((root, index) => (() => {
              var _el$428 = _$createElement("box"), _el$429 = _$createElement("text"), _el$430 = _$createElement("box");
              _$insertNode(_el$428, _el$429);
              _$insertNode(_el$428, _el$430);
              _$setProp(_el$428, "border", true);
              _$setProp(_el$428, "paddingLeft", 1);
              _$setProp(_el$428, "paddingRight", 1);
              _$setProp(_el$428, "flexDirection", "column");
              _$setProp(_el$429, "wrapMode", "word");
              _$insert(_el$429, () => root.canonicalPath);
              _$setProp(_el$430, "flexDirection", "row");
              _$setProp(_el$430, "flexWrap", "wrap");
              _$setProp(_el$430, "gap", 1);
              _$insert(_el$430, () => localActionButton(root.canUpdate ? "Update allowed" : "Allow updates", () => updateFolderDraft(index, {
                canUpdate: !root.canUpdate
              }), false, undefined, undefined, `draft-update:${index}`), null);
              _$insert(_el$430, () => localActionButton(root.canCreate ? "Create allowed" : "Allow creation", () => updateFolderDraft(index, {
                canCreate: !root.canCreate,
                ...!root.canCreate ? {} : {
                  primaryCreationRoot: false
                }
              }), false, undefined, undefined, `draft-create:${index}`), null);
              _$insert(_el$430, () => localActionButton(root.primaryCreationRoot ? "Primary creation root" : "Make primary creation root", () => {
                setFolderDraft((current) => current?.map((entry, currentIndex) => ({
                  ...entry,
                  primaryCreationRoot: currentIndex === index,
                  canCreate: currentIndex === index
                })) ?? null);
                setFolderConfirmation("");
                setFolderError(null);
              }, root.primaryCreationRoot, undefined, undefined, `draft-primary:${index}`), null);
              _$insert(_el$430, () => localActionButton("Remove row", () => stageFolderList(draft().filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `draft-remove:${index}`), null);
              _$effect((_$p) => _$setProp(_el$428, "borderColor", props.api.theme.current.borderSubtle, _$p));
              return _el$428;
            })())), _el$424);
            _$insertNode(_el$424, _el$425);
            _$setProp(_el$424, "wrapMode", "word");
            _$insert(_el$424, () => settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable", null);
            _$setProp(_el$426, "onInput", (value) => setFolderConfirmation(value.slice(0, 64)));
            _$setProp(_el$427, "flexDirection", "row");
            _$setProp(_el$427, "flexWrap", "wrap");
            _$setProp(_el$427, "gap", 1);
            _$insert(_el$427, () => localActionButton("Replace authoritative roots", () => void submitFolderList(), true, undefined, {
              action: "replace-global-root-policy",
              subject: "project"
            }), null);
            _$insert(_el$427, () => localActionButton("Cancel", () => {
              setFolderDraft(null);
              setFolderConfirmation("");
            }, false, undefined, undefined, "cancel-folder-update"), null);
            _$effect((_p$) => {
              var _v$82 = props.api.theme.current.warning, _v$83 = focusId("root-policy-confirmation"), _v$84 = folderConfirmation(), _v$85 = settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable";
              _v$82 !== _p$.e && (_p$.e = _$setProp(_el$420, "borderColor", _v$82, _p$.e));
              _v$83 !== _p$.t && (_p$.t = _$setProp(_el$426, "id", _v$83, _p$.t));
              _v$84 !== _p$.a && (_p$.a = _$setProp(_el$426, "value", _v$84, _p$.a));
              _v$85 !== _p$.o && (_p$.o = _$setProp(_el$426, "placeholder", _v$85, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$420;
          })()
        }), _el$145);
        _$insertNode(_el$145, _el$146);
        _$insertNode(_el$146, _$createTextNode(`Limits and retention`));
        _$insertNode(_el$148, _$createTextNode(`These values are read-only here. Change configured numeric limits through startup configuration.`));
        _$setProp(_el$148, "wrapMode", "word");
        _$insert(_el$99, () => reactiveChild(() => settings().limits.map((limit) => (() => {
          var _el$431 = _$createElement("box"), _el$432 = _$createElement("text"), _el$433 = _$createElement("b"), _el$434 = _$createElement("text"), _el$435 = _$createTextNode(`Actual: `), _el$436 = _$createElement("text"), _el$437 = _$createTextNode(`Configured limit: `), _el$438 = _$createElement("text");
          _$insertNode(_el$431, _el$432);
          _$insertNode(_el$431, _el$434);
          _$insertNode(_el$431, _el$436);
          _$insertNode(_el$431, _el$438);
          _$setProp(_el$431, "border", true);
          _$setProp(_el$431, "paddingLeft", 1);
          _$setProp(_el$431, "paddingRight", 1);
          _$setProp(_el$431, "flexDirection", "column");
          _$insertNode(_el$432, _el$433);
          _$insert(_el$433, () => limit.label);
          _$insertNode(_el$434, _el$435);
          _$setProp(_el$434, "wrapMode", "word");
          _$insert(_el$434, () => limit.actual, null);
          _$insertNode(_el$436, _el$437);
          _$setProp(_el$436, "wrapMode", "word");
          _$insert(_el$436, () => limit.configured, null);
          _$insert(_el$431, _$createComponent(Show, {
            get when() {
              return limit.resetAt;
            },
            children: (resetAt) => (() => {
              var _el$439 = _$createElement("text"), _el$440 = _$createTextNode(`Resets: `);
              _$insertNode(_el$439, _el$440);
              _$setProp(_el$439, "wrapMode", "word");
              _$insert(_el$439, () => new Date(resetAt()).toISOString(), null);
              return _el$439;
            })()
          }), _el$438);
          _$setProp(_el$438, "wrapMode", "word");
          _$insert(_el$438, () => limit.explanation);
          _$effect((_p$) => {
            var _v$86 = props.api.theme.current.borderSubtle, _v$87 = props.api.theme.current.textMuted;
            _v$86 !== _p$.e && (_p$.e = _$setProp(_el$431, "borderColor", _v$86, _p$.e));
            _v$87 !== _p$.t && (_p$.t = _$setProp(_el$438, "fg", _v$87, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$431;
        })())), _el$150);
        _$insert(_el$99, _$createComponent(Show, {
          get when() {
            return settings().rolloutProgress;
          },
          children: (rolloutProgress) => (() => {
            var _el$441 = _$createElement("box"), _el$442 = _$createElement("text"), _el$443 = _$createElement("b"), _el$445 = _$createTextNode(`: `), _el$446 = _$createElement("text"), _el$447 = _$createTextNode(`Actual: `), _el$448 = _$createElement("text"), _el$449 = _$createTextNode(`Configured requirement: `);
            _$insertNode(_el$441, _el$442);
            _$insertNode(_el$441, _el$446);
            _$insertNode(_el$441, _el$448);
            _$setProp(_el$441, "border", true);
            _$setProp(_el$441, "paddingLeft", 1);
            _$setProp(_el$441, "paddingRight", 1);
            _$setProp(_el$441, "flexDirection", "column");
            _$insertNode(_el$442, _el$443);
            _$insertNode(_el$442, _el$445);
            _$insertNode(_el$443, _$createTextNode(`Compatibility rollout diagnostics (no authority)`));
            _$insert(_el$442, () => rolloutProgress().ready ? "Threshold met" : "Threshold not met", null);
            _$insertNode(_el$446, _el$447);
            _$setProp(_el$446, "wrapMode", "word");
            _$insert(_el$446, () => rolloutProgress().actual, null);
            _$insertNode(_el$448, _el$449);
            _$setProp(_el$448, "wrapMode", "word");
            _$insert(_el$448, () => rolloutProgress().configured, null);
            _$effect((_$p) => _$setProp(_el$441, "borderColor", props.api.theme.current.borderSubtle, _$p));
            return _el$441;
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
          var _el$450 = _$createElement("box"), _el$451 = _$createElement("text");
          _$insertNode(_el$450, _el$451);
          _$setProp(_el$450, "focusable", true);
          _$setProp(_el$450, "border", true);
          _$setProp(_el$450, "paddingLeft", 1);
          _$setProp(_el$450, "paddingRight", 1);
          _$setProp(_el$450, "on:focused", () => setFocusedControl(`maintenance-scope:${scope.value}`));
          _$setProp(_el$450, "on:blurred", () => setFocusedControl((current) => current === `maintenance-scope:${scope.value}` ? null : current));
          _$setProp(_el$450, "onMouseUp", () => {
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$setProp(_el$450, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$insert(_el$451, () => focusMark(`maintenance-scope:${scope.value}`), null);
          _$insert(_el$451, () => scope.label, null);
          _$effect((_$p) => _$setProp(_el$450, "borderColor", maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$450;
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
            var _el$452 = _$createElement("box"), _el$453 = _$createElement("text"), _el$454 = _$createElement("b"), _el$456 = _$createElement("text"), _el$457 = _$createTextNode(`Scope: `), _el$458 = _$createElement("text"), _el$459 = _$createTextNode(`Private path: `), _el$460 = _$createElement("text"), _el$461 = _$createTextNode(`Size: `), _el$462 = _$createTextNode(` bytes`), _el$463 = _$createElement("text"), _el$464 = _$createTextNode(`SHA-256: `), _el$465 = _$createElement("text"), _el$466 = _$createTextNode(`Expires: `);
            _$insertNode(_el$452, _el$453);
            _$insertNode(_el$452, _el$456);
            _$insertNode(_el$452, _el$458);
            _$insertNode(_el$452, _el$460);
            _$insertNode(_el$452, _el$463);
            _$insertNode(_el$452, _el$465);
            _$setProp(_el$452, "border", true);
            _$setProp(_el$452, "paddingLeft", 1);
            _$setProp(_el$452, "paddingRight", 1);
            _$setProp(_el$452, "flexDirection", "column");
            _$insertNode(_el$453, _el$454);
            _$insertNode(_el$454, _$createTextNode(`Latest private export`));
            _$insertNode(_el$456, _el$457);
            _$setProp(_el$456, "wrapMode", "word");
            _$insert(_el$456, () => latestExport().scope, null);
            _$insertNode(_el$458, _el$459);
            _$setProp(_el$458, "wrapMode", "word");
            _$insert(_el$458, () => latestExport().path, null);
            _$insertNode(_el$460, _el$461);
            _$insertNode(_el$460, _el$462);
            _$setProp(_el$460, "wrapMode", "word");
            _$insert(_el$460, () => latestExport().bytes, _el$462);
            _$insertNode(_el$463, _el$464);
            _$setProp(_el$463, "wrapMode", "word");
            _$insert(_el$463, () => latestExport().sha256, null);
            _$insertNode(_el$465, _el$466);
            _$setProp(_el$465, "wrapMode", "word");
            _$insert(_el$465, () => new Date(latestExport().expiresAt).toISOString(), null);
            _$effect((_$p) => _$setProp(_el$452, "borderColor", props.api.theme.current.warning, _$p));
            return _el$452;
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
              var _el$467 = _$createElement("box"), _el$468 = _$createElement("text");
              _$insertNode(_el$467, _el$468);
              _$setProp(_el$467, "focusable", true);
              _$setProp(_el$467, "on:focused", () => setFocusedControl(`outcome:${index}`));
              _$setProp(_el$467, "on:blurred", () => setFocusedControl((current) => current === `outcome:${index}` ? null : current));
              _$setProp(_el$468, "wrapMode", "word");
              _$insert(_el$468, () => focusMark(`outcome:${index}`), null);
              _$insert(_el$468, () => requestResponseMessage(completedResponse), null);
              _$effect((_p$) => {
                var _v$88 = focusId(`outcome:${index}`), _v$89 = completedResponse.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info;
                _v$88 !== _p$.e && (_p$.e = _$setProp(_el$467, "id", _v$88, _p$.e));
                _v$89 !== _p$.t && (_p$.t = _$setProp(_el$468, "fg", _v$89, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$467;
            })()))), _$createComponent(Show, {
              get when() {
                return feedback();
              },
              children: (message) => (() => {
                var _el$469 = _$createElement("box"), _el$470 = _$createElement("text");
                _$insertNode(_el$469, _el$470);
                _$setProp(_el$469, "focusable", true);
                _$setProp(_el$469, "on:focused", () => setFocusedControl("outcome-feedback"));
                _$setProp(_el$469, "on:blurred", () => setFocusedControl((current) => current === "outcome-feedback" ? null : current));
                _$setProp(_el$470, "wrapMode", "word");
                _$insert(_el$470, () => focusMark("outcome-feedback"), null);
                _$insert(_el$470, message, null);
                _$effect((_p$) => {
                  var _v$90 = focusId("outcome-feedback"), _v$91 = props.api.theme.current.info;
                  _v$90 !== _p$.e && (_p$.e = _$setProp(_el$469, "id", _v$90, _p$.e));
                  _v$91 !== _p$.t && (_p$.t = _$setProp(_el$470, "fg", _v$91, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$469;
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
          var _el$471 = _$createElement("box");
          _$setProp(_el$471, "flexDirection", "column");
          _$setProp(_el$471, "width", "100%");
          _$setProp(_el$471, "gap", 1);
          _$insert(_el$471, _$createComponent(SidebarCard, {
            api,
            card: () => deriveSidebarCard(snapshot()),
            open: () => {
              const card = deriveSidebarCard(snapshot());
              openControlCenter(card.destination);
            }
          }), null);
          _$insert(_el$471, _$createComponent(SidebarModeControl, {
            api,
            store,
            snapshot
          }), null);
          return _el$471;
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
