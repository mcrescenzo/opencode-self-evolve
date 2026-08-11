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
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js";
import { CONTROL_CENTER_SECTIONS, acquireProjectTuiStore, buildControlCenterModel, controlCenterRouteParams, deriveSidebarCard, deriveSidebarModeControl, parseControlCenterDestination, validateApprovedSkillFolderInput } from "./self-evolve-tui-store.js";
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
    const node = nodes.get("manual") ?? nodes.get("auto");
    let root = node;
    while (root?.parent)
      root = root.parent;
    const card = root?.findDescendantById(CARD_ID);
    const candidates = [card, nodes.get("manual"), nodes.get("auto")].filter((value) => Boolean(value?.focusable && value.visible));
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
    if (value === "auto" && !confirmation()) {
      setConfirmation(true);
      setFeedback("Auto analyzes at safe idle points but never applies without approval. Activate Confirm Auto to continue.");
      return;
    }
    try {
      await props.store.submitControl("set-repo-mode", {
        mode: value
      });
      setConfirmation(false);
      setFeedback(value === "manual" ? "On demand requested for this project." : "Auto requested for this project.");
    } catch (error) {
      setConfirmation(false);
      setFeedback(`Mode was not changed: ${error instanceof Error ? error.message : String(error)}`);
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
      const label = () => option.value === "auto" && confirmation() ? "Confirm Auto" : option.label;
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
        _$insert(_el$9, () => feedback() ?? `Project mode is read-only: ${model().status}.`);
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
    auto: 1
  })[value ?? ""] ?? 0;
  const projectedModeFor = (target, scope) => {
    if (scope === "global")
      return target;
    return target === "inherit" ? settings().mode.global.value : target;
  };
  const submitMode = (scope, mode) => {
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
        action: "set-consent",
        subject: `consent:${key}`
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
  const maintenancePhrase = () => maintenanceIntent() === "export" ? "EXPORT SENSITIVE SELF-EVOLVE DATA" : maintenanceScope() === "all" ? "PURGE ALL SELF-EVOLVE 0.3.0" : `PURGE ${maintenanceScope().toUpperCase()}`;
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
    var _el$21 = _$createElement("box"), _el$22 = _$createElement("box"), _el$23 = _$createElement("box"), _el$24 = _$createElement("text"), _el$25 = _$createElement("b"), _el$27 = _$createElement("text"), _el$28 = _$createTextNode(` \xB7 `), _el$29 = _$createElement("box"), _el$30 = _$createElement("scrollbox"), _el$205 = _$createElement("box"), _el$206 = _$createElement("text"), _el$207 = _$createTextNode(`Esc returns to `);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$29);
    _$insertNode(_el$21, _el$30);
    _$insertNode(_el$21, _el$205);
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
    _$insert(_el$27, () => home().mode.effective.label, null);
    _$insert(_el$22, _$createComponent(Show, {
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
      var _el$208 = _$createElement("box"), _el$209 = _$createElement("text");
      _$insertNode(_el$208, _el$209);
      _$setProp(_el$208, "focusable", true);
      _$setProp(_el$208, "border", true);
      _$setProp(_el$208, "paddingLeft", 1);
      _$setProp(_el$208, "paddingRight", 1);
      _$setProp(_el$208, "on:focused", () => setFocusedControl(`section:${name}`));
      _$setProp(_el$208, "on:blurred", () => setFocusedControl((current) => current === `section:${name}` ? null : current));
      _$setProp(_el$208, "onMouseUp", () => navigate({
        section: name
      }));
      _$setProp(_el$208, "onKeyDown", (event) => {
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
      _$insert(_el$209, () => focusMark(`section:${name}`), null);
      _$insert(_el$209, () => name.charAt(0).toUpperCase() + name.slice(1), null);
      _$insert(_el$209, (() => {
        var _c$6 = _$memo(() => !!(name === "recommendations" && model().operational.count > 0));
        return () => _c$6() ? ` (${model().operational.count})` : "";
      })(), null);
      _$effect((_p$) => {
        var _v$47 = focusId(`section:${name}`), _v$48 = section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$49 = section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted;
        _v$47 !== _p$.e && (_p$.e = _$setProp(_el$208, "id", _v$47, _p$.e));
        _v$48 !== _p$.t && (_p$.t = _$setProp(_el$208, "borderColor", _v$48, _p$.t));
        _v$49 !== _p$.a && (_p$.a = _$setProp(_el$209, "fg", _v$49, _p$.a));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined
      });
      return _el$208;
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
        var _el$210 = _$createElement("box"), _el$211 = _$createElement("text"), _el$212 = _$createElement("b"), _el$213 = _$createElement("text"), _el$214 = _$createTextNode(`Latest refresh failed: `), _el$215 = _$createElement("text");
        _$insertNode(_el$210, _el$211);
        _$insertNode(_el$210, _el$213);
        _$insertNode(_el$210, _el$215);
        _$setProp(_el$210, "border", true);
        _$setProp(_el$210, "paddingLeft", 1);
        _$setProp(_el$210, "paddingRight", 1);
        _$setProp(_el$210, "flexDirection", "column");
        _$setProp(_el$210, "gap", 1);
        _$insertNode(_el$211, _el$212);
        _$insert(_el$212, () => recovery().stale ? "Read-only stale snapshot" : "Projection unavailable");
        _$insertNode(_el$213, _el$214);
        _$setProp(_el$213, "wrapMode", "word");
        _$insert(_el$213, () => recovery().diagnostic, null);
        _$insertNode(_el$215, _$createTextNode(`Decision, control, and operation actions are unavailable until a fresh projection is negotiated.`));
        _$setProp(_el$215, "wrapMode", "word");
        _$insert(_el$210, _$createComponent(Show, {
          get when() {
            return recovery().canRetry;
          },
          get children() {
            return localActionButton("Retry", () => void retryProjection());
          }
        }), null);
        _$effect((_p$) => {
          var _v$50 = props.api.theme.current.error, _v$51 = props.api.theme.current.textMuted;
          _v$50 !== _p$.e && (_p$.e = _$setProp(_el$210, "borderColor", _v$50, _p$.e));
          _v$51 !== _p$.t && (_p$.t = _$setProp(_el$215, "fg", _v$51, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$210;
      })()
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "home";
      },
      get children() {
        var _el$31 = _$createElement("box"), _el$32 = _$createElement("text"), _el$33 = _$createElement("b"), _el$35 = _$createElement("text"), _el$36 = _$createElement("b"), _el$37 = _$createElement("text"), _el$38 = _$createElement("text"), _el$39 = _$createElement("box"), _el$40 = _$createElement("text"), _el$41 = _$createElement("b"), _el$43 = _$createElement("text"), _el$44 = _$createTextNode(`Effective: `), _el$45 = _$createElement("text"), _el$46 = _$createTextNode(`Global default: `), _el$47 = _$createElement("text"), _el$48 = _$createTextNode(`This project: `), _el$72 = _$createElement("text");
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$31, _el$35);
        _$insertNode(_el$31, _el$37);
        _$insertNode(_el$31, _el$38);
        _$insertNode(_el$31, _el$39);
        _$insertNode(_el$31, _el$72);
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
        _$insertNode(_el$39, _el$47);
        _$setProp(_el$39, "border", true);
        _$setProp(_el$39, "paddingLeft", 1);
        _$setProp(_el$39, "paddingRight", 1);
        _$setProp(_el$39, "flexDirection", "column");
        _$insertNode(_el$40, _el$41);
        _$insertNode(_el$41, _$createTextNode(`Mode and scope`));
        _$insertNode(_el$43, _el$44);
        _$setProp(_el$43, "wrapMode", "word");
        _$insert(_el$43, () => home().mode.effective.label, null);
        _$insertNode(_el$45, _el$46);
        _$setProp(_el$45, "wrapMode", "word");
        _$insert(_el$45, () => home().mode.global.label, null);
        _$insertNode(_el$47, _el$48);
        _$setProp(_el$47, "wrapMode", "word");
        _$insert(_el$47, () => home().mode.repository.label, null);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().globalReadiness;
          },
          children: (globalReadiness) => (() => {
            var _el$217 = _$createElement("box"), _el$218 = _$createElement("text"), _el$219 = _$createElement("b"), _el$221 = _$createTextNode(`: `), _el$222 = _$createElement("text"), _el$223 = _$createTextNode(`Protocol: `);
            _$insertNode(_el$217, _el$218);
            _$insertNode(_el$217, _el$222);
            _$setProp(_el$217, "border", true);
            _$setProp(_el$217, "paddingLeft", 1);
            _$setProp(_el$217, "paddingRight", 1);
            _$setProp(_el$217, "flexDirection", "column");
            _$insertNode(_el$218, _el$219);
            _$insertNode(_el$218, _el$221);
            _$insertNode(_el$219, _$createTextNode(`Global recommendations`));
            _$insert(_el$218, () => globalReadiness().state === "ready" ? "Ready" : "Limited / read-only", null);
            _$insertNode(_el$222, _el$223);
            _$setProp(_el$222, "wrapMode", "word");
            _$insert(_el$222, () => globalReadiness().label, null);
            _$insert(_el$217, _$createComponent(Show, {
              get when() {
                return globalReadiness().recommendationCount !== null;
              },
              get children() {
                var _el$224 = _$createElement("text"), _el$225 = _$createTextNode(` global recommendation`);
                _$insertNode(_el$224, _el$225);
                _$insert(_el$224, () => globalReadiness().recommendationCount, _el$225);
                _$insert(_el$224, () => globalReadiness().recommendationCount === 1 ? "" : "s", null);
                return _el$224;
              }
            }), null);
            _$insert(_el$217, _$createComponent(Show, {
              get when() {
                return globalReadiness().reason;
              },
              get children() {
                var _el$226 = _$createElement("text");
                _$setProp(_el$226, "wrapMode", "word");
                _$insert(_el$226, () => globalReadiness().reason);
                _$effect((_$p) => _$setProp(_el$226, "fg", props.api.theme.current.textMuted, _$p));
                return _el$226;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$217, "borderColor", globalReadiness().state === "ready" ? props.api.theme.current.borderSubtle : props.api.theme.current.warning, _$p));
            return _el$217;
          })()
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().firstRun;
          },
          get children() {
            var _el$49 = _$createElement("box"), _el$50 = _$createElement("text"), _el$51 = _$createElement("b"), _el$53 = _$createElement("text"), _el$57 = _$createElement("text"), _el$58 = _$createElement("b"), _el$60 = _$createElement("text");
            _$insertNode(_el$49, _el$50);
            _$insertNode(_el$49, _el$53);
            _$insertNode(_el$49, _el$57);
            _$insertNode(_el$49, _el$60);
            _$setProp(_el$49, "border", true);
            _$setProp(_el$49, "paddingLeft", 1);
            _$setProp(_el$49, "paddingRight", 1);
            _$setProp(_el$49, "flexDirection", "column");
            _$setProp(_el$49, "gap", 1);
            _$insertNode(_el$50, _el$51);
            _$insertNode(_el$51, _$createTextNode(`Get automatic recommendations`));
            _$insertNode(_el$53, _$createTextNode(`Choose proactive review without granting automatic writes or privacy consent. Background AI analysis and saved structured patterns remain separate consent gates in Settings.`));
            _$setProp(_el$53, "wrapMode", "word");
            _$insert(_el$49, _$createComponent(Show, {
              get when() {
                return settings().controls.globalMode;
              },
              get children() {
                return actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true, {
                  action: "set-mode",
                  subject: "global-mode"
                });
              }
            }), _el$57);
            _$insert(_el$49, _$createComponent(Show, {
              get when() {
                return !settings().controls.globalMode;
              },
              get children() {
                var _el$55 = _$createElement("text");
                _$insertNode(_el$55, _$createTextNode(`Controls are unavailable until the aligned server publishes fresh authority.`));
                _$effect((_$p) => _$setProp(_el$55, "fg", props.api.theme.current.textMuted, _$p));
                return _el$55;
              }
            }), _el$57);
            _$insertNode(_el$57, _el$58);
            _$insertNode(_el$58, _$createTextNode(`Optional evidence excerpts`));
            _$insertNode(_el$60, _$createTextNode(`Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations.`));
            _$setProp(_el$60, "wrapMode", "word");
            _$insert(_el$49, _$createComponent(Show, {
              get when() {
                return settings().controls.consent;
              },
              get children() {
                return localActionButton("Review consent for Sanitized evidence excerpts", () => openConsentDisclosure("sanitizedExcerpts"));
              }
            }), null);
            _$insert(_el$49, _$createComponent(Show, {
              get when() {
                return !settings().controls.consent;
              },
              get children() {
                var _el$62 = _$createElement("text");
                _$insertNode(_el$62, _$createTextNode(`Excerpt consent can be changed later in Settings.`));
                _$effect((_$p) => _$setProp(_el$62, "fg", props.api.theme.current.textMuted, _$p));
                return _el$62;
              }
            }), null);
            _$insert(_el$49, () => consentDisclosure("sanitizedExcerpts"), null);
            _$effect((_$p) => _$setProp(_el$49, "borderColor", props.api.theme.current.info, _$p));
            return _el$49;
          }
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().blockers.length;
          },
          get children() {
            var _el$64 = _$createElement("box"), _el$65 = _$createElement("text"), _el$66 = _$createElement("b");
            _$insertNode(_el$64, _el$65);
            _$setProp(_el$64, "flexDirection", "column");
            _$insertNode(_el$65, _el$66);
            _$insertNode(_el$66, _$createTextNode(`Setup`));
            _$insert(_el$64, () => reactiveChild(() => home().blockers.map((blocker) => (() => {
              var _el$227 = _$createElement("box"), _el$228 = _$createElement("text"), _el$229 = _$createTextNode(` \xB7 Open `);
              _$insertNode(_el$227, _el$228);
              _$setProp(_el$227, "focusable", true);
              _$setProp(_el$227, "border", true);
              _$setProp(_el$227, "paddingLeft", 1);
              _$setProp(_el$227, "paddingRight", 1);
              _$setProp(_el$227, "on:focused", () => setFocusedControl(`blocker:${blocker.code}`));
              _$setProp(_el$227, "on:blurred", () => setFocusedControl((current) => current === `blocker:${blocker.code}` ? null : current));
              _$setProp(_el$227, "onMouseUp", () => navigate(blocker.destination));
              _$setProp(_el$227, "onKeyDown", (event) => {
                if (!isActivationKey(event))
                  return;
                event.preventDefault();
                navigate(blocker.destination);
              });
              _$insertNode(_el$228, _el$229);
              _$setProp(_el$228, "wrapMode", "word");
              _$insert(_el$228, () => focusMark(`blocker:${blocker.code}`), _el$229);
              _$insert(_el$228, () => blocker.summary, _el$229);
              _$insert(_el$228, (() => {
                var _c$7 = _$memo(() => blocker.destination.section === "activity");
                return () => _c$7() ? "Activity errors" : blocker.destination.section.charAt(0).toUpperCase() + blocker.destination.section.slice(1);
              })(), null);
              _$effect((_$p) => _$setProp(_el$227, "borderColor", props.api.theme.current.warning, _$p));
              return _el$227;
            })())), null);
            return _el$64;
          }
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().lastCycle;
          },
          children: (lastCycle) => (() => {
            var _el$230 = _$createElement("box"), _el$231 = _$createElement("text"), _el$232 = _$createElement("b"), _el$234 = _$createElement("text"), _el$235 = _$createTextNode(` \xB7 `), _el$236 = _$createTextNode(` observations \xB7 `), _el$237 = _$createTextNode(` eligible`);
            _$insertNode(_el$230, _el$231);
            _$insertNode(_el$230, _el$234);
            _$setProp(_el$230, "flexDirection", "column");
            _$insertNode(_el$231, _el$232);
            _$insertNode(_el$232, _$createTextNode(`Last cycle`));
            _$insertNode(_el$234, _el$235);
            _$insertNode(_el$234, _el$236);
            _$insertNode(_el$234, _el$237);
            _$setProp(_el$234, "wrapMode", "word");
            _$insert(_el$234, () => lastCycle().outcome.replaceAll("-", " "), _el$235);
            _$insert(_el$234, () => lastCycle().observationCount, _el$236);
            _$insert(_el$234, () => lastCycle().eligibilityCount, _el$237);
            return _el$230;
          })()
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().attention;
          },
          children: (attention) => (() => {
            var _el$238 = _$createElement("box"), _el$239 = _$createElement("text"), _el$240 = _$createTextNode(` `), _el$241 = _$createTextNode(` needs attention`);
            _$insertNode(_el$238, _el$239);
            _$setProp(_el$238, "focusable", true);
            _$setProp(_el$238, "border", true);
            _$setProp(_el$238, "paddingLeft", 1);
            _$setProp(_el$238, "paddingRight", 1);
            _$setProp(_el$238, "on:focused", () => setFocusedControl("home:attention"));
            _$setProp(_el$238, "on:blurred", () => setFocusedControl((current) => current === "home:attention" ? null : current));
            _$setProp(_el$238, "onMouseUp", () => navigate(attention().destination));
            _$setProp(_el$238, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              navigate(attention().destination);
            });
            _$insertNode(_el$239, _el$240);
            _$insertNode(_el$239, _el$241);
            _$insert(_el$239, () => focusMark("home:attention"), _el$240);
            _$insert(_el$239, () => attention().count, _el$240);
            _$insert(_el$239, () => attention().kind === "applied" ? "applied change" : "recommendation", _el$241);
            _$effect((_p$) => {
              var _v$52 = focusId("home:attention"), _v$53 = props.api.theme.current.warning;
              _v$52 !== _p$.e && (_p$.e = _$setProp(_el$238, "id", _v$52, _p$.e));
              _v$53 !== _p$.t && (_p$.t = _$setProp(_el$238, "borderColor", _v$53, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$238;
          })()
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().usage;
          },
          children: (usage) => (() => {
            var _el$242 = _$createElement("box"), _el$243 = _$createElement("text"), _el$244 = _$createElement("b"), _el$246 = _$createElement("text"), _el$247 = _$createTextNode(`Background analysis: `), _el$248 = _$createTextNode(` / `), _el$249 = _$createElement("text"), _el$250 = _$createTextNode(`Background analysis resets: `), _el$251 = _$createElement("text"), _el$252 = _$createTextNode(`Recommendation synthesis: `), _el$253 = _$createTextNode(` / `), _el$254 = _$createElement("text"), _el$255 = _$createTextNode(`Recommendation synthesis resets: `), _el$256 = _$createElement("text"), _el$257 = _$createTextNode(`Storage: `), _el$258 = _$createTextNode(` / `), _el$259 = _$createTextNode(` bytes`);
            _$insertNode(_el$242, _el$243);
            _$insertNode(_el$242, _el$246);
            _$insertNode(_el$242, _el$249);
            _$insertNode(_el$242, _el$251);
            _$insertNode(_el$242, _el$254);
            _$insertNode(_el$242, _el$256);
            _$setProp(_el$242, "flexDirection", "column");
            _$insertNode(_el$243, _el$244);
            _$insertNode(_el$244, _$createTextNode(`Actual usage`));
            _$insertNode(_el$246, _el$247);
            _$insertNode(_el$246, _el$248);
            _$insert(_el$246, () => usage().passive.used, _el$248);
            _$insert(_el$246, () => usage().passive.limit, null);
            _$insertNode(_el$249, _el$250);
            _$insert(_el$249, (() => {
              var _c$8 = _$memo(() => !!usage().passive.resetAt);
              return () => _c$8() ? new Date(usage().passive.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$251, _el$252);
            _$insertNode(_el$251, _el$253);
            _$insert(_el$251, () => usage().synthesis.used, _el$253);
            _$insert(_el$251, () => usage().synthesis.limit, null);
            _$insertNode(_el$254, _el$255);
            _$insert(_el$254, (() => {
              var _c$9 = _$memo(() => !!usage().synthesis.resetAt);
              return () => _c$9() ? new Date(usage().synthesis.resetAt).toISOString() : "Unavailable";
            })(), null);
            _$insertNode(_el$256, _el$257);
            _$insertNode(_el$256, _el$258);
            _$insertNode(_el$256, _el$259);
            _$insert(_el$256, () => usage().storage.usedBytes, _el$258);
            _$insert(_el$256, () => usage().storage.limitBytes, _el$259);
            return _el$242;
          })()
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().recentActivity.length;
          },
          get children() {
            var _el$68 = _$createElement("box"), _el$69 = _$createElement("text"), _el$70 = _$createElement("b");
            _$insertNode(_el$68, _el$69);
            _$setProp(_el$68, "flexDirection", "column");
            _$insertNode(_el$69, _el$70);
            _$insertNode(_el$70, _$createTextNode(`Recent activity`));
            _$insert(_el$68, () => reactiveChild(() => home().recentActivity.map((entry) => (() => {
              var _el$260 = _$createElement("text"), _el$261 = _$createTextNode(`[`), _el$262 = _$createTextNode(`] `);
              _$insertNode(_el$260, _el$261);
              _$insertNode(_el$260, _el$262);
              _$setProp(_el$260, "wrapMode", "word");
              _$insert(_el$260, () => entry.marker, _el$262);
              _$insert(_el$260, () => entry.summary, null);
              return _el$260;
            })())), null);
            return _el$68;
          }
        }), _el$72);
        _$insert(_el$31, _$createComponent(Show, {
          get when() {
            return home().emptyState;
          },
          children: (emptyState) => (() => {
            var _el$263 = _$createElement("box"), _el$264 = _$createElement("text"), _el$265 = _$createElement("b"), _el$266 = _$createElement("text");
            _$insertNode(_el$263, _el$264);
            _$insertNode(_el$263, _el$266);
            _$setProp(_el$263, "flexDirection", "column");
            _$insertNode(_el$264, _el$265);
            _$insert(_el$265, () => emptyState().heading);
            _$setProp(_el$266, "wrapMode", "word");
            _$insert(_el$266, () => emptyState().explanation);
            return _el$263;
          })()
        }), _el$72);
        _$setProp(_el$72, "wrapMode", "word");
        _$insert(_el$72, () => home().manualFallback);
        _$effect((_p$) => {
          var _v$23 = props.api.theme.current.text, _v$24 = props.api.theme.current.textMuted, _v$25 = props.api.theme.current.borderSubtle, _v$26 = props.api.theme.current.textMuted;
          _v$23 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$23, _p$.e));
          _v$24 !== _p$.t && (_p$.t = _$setProp(_el$38, "fg", _v$24, _p$.t));
          _v$25 !== _p$.a && (_p$.a = _$setProp(_el$39, "borderColor", _v$25, _p$.a));
          _v$26 !== _p$.o && (_p$.o = _$setProp(_el$72, "fg", _v$26, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$31;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "recommendations";
      },
      get children() {
        var _el$73 = _$createElement("box"), _el$74 = _$createElement("text"), _el$75 = _$createElement("b"), _el$80 = _$createElement("box");
        _$insertNode(_el$73, _el$74);
        _$insertNode(_el$73, _el$80);
        _$setProp(_el$73, "flexDirection", "column");
        _$setProp(_el$73, "gap", 1);
        _$insertNode(_el$74, _el$75);
        _$insertNode(_el$75, _$createTextNode(`Recommendations`));
        _$insert(_el$73, _$createComponent(Show, {
          get when() {
            return recommendations().limited;
          },
          get children() {
            var _el$77 = _$createElement("text");
            _$insertNode(_el$77, _$createTextNode(`Limited / read-only global recommendations. Fresh aligned grants are required before Apply, Reject, or Undo appears.`));
            _$setProp(_el$77, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$77, "fg", props.api.theme.current.warning, _$p));
            return _el$77;
          }
        }), _el$80);
        _$insert(_el$73, _$createComponent(Show, {
          get when() {
            return recommendations().enhancedError;
          },
          get children() {
            var _el$79 = _$createElement("text");
            _$setProp(_el$79, "wrapMode", "word");
            _$insert(_el$79, () => recommendations().enhancedError);
            _$effect((_$p) => _$setProp(_el$79, "fg", props.api.theme.current.error, _$p));
            return _el$79;
          }
        }), _el$80);
        _$setProp(_el$80, "flexDirection", "row");
        _$setProp(_el$80, "gap", 1);
        _$setProp(_el$80, "flexWrap", "wrap");
        _$insert(_el$80, () => [["needs-review", "Needs review"], ["applied", "Applied"], ["dismissed", "Dismissed"], ["all", "All"]].map(([value, label]) => (() => {
          var _el$267 = _$createElement("box"), _el$268 = _$createElement("text");
          _$insertNode(_el$267, _el$268);
          _$setProp(_el$267, "focusable", true);
          _$setProp(_el$267, "border", true);
          _$setProp(_el$267, "paddingLeft", 1);
          _$setProp(_el$267, "paddingRight", 1);
          _$setProp(_el$267, "on:focused", () => setFocusedControl(`recommendation-filter:${value}`));
          _$setProp(_el$267, "on:blurred", () => setFocusedControl((current) => current === `recommendation-filter:${value}` ? null : current));
          _$setProp(_el$267, "onMouseUp", () => {
            setRecommendationFilter(value);
            const first = buildControlCenterModel(props.snapshot(), {
              recommendationFilter: value
            }).sections.recommendations.queue[0];
            if (first)
              selectRecommendation(first.sourceIndex);
          });
          _$setProp(_el$267, "onKeyDown", (event) => {
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
          _$insert(_el$268, () => focusMark(`recommendation-filter:${value}`), null);
          _$insert(_el$268, label, null);
          _$effect((_p$) => {
            var _v$54 = focusId(`recommendation-filter:${value}`), _v$55 = recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$54 !== _p$.e && (_p$.e = _$setProp(_el$267, "id", _v$54, _p$.e));
            _v$55 !== _p$.t && (_p$.t = _$setProp(_el$267, "borderColor", _v$55, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$267;
        })()));
        _$insert(_el$73, _$createComponent(Show, {
          get when() {
            return recommendations().emptyState;
          },
          get children() {
            var _el$81 = _$createElement("text");
            _$insert(_el$81, () => recommendations().emptyState);
            return _el$81;
          }
        }), null);
        _$insert(_el$73, () => reactiveChild(() => recommendations().queue.map((item, index) => (() => {
          var _el$269 = _$createElement("box"), _el$270 = _$createElement("text"), _el$271 = _$createTextNode(` \xB7 `), _el$272 = _$createTextNode(` \xB7 `), _el$273 = _$createElement("text"), _el$274 = _$createElement("text"), _el$275 = _$createTextNode(`Risk: `), _el$276 = _$createTextNode(` \xB7 Evidence: `);
          _$insertNode(_el$269, _el$270);
          _$insertNode(_el$269, _el$273);
          _$insertNode(_el$269, _el$274);
          _$use((value) => recommendationNodes.set(item.sourceIndex, value), _el$269);
          _$setProp(_el$269, "focusable", true);
          _$setProp(_el$269, "border", true);
          _$setProp(_el$269, "paddingLeft", 1);
          _$setProp(_el$269, "paddingRight", 1);
          _$setProp(_el$269, "flexDirection", "column");
          _$setProp(_el$269, "on:focused", () => {
            setFocusedControl(`recommendation-row:${item.sourceIndex}`);
            selectRecommendation(item.sourceIndex);
          });
          _$setProp(_el$269, "on:blurred", () => setFocusedControl((current) => current === `recommendation-row:${item.sourceIndex}` ? null : current));
          _$setProp(_el$269, "onMouseUp", () => {
            selectRecommendation(item.sourceIndex);
            recommendationNodes.get(item.sourceIndex)?.focus();
          });
          _$setProp(_el$269, "onKeyDown", (event) => {
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
          _$insertNode(_el$270, _el$271);
          _$insertNode(_el$270, _el$272);
          _$setProp(_el$270, "wrapMode", "word");
          _$insert(_el$270, () => focusMark(`recommendation-row:${item.sourceIndex}`), _el$271);
          _$insert(_el$270, (() => {
            var _c$0 = _$memo(() => item.attention === "critical");
            return () => _c$0() ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "";
          })(), _el$271);
          _$insert(_el$270, () => item.target, _el$271);
          _$insert(_el$270, () => item.state.replaceAll("-", " "), _el$272);
          _$insert(_el$270, () => relativeTime(item.updatedAt), null);
          _$setProp(_el$273, "wrapMode", "word");
          _$insert(_el$273, () => item.rationale);
          _$insertNode(_el$274, _el$275);
          _$insertNode(_el$274, _el$276);
          _$insert(_el$274, () => item.risk ?? "Loading", _el$276);
          _$insert(_el$274, () => item.evidenceCount ?? "Loading", null);
          _$effect((_p$) => {
            var _v$56 = focusId(`recommendation-row:${item.sourceIndex}`), _v$57 = recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$58 = props.api.theme.current.textMuted, _v$59 = props.api.theme.current.textMuted;
            _v$56 !== _p$.e && (_p$.e = _$setProp(_el$269, "id", _v$56, _p$.e));
            _v$57 !== _p$.t && (_p$.t = _$setProp(_el$269, "borderColor", _v$57, _p$.t));
            _v$58 !== _p$.a && (_p$.a = _$setProp(_el$273, "fg", _v$58, _p$.a));
            _v$59 !== _p$.o && (_p$.o = _$setProp(_el$274, "fg", _v$59, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$269;
        })())), null);
        _$insert(_el$73, _$createComponent(Show, {
          get when() {
            return recommendations().selected;
          },
          children: (selected) => (() => {
            var _el$277 = _$createElement("box"), _el$278 = _$createElement("text"), _el$279 = _$createElement("b"), _el$287 = _$createElement("box"), _el$288 = _$createElement("box"), _el$289 = _$createElement("text"), _el$290 = _$createTextNode(`Open in Activity`);
            _$insertNode(_el$277, _el$278);
            _$insertNode(_el$277, _el$287);
            _$setProp(_el$277, "border", true);
            _$setProp(_el$277, "paddingLeft", 1);
            _$setProp(_el$277, "paddingRight", 1);
            _$setProp(_el$277, "flexDirection", "column");
            _$setProp(_el$277, "gap", 1);
            _$insertNode(_el$278, _el$279);
            _$insert(_el$279, () => selected().target);
            _$insert(_el$277, _$createComponent(Show, {
              get when() {
                return selected().loading;
              },
              get children() {
                var _el$280 = _$createElement("text");
                _$insertNode(_el$280, _$createTextNode(`Loading authoritative recommendation detail\u2026`));
                return _el$280;
              }
            }), _el$287);
            _$insert(_el$277, _$createComponent(Show, {
              get when() {
                return selected().summary;
              },
              children: (summary) => [(() => {
                var _el$293 = _$createElement("box"), _el$294 = _$createElement("text"), _el$295 = _$createElement("b"), _el$297 = _$createElement("text");
                _$insertNode(_el$293, _el$294);
                _$insertNode(_el$293, _el$297);
                _$setProp(_el$293, "flexDirection", "column");
                _$insertNode(_el$294, _el$295);
                _$insertNode(_el$295, _$createTextNode(`Why this was suggested`));
                _$setProp(_el$297, "wrapMode", "word");
                _$insert(_el$297, () => summary().rationale);
                _$insert(_el$293, _$createComponent(Show, {
                  get when() {
                    return summary().support;
                  },
                  children: (support) => [(() => {
                    var _el$350 = _$createElement("text"), _el$351 = _$createTextNode(`Target: `), _el$352 = _$createTextNode(` \xB7 `);
                    _$insertNode(_el$350, _el$351);
                    _$insertNode(_el$350, _el$352);
                    _$setProp(_el$350, "wrapMode", "word");
                    _$insert(_el$350, () => summary().targetKind === "new-global-skill" ? "New global skill" : "Existing global skill", _el$352);
                    _$insert(_el$350, () => summary().target, null);
                    return _el$350;
                  })(), (() => {
                    var _el$353 = _$createElement("text"), _el$354 = _$createTextNode(`Support: `), _el$355 = _$createTextNode(` \xB7 `), _el$356 = _$createTextNode(` independent domains \xB7 `), _el$357 = _$createTextNode(` incidents \xB7 `), _el$358 = _$createTextNode(` occurrences`);
                    _$insertNode(_el$353, _el$354);
                    _$insertNode(_el$353, _el$355);
                    _$insertNode(_el$353, _el$356);
                    _$insertNode(_el$353, _el$357);
                    _$insertNode(_el$353, _el$358);
                    _$setProp(_el$353, "wrapMode", "word");
                    _$insert(_el$353, () => support().tier.replaceAll("-", " "), _el$355);
                    _$insert(_el$353, () => support().independentDomainCount, _el$356);
                    _$insert(_el$353, () => support().independentIncidentCount, _el$357);
                    _$insert(_el$353, () => support().occurrenceCount, _el$358);
                    return _el$353;
                  })(), (() => {
                    var _el$359 = _$createElement("text"), _el$360 = _$createTextNode(`Observed: `), _el$361 = _$createTextNode(` through `);
                    _$insertNode(_el$359, _el$360);
                    _$insertNode(_el$359, _el$361);
                    _$setProp(_el$359, "wrapMode", "word");
                    _$insert(_el$359, () => support().firstSeenDay, _el$361);
                    _$insert(_el$359, () => support().lastSeenDay, null);
                    return _el$359;
                  })(), (() => {
                    var _el$362 = _$createElement("text"), _el$363 = _$createTextNode(`Current project contributed: `);
                    _$insertNode(_el$362, _el$363);
                    _$setProp(_el$362, "wrapMode", "word");
                    _$insert(_el$362, (() => {
                      var _c$10 = _$memo(() => summary().currentProjectContributed === null);
                      return () => _c$10() ? "Unavailable" : summary().currentProjectContributed ? "Yes" : "No";
                    })(), null);
                    return _el$362;
                  })()]
                }), null);
                return _el$293;
              })(), (() => {
                var _el$298 = _$createElement("box"), _el$299 = _$createElement("text"), _el$300 = _$createElement("b");
                _$insertNode(_el$298, _el$299);
                _$setProp(_el$298, "flexDirection", "column");
                _$insertNode(_el$299, _el$300);
                _$insertNode(_el$300, _$createTextNode(`Proposed change`));
                _$insert(_el$298, () => reactiveChild(() => selected().diff?.lines.map((line) => (() => {
                  var _el$364 = _$createElement("text");
                  _$setProp(_el$364, "wrapMode", "word");
                  _$insert(_el$364, line);
                  return _el$364;
                })()) ?? []), null);
                _$insert(_el$298, _$createComponent(Show, {
                  get when() {
                    return selected().diff?.overflow?.truncated;
                  },
                  get children() {
                    var _el$302 = _$createElement("text");
                    _$insertNode(_el$302, _$createTextNode(`The proposed change was truncated by the bounded projection.`));
                    _$effect((_$p) => _$setProp(_el$302, "fg", props.api.theme.current.warning, _$p));
                    return _el$302;
                  }
                }), null);
                return _el$298;
              })(), (() => {
                var _el$304 = _$createElement("box"), _el$305 = _$createElement("text"), _el$306 = _$createElement("b");
                _$insertNode(_el$304, _el$305);
                _$setProp(_el$304, "flexDirection", "column");
                _$insertNode(_el$305, _el$306);
                _$insertNode(_el$306, _$createTextNode(`Evidence`));
                _$insert(_el$304, () => reactiveChild(() => selected().evidence.map((entry) => (() => {
                  var _el$365 = _$createElement("text"), _el$366 = _$createTextNode(`: `);
                  _$insertNode(_el$365, _el$366);
                  _$setProp(_el$365, "wrapMode", "word");
                  _$insert(_el$365, () => entry.kind, _el$366);
                  _$insert(_el$365, () => entry.summary, null);
                  _$insert(_el$365, () => entry.redacted ? " [redacted]" : "", null);
                  return _el$365;
                })())), null);
                _$insert(_el$304, _$createComponent(Show, {
                  get when() {
                    return !selected().evidence.length;
                  },
                  get children() {
                    var _el$308 = _$createElement("text");
                    _$insertNode(_el$308, _$createTextNode(`No bounded evidence detail is loaded.`));
                    return _el$308;
                  }
                }), null);
                return _el$304;
              })(), (() => {
                var _el$310 = _$createElement("box"), _el$311 = _$createElement("text"), _el$312 = _$createElement("b"), _el$314 = _$createElement("text"), _el$315 = _$createTextNode(`Critic: `), _el$319 = _$createElement("text"), _el$320 = _$createTextNode(`Deterministic checks: `);
                _$insertNode(_el$310, _el$311);
                _$insertNode(_el$310, _el$314);
                _$insertNode(_el$310, _el$319);
                _$setProp(_el$310, "flexDirection", "column");
                _$insertNode(_el$311, _el$312);
                _$insertNode(_el$312, _$createTextNode(`Safety checks`));
                _$insertNode(_el$314, _el$315);
                _$insert(_el$314, () => summary().criticPassed ? "Passed" : "Not passed", null);
                _$insert(_el$310, _$createComponent(Show, {
                  get when() {
                    return summary().criticScoreBasisPoints !== undefined;
                  },
                  get children() {
                    var _el$316 = _$createElement("text"), _el$317 = _$createTextNode(`Critic score: `), _el$318 = _$createTextNode(`%`);
                    _$insertNode(_el$316, _el$317);
                    _$insertNode(_el$316, _el$318);
                    _$insert(_el$316, () => (summary().criticScoreBasisPoints / 100).toFixed(2), _el$318);
                    return _el$316;
                  }
                }), _el$319);
                _$insertNode(_el$319, _el$320);
                _$insert(_el$319, () => summary().validDeterministic ? "Passed" : "Not passed", null);
                _$insert(_el$310, _$createComponent(Show, {
                  get when() {
                    return summary().injectionFlagged !== undefined;
                  },
                  get children() {
                    var _el$321 = _$createElement("text"), _el$322 = _$createTextNode(`Injection scan: `);
                    _$insertNode(_el$321, _el$322);
                    _$insert(_el$321, () => summary().injectionFlagged ? "Flagged" : "Clear", null);
                    return _el$321;
                  }
                }), null);
                _$insert(_el$310, _$createComponent(Show, {
                  get when() {
                    return summary().eligibility;
                  },
                  children: (eligibility) => reactiveChild(() => eligibility().checks.map((check) => (() => {
                    var _el$367 = _$createElement("text"), _el$368 = _$createTextNode(`[`), _el$369 = _$createTextNode(`] `), _el$370 = _$createTextNode(`: `), _el$371 = _$createTextNode(` / `);
                    _$insertNode(_el$367, _el$368);
                    _$insertNode(_el$367, _el$369);
                    _$insertNode(_el$367, _el$370);
                    _$insertNode(_el$367, _el$371);
                    _$setProp(_el$367, "wrapMode", "word");
                    _$insert(_el$367, () => check.met ? "Passed" : "Blocked", _el$369);
                    _$insert(_el$367, () => check.name, _el$370);
                    _$insert(_el$367, () => check.actual, _el$371);
                    _$insert(_el$367, () => check.required, null);
                    return _el$367;
                  })()))
                }), null);
                return _el$310;
              })(), (() => {
                var _el$323 = _$createElement("box"), _el$324 = _$createElement("text"), _el$325 = _$createElement("b"), _el$327 = _$createElement("text"), _el$328 = _$createTextNode(`: `);
                _$insertNode(_el$323, _el$324);
                _$insertNode(_el$323, _el$327);
                _$setProp(_el$323, "flexDirection", "column");
                _$insertNode(_el$324, _el$325);
                _$insertNode(_el$325, _$createTextNode(`Generality`));
                _$insertNode(_el$327, _el$328);
                _$setProp(_el$327, "wrapMode", "word");
                _$insert(_el$327, () => summary().generality.status, _el$328);
                _$insert(_el$327, () => summary().generality.explanation, null);
                return _el$323;
              })(), (() => {
                var _el$329 = _$createElement("box"), _el$330 = _$createElement("text"), _el$331 = _$createElement("b");
                _$insertNode(_el$329, _el$330);
                _$setProp(_el$329, "flexDirection", "column");
                _$insertNode(_el$330, _el$331);
                _$insertNode(_el$331, _$createTextNode(`Token impact`));
                _$insert(_el$329, _$createComponent(Show, {
                  get when() {
                    return summary().tokenImpact.available;
                  },
                  get fallback() {
                    return (() => {
                      var _el$372 = _$createElement("text"), _el$373 = _$createTextNode(`Unavailable: `);
                      _$insertNode(_el$372, _el$373);
                      _$setProp(_el$372, "wrapMode", "word");
                      _$insert(_el$372, () => summary().tokenImpact.explanation, null);
                      return _el$372;
                    })();
                  },
                  get children() {
                    var _el$333 = _$createElement("text"), _el$334 = _$createTextNode(` estimated / `), _el$335 = _$createTextNode(` budgeted tokens`);
                    _$insertNode(_el$333, _el$334);
                    _$insertNode(_el$333, _el$335);
                    _$insert(_el$333, () => summary().tokenImpact.estimatedTokens, _el$334);
                    _$insert(_el$333, () => summary().tokenImpact.budgetTokens, _el$335);
                    return _el$333;
                  }
                }), null);
                return _el$329;
              })(), (() => {
                var _el$336 = _$createElement("box"), _el$337 = _$createElement("text"), _el$338 = _$createElement("b"), _el$340 = _$createElement("text");
                _$insertNode(_el$336, _el$337);
                _$insertNode(_el$336, _el$340);
                _$setProp(_el$336, "flexDirection", "column");
                _$insertNode(_el$337, _el$338);
                _$insertNode(_el$338, _$createTextNode(`Rollback`));
                _$insert(_el$340, (() => {
                  var _c$1 = _$memo(() => !!summary().rollback.eligible);
                  return () => _c$1() ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`;
                })());
                return _el$336;
              })(), (() => {
                var _el$341 = _$createElement("box"), _el$342 = _$createElement("text"), _el$343 = _$createTextNode(`Technical details `);
                _$insertNode(_el$341, _el$342);
                _$setProp(_el$341, "focusable", true);
                _$setProp(_el$341, "border", true);
                _$setProp(_el$341, "paddingLeft", 1);
                _$setProp(_el$341, "paddingRight", 1);
                _$setProp(_el$341, "on:focused", () => setFocusedControl("recommendation:technical"));
                _$setProp(_el$341, "on:blurred", () => setFocusedControl((current) => current === "recommendation:technical" ? null : current));
                _$setProp(_el$341, "onMouseUp", () => setTechnicalExpanded((value) => !value));
                _$setProp(_el$341, "onKeyDown", (event) => {
                  if (!isActivationKey(event))
                    return;
                  event.preventDefault();
                  setTechnicalExpanded((value) => !value);
                });
                _$insertNode(_el$342, _el$343);
                _$insert(_el$342, () => focusMark("recommendation:technical"), _el$343);
                _$insert(_el$342, () => technicalExpanded() ? "\u25B2" : "\u25BC", null);
                _$effect((_$p) => _$setProp(_el$341, "borderColor", technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                return _el$341;
              })(), _$createComponent(Show, {
                get when() {
                  return technicalExpanded();
                },
                get children() {
                  return [(() => {
                    var _el$344 = _$createElement("text"), _el$345 = _$createTextNode(`State: `);
                    _$insertNode(_el$344, _el$345);
                    _$insert(_el$344, () => summary().state, null);
                    return _el$344;
                  })(), _$createComponent(Show, {
                    get when() {
                      return summary().effectiveMode;
                    },
                    get children() {
                      var _el$346 = _$createElement("text"), _el$347 = _$createTextNode(`Effective mode: `);
                      _$insertNode(_el$346, _el$347);
                      _$insert(_el$346, () => summary().effectiveMode, null);
                      return _el$346;
                    }
                  }), _$createComponent(Show, {
                    get when() {
                      return summary().operation;
                    },
                    get children() {
                      var _el$348 = _$createElement("text"), _el$349 = _$createTextNode(`Operation: `);
                      _$insertNode(_el$348, _el$349);
                      _$insert(_el$348, () => summary().operation.status, null);
                      return _el$348;
                    }
                  }), _$memo(() => reactiveChild(() => selected().audit.map((entry) => (() => {
                    var _el$374 = _$createElement("text"), _el$375 = _$createTextNode(`: `);
                    _$insertNode(_el$374, _el$375);
                    _$setProp(_el$374, "wrapMode", "word");
                    _$insert(_el$374, () => entry.kind, _el$375);
                    _$insert(_el$374, () => entry.summary, null);
                    return _el$374;
                  })())))];
                }
              })]
            }), _el$287);
            _$insert(_el$277, _$createComponent(Show, {
              get when() {
                return selected().actions.some((action) => ["reject-proposal", "reject"].includes(action.action) && action.feedbackSupported);
              },
              get children() {
                var _el$282 = _$createElement("box"), _el$283 = _$createElement("text"), _el$285 = _$createElement("box");
                _$insertNode(_el$282, _el$283);
                _$insertNode(_el$282, _el$285);
                _$setProp(_el$282, "flexDirection", "column");
                _$insertNode(_el$283, _$createTextNode(`Optional rejection feedback (audit-only)`));
                _$setProp(_el$285, "flexDirection", "row");
                _$setProp(_el$285, "gap", 1);
                _$setProp(_el$285, "flexWrap", "wrap");
                _$insert(_el$285, () => reactiveChild(() => recommendations().rejectionFeedbackOptions.map((option) => (() => {
                  var _el$376 = _$createElement("box"), _el$377 = _$createElement("text");
                  _$insertNode(_el$376, _el$377);
                  _$setProp(_el$376, "focusable", true);
                  _$setProp(_el$376, "border", true);
                  _$setProp(_el$376, "paddingLeft", 1);
                  _$setProp(_el$376, "paddingRight", 1);
                  _$setProp(_el$376, "on:focused", () => setFocusedControl(`rejection:${option.value}`));
                  _$setProp(_el$376, "on:blurred", () => setFocusedControl((current) => current === `rejection:${option.value}` ? null : current));
                  _$setProp(_el$376, "onMouseUp", () => setRejectionReason(rejectionReason() === option.value ? null : option.value));
                  _$setProp(_el$376, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setRejectionReason(rejectionReason() === option.value ? null : option.value);
                  });
                  _$insert(_el$377, () => focusMark(`rejection:${option.value}`), null);
                  _$insert(_el$377, () => option.label, null);
                  _$effect((_$p) => _$setProp(_el$376, "borderColor", rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                  return _el$376;
                })())));
                _$insert(_el$282, _$createComponent(Show, {
                  get when() {
                    return rejectionReason() === "other";
                  },
                  get children() {
                    var _el$286 = _$createElement("input");
                    _$setProp(_el$286, "placeholder", "Optional bounded reason (512 characters)");
                    _$setProp(_el$286, "onInput", (value) => setRejectionText(value.slice(0, 512)));
                    _$effect((_$p) => _$setProp(_el$286, "value", rejectionText(), _$p));
                    return _el$286;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$283, "fg", props.api.theme.current.textMuted, _$p));
                return _el$282;
              }
            }), _el$287);
            _$insertNode(_el$287, _el$288);
            _$setProp(_el$287, "flexDirection", "row");
            _$setProp(_el$287, "gap", 1);
            _$setProp(_el$287, "flexWrap", "wrap");
            _$insert(_el$287, () => reactiveChild(() => selected().actions.flatMap((action) => {
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
                  var _el$378 = _$createElement("box"), _el$379 = _$createElement("text");
                  _$insertNode(_el$378, _el$379);
                  _$setProp(_el$378, "border", true);
                  _$setProp(_el$378, "paddingLeft", 1);
                  _$setProp(_el$378, "paddingRight", 1);
                  _$setProp(_el$378, "on:focused", () => setFocusedControl(`recommendation-action:${key}`));
                  _$setProp(_el$378, "on:blurred", () => setFocusedControl((current) => current === `recommendation-action:${key}` ? null : current));
                  _$setProp(_el$378, "onMouseUp", () => {
                    if (!action.pending)
                      activateRecommendation(action.action, choice.delay);
                  });
                  _$setProp(_el$378, "onKeyDown", (event) => {
                    if (!isActivationKey(event) || action.pending)
                      return;
                    event.preventDefault();
                    activateRecommendation(action.action, choice.delay);
                  });
                  _$insert(_el$379, () => focusMark(`recommendation-action:${key}`), null);
                  _$insert(_el$379, (() => {
                    var _c$11 = _$memo(() => !!action.pending);
                    return () => _c$11() ? `${choice.label} \xB7 Pending` : _$memo(() => confirmation() === key)() ? `Confirm ${choice.label}` : choice.label;
                  })(), null);
                  _$effect((_p$) => {
                    var _v$62 = !action.pending, _v$63 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$64 = action.pending ? props.api.theme.current.textMuted : props.api.theme.current.text;
                    _v$62 !== _p$.e && (_p$.e = _$setProp(_el$378, "focusable", _v$62, _p$.e));
                    _v$63 !== _p$.t && (_p$.t = _$setProp(_el$378, "borderColor", _v$63, _p$.t));
                    _v$64 !== _p$.a && (_p$.a = _$setProp(_el$379, "fg", _v$64, _p$.a));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined,
                    a: undefined
                  });
                  return _el$378;
                })();
              });
            })), _el$288);
            _$insertNode(_el$288, _el$289);
            _$setProp(_el$288, "focusable", true);
            _$setProp(_el$288, "border", true);
            _$setProp(_el$288, "paddingLeft", 1);
            _$setProp(_el$288, "paddingRight", 1);
            _$setProp(_el$288, "on:focused", () => setFocusedControl("recommendation:open-activity"));
            _$setProp(_el$288, "on:blurred", () => setFocusedControl((current) => current === "recommendation:open-activity" ? null : current));
            _$setProp(_el$288, "onMouseUp", () => void activateRecommendation("open-activity"));
            _$setProp(_el$288, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              activateRecommendation("open-activity");
            });
            _$insertNode(_el$289, _el$290);
            _$insert(_el$289, () => focusMark("recommendation:open-activity"), _el$290);
            _$insert(_el$277, _$createComponent(Show, {
              get when() {
                return pendingRecommendation();
              },
              get children() {
                var _el$291 = _$createElement("text");
                _$insertNode(_el$291, _$createTextNode(`Request pending server validation\u2026`));
                _$effect((_$p) => _$setProp(_el$291, "fg", props.api.theme.current.info, _$p));
                return _el$291;
              }
            }), null);
            _$effect((_p$) => {
              var _v$60 = props.api.theme.current.borderActive, _v$61 = props.api.theme.current.borderSubtle;
              _v$60 !== _p$.e && (_p$.e = _$setProp(_el$277, "borderColor", _v$60, _p$.e));
              _v$61 !== _p$.t && (_p$.t = _$setProp(_el$288, "borderColor", _v$61, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$277;
          })()
        }), null);
        return _el$73;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "activity";
      },
      get children() {
        var _el$82 = _$createElement("box"), _el$83 = _$createElement("text"), _el$84 = _$createElement("b"), _el$86 = _$createElement("box"), _el$89 = _$createElement("box"), _el$90 = _$createElement("text"), _el$91 = _$createTextNode(`Diagnostics `);
        _$insertNode(_el$82, _el$83);
        _$insertNode(_el$82, _el$86);
        _$insertNode(_el$82, _el$89);
        _$setProp(_el$82, "flexDirection", "column");
        _$setProp(_el$82, "gap", 1);
        _$insertNode(_el$83, _el$84);
        _$insertNode(_el$84, _$createTextNode(`Activity`));
        _$setProp(_el$86, "flexDirection", "row");
        _$setProp(_el$86, "gap", 1);
        _$setProp(_el$86, "flexWrap", "wrap");
        _$insert(_el$86, () => [["all", "All"], ["recommendations", "Recommendations"], ["system", "System"], ["errors", "Errors"]].map(([value, label]) => (() => {
          var _el$380 = _$createElement("box"), _el$381 = _$createElement("text");
          _$insertNode(_el$380, _el$381);
          _$setProp(_el$380, "focusable", true);
          _$setProp(_el$380, "border", true);
          _$setProp(_el$380, "paddingLeft", 1);
          _$setProp(_el$380, "paddingRight", 1);
          _$setProp(_el$380, "on:focused", () => setFocusedControl(`activity-filter:${value}`));
          _$setProp(_el$380, "on:blurred", () => setFocusedControl((current) => current === `activity-filter:${value}` ? null : current));
          _$setProp(_el$380, "onMouseUp", () => {
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$setProp(_el$380, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setActivityFilter(value);
            setActivityExpanded(null);
            setActivityIndex(0);
          });
          _$insert(_el$381, () => focusMark(`activity-filter:${value}`), null);
          _$insert(_el$381, label, null);
          _$effect((_p$) => {
            var _v$65 = focusId(`activity-filter:${value}`), _v$66 = activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$65 !== _p$.e && (_p$.e = _$setProp(_el$380, "id", _v$65, _p$.e));
            _v$66 !== _p$.t && (_p$.t = _$setProp(_el$380, "borderColor", _v$66, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$380;
        })()));
        _$insert(_el$82, _$createComponent(Show, {
          get when() {
            return activity().emptyState;
          },
          get children() {
            var _el$87 = _$createElement("text");
            _$setProp(_el$87, "wrapMode", "word");
            _$insert(_el$87, () => activity().emptyState);
            return _el$87;
          }
        }), _el$89);
        _$insert(_el$82, () => reactiveChild(() => activity().activity.map((entry, index) => (() => {
          var _el$382 = _$createElement("box"), _el$383 = _$createElement("text"), _el$384 = _$createTextNode(`[`), _el$385 = _$createTextNode(`] [`), _el$386 = _$createTextNode(`] `), _el$387 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$382, _el$383);
          _$use((value) => activityNodes.set(index, value), _el$382);
          _$setProp(_el$382, "focusable", true);
          _$setProp(_el$382, "border", true);
          _$setProp(_el$382, "paddingLeft", 1);
          _$setProp(_el$382, "paddingRight", 1);
          _$setProp(_el$382, "flexDirection", "column");
          _$setProp(_el$382, "on:focused", () => {
            setFocusedControl(`activity-row:${index}`);
            setActivityIndex(index);
          });
          _$setProp(_el$382, "on:blurred", () => setFocusedControl((current) => current === `activity-row:${index}` ? null : current));
          _$setProp(_el$382, "onMouseUp", () => {
            setActivityIndex(index);
            activityNodes.get(index)?.focus();
            setActivityExpanded(activityExpanded() === index ? null : index);
          });
          _$setProp(_el$382, "onKeyDown", (event) => {
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
          _$insertNode(_el$383, _el$384);
          _$insertNode(_el$383, _el$385);
          _$insertNode(_el$383, _el$386);
          _$insertNode(_el$383, _el$387);
          _$setProp(_el$383, "wrapMode", "word");
          _$insert(_el$383, () => focusMark(`activity-row:${index}`), _el$384);
          _$insert(_el$383, () => entry.marker, _el$385);
          _$insert(_el$383, () => entry.scope, _el$386);
          _$insert(_el$383, () => entry.summary, _el$387);
          _$insert(_el$383, () => relativeTime(entry.occurredAt), null);
          _$insert(_el$382, _$createComponent(Show, {
            get when() {
              return entry.target;
            },
            get children() {
              var _el$388 = _$createElement("text"), _el$389 = _$createTextNode(`Skill: `);
              _$insertNode(_el$388, _el$389);
              _$insert(_el$388, () => entry.target, null);
              _$effect((_$p) => _$setProp(_el$388, "fg", props.api.theme.current.textMuted, _$p));
              return _el$388;
            }
          }), null);
          _$insert(_el$382, _$createComponent(Show, {
            get when() {
              return activityExpanded() === index;
            },
            get children() {
              return [(() => {
                var _el$390 = _$createElement("text"), _el$391 = _$createTextNode(`Category: `);
                _$insertNode(_el$390, _el$391);
                _$insert(_el$390, () => entry.technical.category, null);
                _$effect((_$p) => _$setProp(_el$390, "fg", props.api.theme.current.textMuted, _$p));
                return _el$390;
              })(), (() => {
                var _el$392 = _$createElement("text"), _el$393 = _$createTextNode(`Outcome: `);
                _$insertNode(_el$392, _el$393);
                _$insert(_el$392, () => entry.technical.outcome.replaceAll("-", " "), null);
                _$effect((_$p) => _$setProp(_el$392, "fg", props.api.theme.current.textMuted, _$p));
                return _el$392;
              })(), _$createComponent(Show, {
                get when() {
                  return entry.technical.reason;
                },
                children: (reason) => (() => {
                  var _el$397 = _$createElement("text"), _el$398 = _$createTextNode(`Reason: `);
                  _$insertNode(_el$397, _el$398);
                  _$insert(_el$397, () => reason().replaceAll("-", " "), null);
                  _$effect((_$p) => _$setProp(_el$397, "fg", props.api.theme.current.textMuted, _$p));
                  return _el$397;
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
                  var _el$394 = _$createElement("box"), _el$395 = _$createElement("text"), _el$396 = _$createTextNode(`Open recommendation`);
                  _$insertNode(_el$394, _el$395);
                  _$setProp(_el$394, "focusable", true);
                  _$setProp(_el$394, "border", true);
                  _$setProp(_el$394, "paddingLeft", 1);
                  _$setProp(_el$394, "paddingRight", 1);
                  _$setProp(_el$394, "on:focused", () => setFocusedControl(`activity-open:${index}`));
                  _$setProp(_el$394, "on:blurred", () => setFocusedControl((current) => current === `activity-open:${index}` ? null : current));
                  _$setProp(_el$394, "onMouseUp", () => openActivityDestination(entry));
                  _$setProp(_el$394, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    openActivityDestination(entry);
                  });
                  _$insertNode(_el$395, _el$396);
                  _$insert(_el$395, () => focusMark(`activity-open:${index}`), _el$396);
                  _$effect((_$p) => _$setProp(_el$394, "borderColor", props.api.theme.current.borderSubtle, _$p));
                  return _el$394;
                }
              })];
            }
          }), null);
          _$effect((_p$) => {
            var _v$67 = focusId(`activity-row:${index}`), _v$68 = activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
            _v$67 !== _p$.e && (_p$.e = _$setProp(_el$382, "id", _v$67, _p$.e));
            _v$68 !== _p$.t && (_p$.t = _$setProp(_el$382, "borderColor", _v$68, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$382;
        })())), _el$89);
        _$insert(_el$82, _$createComponent(Show, {
          get when() {
            return activity().overflowMessage;
          },
          get children() {
            var _el$88 = _$createElement("text");
            _$setProp(_el$88, "wrapMode", "word");
            _$insert(_el$88, () => activity().overflowMessage);
            _$effect((_$p) => _$setProp(_el$88, "fg", props.api.theme.current.warning, _$p));
            return _el$88;
          }
        }), _el$89);
        _$insertNode(_el$89, _el$90);
        _$setProp(_el$89, "focusable", true);
        _$setProp(_el$89, "border", true);
        _$setProp(_el$89, "paddingLeft", 1);
        _$setProp(_el$89, "paddingRight", 1);
        _$setProp(_el$89, "on:focused", () => setFocusedControl("activity:diagnostics"));
        _$setProp(_el$89, "on:blurred", () => setFocusedControl((current) => current === "activity:diagnostics" ? null : current));
        _$setProp(_el$89, "onMouseUp", () => setDiagnosticsExpanded((value) => !value));
        _$setProp(_el$89, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setDiagnosticsExpanded((value) => !value);
        });
        _$insertNode(_el$90, _el$91);
        _$insert(_el$90, () => focusMark("activity:diagnostics"), _el$91);
        _$insert(_el$90, () => diagnosticsExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$82, _$createComponent(Show, {
          get when() {
            return diagnosticsExpanded();
          },
          get children() {
            var _el$92 = _$createElement("box"), _el$93 = _$createElement("text"), _el$94 = _$createTextNode(`Projection refreshed: `), _el$95 = _$createElement("text"), _el$96 = _$createTextNode(`Core projection: `), _el$97 = _$createElement("text"), _el$98 = _$createTextNode(`Enhanced projection: `), _el$99 = _$createElement("text"), _el$100 = _$createTextNode(`Global projection: `), _el$101 = _$createTextNode(` (`), _el$102 = _$createTextNode(`)`), _el$103 = _$createElement("text"), _el$104 = _$createTextNode(`OpenCode: `), _el$105 = _$createTextNode(` (`), _el$106 = _$createTextNode(`)`), _el$107 = _$createElement("text"), _el$108 = _$createTextNode(`Self-evolve: `), _el$109 = _$createElement("text"), _el$110 = _$createTextNode(`Projection protocol: `), _el$111 = _$createElement("text"), _el$112 = _$createTextNode(`Dashboard protocol: `), _el$113 = _$createElement("text"), _el$114 = _$createTextNode(`Refresh watcher: `), _el$115 = _$createElement("text"), _el$116 = _$createTextNode(`Circuit breaker: `);
            _$insertNode(_el$92, _el$93);
            _$insertNode(_el$92, _el$95);
            _$insertNode(_el$92, _el$97);
            _$insertNode(_el$92, _el$99);
            _$insertNode(_el$92, _el$103);
            _$insertNode(_el$92, _el$107);
            _$insertNode(_el$92, _el$109);
            _$insertNode(_el$92, _el$111);
            _$insertNode(_el$92, _el$113);
            _$insertNode(_el$92, _el$115);
            _$setProp(_el$92, "flexDirection", "column");
            _$insertNode(_el$93, _el$94);
            _$setProp(_el$93, "wrapMode", "word");
            _$insert(_el$93, (() => {
              var _c$4 = _$memo(() => !!activity().diagnostics.refreshedAt);
              return () => _c$4() ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable";
            })(), null);
            _$insertNode(_el$95, _el$96);
            _$setProp(_el$95, "wrapMode", "word");
            _$insert(_el$95, () => activity().diagnostics.coreProjection, null);
            _$insertNode(_el$97, _el$98);
            _$setProp(_el$97, "wrapMode", "word");
            _$insert(_el$97, () => activity().diagnostics.enhancedProjection, null);
            _$insertNode(_el$99, _el$100);
            _$insertNode(_el$99, _el$101);
            _$insertNode(_el$99, _el$102);
            _$setProp(_el$99, "wrapMode", "word");
            _$insert(_el$99, () => activity().diagnostics.globalProjection, _el$101);
            _$insert(_el$99, () => activity().diagnostics.globalProtocolLabel ?? "Unavailable", _el$102);
            _$insertNode(_el$103, _el$104);
            _$insertNode(_el$103, _el$105);
            _$insertNode(_el$103, _el$106);
            _$setProp(_el$103, "wrapMode", "word");
            _$insert(_el$103, () => activity().diagnostics.runtime.hostVersion, _el$105);
            _$insert(_el$103, () => activity().diagnostics.runtime.hostVersionSource, _el$106);
            _$insertNode(_el$107, _el$108);
            _$setProp(_el$107, "wrapMode", "word");
            _$insert(_el$107, () => activity().diagnostics.runtime.pluginVersion, null);
            _$insertNode(_el$109, _el$110);
            _$setProp(_el$109, "wrapMode", "word");
            _$insert(_el$109, () => activity().diagnostics.runtime.projectionVersion ?? "Unavailable", null);
            _$insertNode(_el$111, _el$112);
            _$setProp(_el$111, "wrapMode", "word");
            _$insert(_el$111, () => activity().diagnostics.runtime.dashboardVersion ?? "Unavailable", null);
            _$insertNode(_el$113, _el$114);
            _$setProp(_el$113, "wrapMode", "word");
            _$insert(_el$113, () => activity().diagnostics.watcherStatus, null);
            _$insertNode(_el$115, _el$116);
            _$setProp(_el$115, "wrapMode", "word");
            _$insert(_el$115, () => activity().diagnostics.breakerStatus, null);
            _$insert(_el$92, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.automation;
              },
              children: (automation) => (() => {
                var _el$399 = _$createElement("text"), _el$400 = _$createTextNode(`Scheduler: `);
                _$insertNode(_el$399, _el$400);
                _$setProp(_el$399, "wrapMode", "word");
                _$insert(_el$399, () => automation().state.replaceAll("-", " "), null);
                return _el$399;
              })()
            }), null);
            _$insert(_el$92, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.backoffUntil;
              },
              children: (backoffUntil) => (() => {
                var _el$401 = _$createElement("text"), _el$402 = _$createTextNode(`Backoff ends: `);
                _$insertNode(_el$401, _el$402);
                _$setProp(_el$401, "wrapMode", "word");
                _$insert(_el$401, () => new Date(backoffUntil()).toISOString(), null);
                return _el$401;
              })()
            }), null);
            _$insert(_el$92, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.nextEligibleAt;
              },
              children: (nextEligibleAt) => (() => {
                var _el$403 = _$createElement("text"), _el$404 = _$createTextNode(`Next eligible: `);
                _$insertNode(_el$403, _el$404);
                _$setProp(_el$403, "wrapMode", "word");
                _$insert(_el$403, () => new Date(nextEligibleAt()).toISOString(), null);
                return _el$403;
              })()
            }), null);
            _$insert(_el$92, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.usage;
              },
              children: (usage) => [(() => {
                var _el$405 = _$createElement("text"), _el$406 = _$createTextNode(`Background analysis used/remaining: `), _el$407 = _$createTextNode(` / `);
                _$insertNode(_el$405, _el$406);
                _$insertNode(_el$405, _el$407);
                _$setProp(_el$405, "wrapMode", "word");
                _$insert(_el$405, () => usage().passive.used, _el$407);
                _$insert(_el$405, () => usage().passive.remaining, null);
                return _el$405;
              })(), (() => {
                var _el$408 = _$createElement("text"), _el$409 = _$createTextNode(`Recommendation synthesis used/remaining: `), _el$410 = _$createTextNode(` / `);
                _$insertNode(_el$408, _el$409);
                _$insertNode(_el$408, _el$410);
                _$setProp(_el$408, "wrapMode", "word");
                _$insert(_el$408, () => usage().synthesis.used, _el$410);
                _$insert(_el$408, () => usage().synthesis.remaining, null);
                return _el$408;
              })(), (() => {
                var _el$411 = _$createElement("text"), _el$412 = _$createTextNode(`Storage used/quota: `), _el$413 = _$createTextNode(` / `), _el$414 = _$createTextNode(` bytes`);
                _$insertNode(_el$411, _el$412);
                _$insertNode(_el$411, _el$413);
                _$insertNode(_el$411, _el$414);
                _$setProp(_el$411, "wrapMode", "word");
                _$insert(_el$411, () => usage().storage.usedBytes, _el$413);
                _$insert(_el$411, () => usage().storage.limitBytes, _el$414);
                return _el$411;
              })(), _$createComponent(Show, {
                get when() {
                  return activity().diagnostics.budgetResetAt;
                },
                children: (budgetResetAt) => [(() => {
                  var _el$415 = _$createElement("text"), _el$416 = _$createTextNode(`Background analysis resets: `);
                  _$insertNode(_el$415, _el$416);
                  _$setProp(_el$415, "wrapMode", "word");
                  _$insert(_el$415, () => new Date(budgetResetAt().passive).toISOString(), null);
                  return _el$415;
                })(), (() => {
                  var _el$417 = _$createElement("text"), _el$418 = _$createTextNode(`Recommendation synthesis resets: `);
                  _$insertNode(_el$417, _el$418);
                  _$setProp(_el$417, "wrapMode", "word");
                  _$insert(_el$417, () => new Date(budgetResetAt().synthesis).toISOString(), null);
                  return _el$417;
                })()]
              })]
            }), null);
            _$insert(_el$92, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.lastError;
              },
              children: (lastError) => (() => {
                var _el$419 = _$createElement("text"), _el$420 = _$createTextNode(`Last bounded error: `);
                _$insertNode(_el$419, _el$420);
                _$setProp(_el$419, "wrapMode", "word");
                _$insert(_el$419, () => lastError().summary, null);
                return _el$419;
              })()
            }), null);
            return _el$92;
          }
        }), null);
        _$effect((_p$) => {
          var _v$27 = focusId("activity:diagnostics"), _v$28 = diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle;
          _v$27 !== _p$.e && (_p$.e = _$setProp(_el$89, "id", _v$27, _p$.e));
          _v$28 !== _p$.t && (_p$.t = _$setProp(_el$89, "borderColor", _v$28, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$82;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return section() === "settings";
      },
      get children() {
        var _el$117 = _$createElement("box"), _el$118 = _$createElement("text"), _el$119 = _$createElement("b"), _el$124 = _$createElement("text"), _el$125 = _$createElement("b"), _el$127 = _$createElement("text"), _el$128 = _$createTextNode(`Configured analysis: `), _el$129 = _$createElement("text"), _el$130 = _$createTextNode(`Operational state: `), _el$131 = _$createElement("text"), _el$132 = _$createTextNode(`Installation default: `), _el$133 = _$createElement("text"), _el$134 = _$createTextNode(`This project override: `), _el$135 = _$createElement("text"), _el$143 = _$createElement("text"), _el$144 = _$createElement("b"), _el$146 = _$createElement("box"), _el$147 = _$createElement("text"), _el$148 = _$createElement("b"), _el$150 = _$createTextNode(`: `), _el$151 = _$createElement("text"), _el$153 = _$createElement("text"), _el$154 = _$createTextNode(`Pause automatic work: `), _el$155 = _$createTextNode(`. Pause preserves modes and consent.`), _el$156 = _$createElement("text"), _el$157 = _$createTextNode(`Emergency stop: `), _el$158 = _$createTextNode(`. It overrides every automatic provider and write path.`), _el$159 = _$createElement("text"), _el$160 = _$createElement("b"), _el$162 = _$createElement("text"), _el$174 = _$createElement("text"), _el$175 = _$createElement("b"), _el$177 = _$createElement("text"), _el$179 = _$createElement("text"), _el$180 = _$createElement("b"), _el$182 = _$createElement("text"), _el$184 = _$createElement("box"), _el$185 = _$createElement("text"), _el$186 = _$createElement("box"), _el$193 = _$createElement("text"), _el$194 = _$createTextNode(`OpenCode `), _el$195 = _$createTextNode(` \xB7 Self-evolve `), _el$196 = _$createTextNode(` \xB7 Projection `), _el$197 = _$createTextNode(` \xB7 Dashboard `), _el$198 = _$createElement("text");
        _$insertNode(_el$117, _el$118);
        _$insertNode(_el$117, _el$124);
        _$insertNode(_el$117, _el$127);
        _$insertNode(_el$117, _el$129);
        _$insertNode(_el$117, _el$131);
        _$insertNode(_el$117, _el$133);
        _$insertNode(_el$117, _el$135);
        _$insertNode(_el$117, _el$143);
        _$insertNode(_el$117, _el$146);
        _$insertNode(_el$117, _el$153);
        _$insertNode(_el$117, _el$156);
        _$insertNode(_el$117, _el$159);
        _$insertNode(_el$117, _el$162);
        _$insertNode(_el$117, _el$174);
        _$insertNode(_el$117, _el$177);
        _$insertNode(_el$117, _el$179);
        _$insertNode(_el$117, _el$182);
        _$insertNode(_el$117, _el$184);
        _$insertNode(_el$117, _el$185);
        _$insertNode(_el$117, _el$186);
        _$insertNode(_el$117, _el$193);
        _$insertNode(_el$117, _el$198);
        _$setProp(_el$117, "flexDirection", "column");
        _$setProp(_el$117, "gap", 1);
        _$insertNode(_el$118, _el$119);
        _$insertNode(_el$119, _$createTextNode(`Settings`));
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settingsAnchor();
          },
          children: (anchor) => (() => {
            var _el$421 = _$createElement("box"), _el$422 = _$createElement("text"), _el$423 = _$createTextNode(`Opened at `), _el$424 = _$createTextNode(` settings.`);
            _$insertNode(_el$421, _el$422);
            _$setProp(_el$421, "focusable", true);
            _$setProp(_el$421, "border", true);
            _$setProp(_el$421, "paddingLeft", 1);
            _$setProp(_el$421, "paddingRight", 1);
            _$setProp(_el$421, "on:focused", () => setFocusedControl(`anchor:${anchor()}`));
            _$setProp(_el$421, "on:blurred", () => setFocusedControl((current) => current === `anchor:${anchor()}` ? null : current));
            _$insertNode(_el$422, _el$423);
            _$insertNode(_el$422, _el$424);
            _$setProp(_el$422, "wrapMode", "word");
            _$insert(_el$422, () => focusMark(`anchor:${anchor()}`), _el$423);
            _$insert(_el$422, () => anchor().replaceAll("-", " "), _el$424);
            _$effect((_p$) => {
              var _v$69 = focusId(`anchor:${anchor()}`), _v$70 = focusedControl() === `anchor:${anchor()}` ? props.api.theme.current.borderActive : props.api.theme.current.info, _v$71 = props.api.theme.current.info;
              _v$69 !== _p$.e && (_p$.e = _$setProp(_el$421, "id", _v$69, _p$.e));
              _v$70 !== _p$.t && (_p$.t = _$setProp(_el$421, "borderColor", _v$70, _p$.t));
              _v$71 !== _p$.a && (_p$.a = _$setProp(_el$422, "fg", _v$71, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$421;
          })()
        }), _el$124);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().limited;
          },
          get children() {
            var _el$121 = _$createElement("text");
            _$insertNode(_el$121, _$createTextNode(`Limited view: enhanced usage, repository-mode editing, and prerequisite status require an aligned server.`));
            _$setProp(_el$121, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$121, "fg", props.api.theme.current.warning, _$p));
            return _el$121;
          }
        }), _el$124);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().enhancedError;
          },
          get children() {
            var _el$123 = _$createElement("text");
            _$setProp(_el$123, "wrapMode", "word");
            _$insert(_el$123, () => settings().enhancedError);
            _$effect((_$p) => _$setProp(_el$123, "fg", props.api.theme.current.error, _$p));
            return _el$123;
          }
        }), _el$124);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().globalProtocol;
          },
          children: (globalProtocol) => (() => {
            var _el$425 = _$createElement("text"), _el$426 = _$createTextNode(`Global protocol: `), _el$427 = _$createTextNode(` \xB7 `);
            _$insertNode(_el$425, _el$426);
            _$insertNode(_el$425, _el$427);
            _$setProp(_el$425, "wrapMode", "word");
            _$insert(_el$425, () => globalProtocol().label, _el$427);
            _$insert(_el$425, () => globalProtocol().authoritative ? "authoritative" : "limited / read-only", null);
            _$effect((_$p) => _$setProp(_el$425, "fg", globalProtocol().authoritative ? props.api.theme.current.textMuted : props.api.theme.current.warning, _$p));
            return _el$425;
          })()
        }), _el$124);
        _$insertNode(_el$124, _el$125);
        _$insertNode(_el$125, _$createTextNode(`Project analysis`));
        _$insertNode(_el$127, _el$128);
        _$setProp(_el$127, "wrapMode", "word");
        _$insert(_el$127, () => settings().mode.effective.label, null);
        _$insertNode(_el$129, _el$130);
        _$setProp(_el$129, "wrapMode", "word");
        _$insert(_el$129, () => model().operational.label, null);
        _$insertNode(_el$131, _el$132);
        _$setProp(_el$131, "wrapMode", "word");
        _$insert(_el$131, () => settings().mode.global.label, null);
        _$insertNode(_el$133, _el$134);
        _$setProp(_el$133, "wrapMode", "word");
        _$insert(_el$133, () => settings().mode.repository.label, null);
        _$insertNode(_el$135, _$createTextNode(`Pause, exclusion, and other temporary suppressors do not rewrite configured analysis. \u201CUse for this project\u201D creates an override here only.`));
        _$setProp(_el$135, "wrapMode", "word");
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!settings().controls.globalMode)() && modeRank(settings().mode.global.value) < modeRank("auto");
          },
          get children() {
            var _el$137 = _$createElement("box"), _el$138 = _$createElement("text"), _el$139 = _$createElement("b"), _el$141 = _$createElement("text");
            _$insertNode(_el$137, _el$138);
            _$insertNode(_el$137, _el$141);
            _$setProp(_el$137, "border", true);
            _$setProp(_el$137, "paddingLeft", 1);
            _$setProp(_el$137, "paddingRight", 1);
            _$setProp(_el$137, "flexDirection", "column");
            _$setProp(_el$137, "gap", 1);
            _$insertNode(_el$138, _el$139);
            _$insertNode(_el$139, _$createTextNode(`Automatic recommendations setup`));
            _$insertNode(_el$141, _$createTextNode(`This confirmation changes only the global mode. Background AI analysis, saved structured patterns, and sanitized excerpts remain separate consent choices below.`));
            _$setProp(_el$141, "wrapMode", "word");
            _$insert(_el$137, () => actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true, {
              action: "set-mode",
              subject: "global-mode"
            }), null);
            _$effect((_$p) => _$setProp(_el$137, "borderColor", props.api.theme.current.info, _$p));
            return _el$137;
          }
        }), _el$143);
        _$insert(_el$117, () => reactiveChild(() => settings().modes.map((mode) => (() => {
          var _el$428 = _$createElement("box"), _el$429 = _$createElement("text"), _el$430 = _$createElement("b"), _el$431 = _$createElement("text"), _el$432 = _$createElement("text"), _el$433 = _$createTextNode(`Provider use: `), _el$434 = _$createElement("text"), _el$435 = _$createTextNode(`Saved data: `), _el$436 = _$createElement("text"), _el$437 = _$createTextNode(`Write authority: `), _el$438 = _$createElement("text"), _el$439 = _$createTextNode(`Prerequisites: `);
          _$insertNode(_el$428, _el$429);
          _$insertNode(_el$428, _el$431);
          _$insertNode(_el$428, _el$432);
          _$insertNode(_el$428, _el$434);
          _$insertNode(_el$428, _el$436);
          _$insertNode(_el$428, _el$438);
          _$setProp(_el$428, "border", true);
          _$setProp(_el$428, "paddingLeft", 1);
          _$setProp(_el$428, "paddingRight", 1);
          _$setProp(_el$428, "flexDirection", "column");
          _$insertNode(_el$429, _el$430);
          _$insert(_el$430, () => mode.label);
          _$insert(_el$429, () => settings().mode.effective.value === mode.value ? " \xB7 Effective now" : "", null);
          _$setProp(_el$431, "wrapMode", "word");
          _$insert(_el$431, () => mode.description);
          _$insertNode(_el$432, _el$433);
          _$setProp(_el$432, "wrapMode", "word");
          _$insert(_el$432, () => mode.providerUse, null);
          _$insertNode(_el$434, _el$435);
          _$setProp(_el$434, "wrapMode", "word");
          _$insert(_el$434, () => mode.savedData, null);
          _$insertNode(_el$436, _el$437);
          _$setProp(_el$436, "wrapMode", "word");
          _$insert(_el$436, () => mode.writeAuthority, null);
          _$insertNode(_el$438, _el$439);
          _$setProp(_el$438, "wrapMode", "word");
          _$insert(_el$438, () => mode.prerequisites, null);
          _$insert(_el$428, _$createComponent(Show, {
            get when() {
              return mode.blockers.length;
            },
            get children() {
              return reactiveChild(() => mode.blockers.map((blocker) => (() => {
                var _el$441 = _$createElement("text"), _el$442 = _$createTextNode(`\u2022 `);
                _$insertNode(_el$441, _el$442);
                _$setProp(_el$441, "wrapMode", "word");
                _$insert(_el$441, blocker, null);
                _$effect((_$p) => _$setProp(_el$441, "fg", props.api.theme.current.warning, _$p));
                return _el$441;
              })()));
            }
          }), null);
          _$insert(_el$428, _$createComponent(Show, {
            get when() {
              return mode.available;
            },
            get children() {
              var _el$440 = _$createElement("box");
              _$setProp(_el$440, "flexDirection", "row");
              _$setProp(_el$440, "flexWrap", "wrap");
              _$setProp(_el$440, "gap", 1);
              _$insert(_el$440, _$createComponent(Show, {
                get when() {
                  return settings().controls.globalMode;
                },
                get children() {
                  return localActionButton(settings().mode.global.value === mode.value ? "Global default \u2713" : "Set global default", () => submitMode("global", mode.value), mode.value === "auto", `global-mode-${mode.value}`, {
                    action: "set-mode",
                    subject: "global-mode"
                  });
                }
              }), null);
              _$insert(_el$440, _$createComponent(Show, {
                get when() {
                  return settings().controls.repositoryMode;
                },
                get children() {
                  return localActionButton(settings().mode.repository.value === mode.value ? "This project \u2713" : "Use for this project", () => submitMode("project", mode.value), mode.value === "auto", `project-mode-${mode.value}`, {
                    action: "set-repo-mode",
                    subject: "repository-mode"
                  });
                }
              }), null);
              return _el$440;
            }
          }), null);
          _$effect((_p$) => {
            var _v$72 = props.api.theme.current.borderSubtle, _v$73 = props.api.theme.current.textMuted, _v$74 = props.api.theme.current.textMuted, _v$75 = props.api.theme.current.textMuted, _v$76 = props.api.theme.current.textMuted;
            _v$72 !== _p$.e && (_p$.e = _$setProp(_el$428, "borderColor", _v$72, _p$.e));
            _v$73 !== _p$.t && (_p$.t = _$setProp(_el$432, "fg", _v$73, _p$.t));
            _v$74 !== _p$.a && (_p$.a = _$setProp(_el$434, "fg", _v$74, _p$.a));
            _v$75 !== _p$.o && (_p$.o = _$setProp(_el$436, "fg", _v$75, _p$.o));
            _v$76 !== _p$.i && (_p$.i = _$setProp(_el$438, "fg", _v$76, _p$.i));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined
          });
          return _el$428;
        })())), _el$143);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().controls.repositoryMode;
          },
          get children() {
            return localActionButton(settings().mode.repository.value === "inherit" ? "Inherit global default \u2713" : "Make this project inherit global default", () => submitMode("project", "inherit"), false, "project-mode-inherit", {
              action: "set-repo-mode",
              subject: "repository-mode"
            });
          }
        }), _el$143);
        _$insertNode(_el$143, _el$144);
        _$insertNode(_el$144, _$createTextNode(`Privacy and project scope`));
        _$insertNode(_el$146, _el$147);
        _$insertNode(_el$146, _el$151);
        _$setProp(_el$146, "border", true);
        _$setProp(_el$146, "paddingLeft", 1);
        _$setProp(_el$146, "paddingRight", 1);
        _$setProp(_el$146, "flexDirection", "column");
        _$insertNode(_el$147, _el$148);
        _$insertNode(_el$147, _el$150);
        _$insertNode(_el$148, _$createTextNode(`Include this project`));
        _$insert(_el$147, () => settings().projectExcluded ? "No" : "Yes", null);
        _$insertNode(_el$151, _$createTextNode(`Excluding this project overrides automatic global modes without changing global settings.`));
        _$setProp(_el$151, "wrapMode", "word");
        _$insert(_el$146, _$createComponent(Show, {
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
        _$insert(_el$117, () => reactiveChild(() => settings().consent.map((entry) => (() => {
          var _el$443 = _$createElement("box"), _el$444 = _$createElement("text"), _el$445 = _$createElement("b"), _el$446 = _$createTextNode(`: `), _el$447 = _$createTextNode(` \xB7 `), _el$448 = _$createElement("text"), _el$449 = _$createElement("text");
          _$insertNode(_el$443, _el$444);
          _$insertNode(_el$443, _el$448);
          _$insertNode(_el$443, _el$449);
          _$setProp(_el$443, "border", true);
          _$setProp(_el$443, "paddingLeft", 1);
          _$setProp(_el$443, "paddingRight", 1);
          _$setProp(_el$443, "flexDirection", "column");
          _$insertNode(_el$444, _el$445);
          _$insertNode(_el$444, _el$446);
          _$insertNode(_el$444, _el$447);
          _$insert(_el$445, () => entry.label);
          _$insert(_el$444, () => entry.enabled ? "Allowed" : "Not allowed", _el$447);
          _$insert(_el$444, () => entry.scope, null);
          _$setProp(_el$448, "wrapMode", "word");
          _$insert(_el$448, () => entry.description);
          _$setProp(_el$449, "wrapMode", "word");
          _$insert(_el$449, () => entry.dependency);
          _$insert(_el$443, _$createComponent(Show, {
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
          _$insert(_el$443, () => consentDisclosure(entry.key), null);
          _$insert(_el$443, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!entry.enabled)() && !entry.canEnable;
            },
            get children() {
              var _el$450 = _$createElement("text");
              _$insertNode(_el$450, _$createTextNode(`Resolve the dependency above before enabling this setting.`));
              _$setProp(_el$450, "wrapMode", "word");
              _$effect((_$p) => _$setProp(_el$450, "fg", props.api.theme.current.warning, _$p));
              return _el$450;
            }
          }), null);
          _$effect((_p$) => {
            var _v$77 = props.api.theme.current.borderSubtle, _v$78 = props.api.theme.current.textMuted;
            _v$77 !== _p$.e && (_p$.e = _$setProp(_el$443, "borderColor", _v$77, _p$.e));
            _v$78 !== _p$.t && (_p$.t = _$setProp(_el$449, "fg", _v$78, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$443;
        })())), _el$153);
        _$insertNode(_el$153, _el$154);
        _$insertNode(_el$153, _el$155);
        _$setProp(_el$153, "wrapMode", "word");
        _$insert(_el$153, () => settings().paused ? "Paused" : "Running when eligible", _el$155);
        _$insertNode(_el$156, _el$157);
        _$insertNode(_el$156, _el$158);
        _$setProp(_el$156, "wrapMode", "word");
        _$insert(_el$156, () => settings().emergencyStop ? "On" : "Off", _el$158);
        _$insertNode(_el$159, _el$160);
        _$insertNode(_el$160, _$createTextNode(`Approved global skill folders`));
        _$setProp(_el$162, "wrapMode", "word");
        _$insert(_el$162, () => settings().approvedSkillFolderWarning);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return !settings().globalRoots.length;
          },
          get children() {
            var _el$163 = _$createElement("text");
            _$insertNode(_el$163, _$createTextNode(`No exact approved global root is available in this projection.`));
            _$setProp(_el$163, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$163, "fg", props.api.theme.current.warning, _$p));
            return _el$163;
          }
        }), _el$174);
        _$insert(_el$117, () => reactiveChild(() => settings().globalRoots.map((root, index) => (() => {
          var _el$452 = _$createElement("box"), _el$453 = _$createElement("text"), _el$454 = _$createElement("text"), _el$455 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$452, _el$453);
          _$insertNode(_el$452, _el$454);
          _$setProp(_el$452, "border", true);
          _$setProp(_el$452, "paddingLeft", 1);
          _$setProp(_el$452, "paddingRight", 1);
          _$setProp(_el$452, "flexDirection", "column");
          _$setProp(_el$453, "wrapMode", "word");
          _$insert(_el$453, () => root.canonicalPath);
          _$insertNode(_el$454, _el$455);
          _$setProp(_el$454, "wrapMode", "word");
          _$insert(_el$454, () => root.canUpdate ? "Update" : "No update", _el$455);
          _$insert(_el$454, () => root.canCreate ? "Create" : "No create", null);
          _$insert(_el$454, () => root.primaryCreationRoot ? " \xB7 Primary creation root" : "", null);
          _$insert(_el$452, _$createComponent(Show, {
            get when() {
              return settings().controls.approvedSkillFolders;
            },
            get children() {
              var _el$456 = _$createElement("box");
              _$setProp(_el$456, "flexDirection", "row");
              _$setProp(_el$456, "flexWrap", "wrap");
              _$setProp(_el$456, "gap", 1);
              _$insert(_el$456, () => localActionButton(`Edit ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots), false, undefined, undefined, `edit-root:${index}`), null);
              _$insert(_el$456, () => localActionButton(`Remove ${root.canonicalPath}`, () => stageFolderList(settings().globalRoots.filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `remove-root:${index}`), null);
              return _el$456;
            }
          }), null);
          _$effect((_p$) => {
            var _v$79 = focusId(`root-row:${index}`), _v$80 = props.api.theme.current.borderSubtle, _v$81 = focusId(`root-capabilities:${index}`), _v$82 = props.api.theme.current.textMuted;
            _v$79 !== _p$.e && (_p$.e = _$setProp(_el$452, "id", _v$79, _p$.e));
            _v$80 !== _p$.t && (_p$.t = _$setProp(_el$452, "borderColor", _v$80, _p$.t));
            _v$81 !== _p$.a && (_p$.a = _$setProp(_el$454, "id", _v$81, _p$.a));
            _v$82 !== _p$.o && (_p$.o = _$setProp(_el$454, "fg", _v$82, _p$.o));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined
          });
          return _el$452;
        })())), _el$174);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().collectionSuggestions.length;
          },
          get children() {
            var _el$165 = _$createElement("box"), _el$166 = _$createElement("text"), _el$167 = _$createElement("b");
            _$insertNode(_el$165, _el$166);
            _$setProp(_el$165, "flexDirection", "column");
            _$insertNode(_el$166, _el$167);
            _$insertNode(_el$167, _$createTextNode(`Legacy collection suggestions (no authority)`));
            _$insert(_el$165, () => reactiveChild(() => settings().collectionSuggestions.map((folder) => (() => {
              var _el$457 = _$createElement("text");
              _$setProp(_el$457, "wrapMode", "word");
              _$insert(_el$457, folder);
              return _el$457;
            })())), null);
            return _el$165;
          }
        }), _el$174);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().controls.approvedSkillFolders;
          },
          get children() {
            var _el$169 = _$createElement("box"), _el$170 = _$createElement("text"), _el$172 = _$createElement("input");
            _$insertNode(_el$169, _el$170);
            _$insertNode(_el$169, _el$172);
            _$setProp(_el$169, "flexDirection", "column");
            _$insertNode(_el$170, _$createTextNode(`Add one canonical absolute folder`));
            _$setProp(_el$172, "placeholder", "/canonical/path/to/skills");
            _$setProp(_el$172, "onInput", (value) => {
              setFolderInput(value.slice(0, 4096));
              setFolderError(null);
            });
            _$insert(_el$169, () => localActionButton("Add folder", stageFolderAdd), null);
            _$effect((_p$) => {
              var _v$29 = focusId("root-path-input"), _v$30 = folderInput();
              _v$29 !== _p$.e && (_p$.e = _$setProp(_el$172, "id", _v$29, _p$.e));
              _v$30 !== _p$.t && (_p$.t = _$setProp(_el$172, "value", _v$30, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$169;
          }
        }), _el$174);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return folderError();
          },
          get children() {
            var _el$173 = _$createElement("text");
            _$setProp(_el$173, "wrapMode", "word");
            _$insert(_el$173, folderError);
            _$effect((_$p) => _$setProp(_el$173, "fg", props.api.theme.current.warning, _$p));
            return _el$173;
          }
        }), _el$174);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return folderDraft();
          },
          children: (draft) => (() => {
            var _el$458 = _$createElement("box"), _el$459 = _$createElement("text"), _el$460 = _$createElement("b"), _el$462 = _$createElement("text"), _el$463 = _$createTextNode(`Type exactly: `), _el$464 = _$createElement("input"), _el$465 = _$createElement("box");
            _$insertNode(_el$458, _el$459);
            _$insertNode(_el$458, _el$462);
            _$insertNode(_el$458, _el$464);
            _$insertNode(_el$458, _el$465);
            _$setProp(_el$458, "border", true);
            _$setProp(_el$458, "paddingLeft", 1);
            _$setProp(_el$458, "paddingRight", 1);
            _$setProp(_el$458, "flexDirection", "column");
            _$insertNode(_el$459, _el$460);
            _$insertNode(_el$460, _$createTextNode(`Complete authoritative replacement`));
            _$insert(_el$458, () => reactiveChild(() => draft().map((root, index) => (() => {
              var _el$466 = _$createElement("box"), _el$467 = _$createElement("text"), _el$468 = _$createElement("box");
              _$insertNode(_el$466, _el$467);
              _$insertNode(_el$466, _el$468);
              _$setProp(_el$466, "border", true);
              _$setProp(_el$466, "paddingLeft", 1);
              _$setProp(_el$466, "paddingRight", 1);
              _$setProp(_el$466, "flexDirection", "column");
              _$setProp(_el$467, "wrapMode", "word");
              _$insert(_el$467, () => root.canonicalPath);
              _$setProp(_el$468, "flexDirection", "row");
              _$setProp(_el$468, "flexWrap", "wrap");
              _$setProp(_el$468, "gap", 1);
              _$insert(_el$468, () => localActionButton(root.canUpdate ? "Update allowed" : "Allow updates", () => updateFolderDraft(index, {
                canUpdate: !root.canUpdate
              }), false, undefined, undefined, `draft-update:${index}`), null);
              _$insert(_el$468, () => localActionButton(root.canCreate ? "Create allowed" : "Allow creation", () => updateFolderDraft(index, {
                canCreate: !root.canCreate,
                ...!root.canCreate ? {} : {
                  primaryCreationRoot: false
                }
              }), false, undefined, undefined, `draft-create:${index}`), null);
              _$insert(_el$468, () => localActionButton(root.primaryCreationRoot ? "Primary creation root" : "Make primary creation root", () => {
                setFolderDraft((current) => current?.map((entry, currentIndex) => ({
                  ...entry,
                  primaryCreationRoot: currentIndex === index,
                  canCreate: currentIndex === index
                })) ?? null);
                setFolderConfirmation("");
                setFolderError(null);
              }, root.primaryCreationRoot, undefined, undefined, `draft-primary:${index}`), null);
              _$insert(_el$468, () => localActionButton("Remove row", () => stageFolderList(draft().filter((_, currentIndex) => currentIndex !== index)), true, undefined, undefined, `draft-remove:${index}`), null);
              _$effect((_$p) => _$setProp(_el$466, "borderColor", props.api.theme.current.borderSubtle, _$p));
              return _el$466;
            })())), _el$462);
            _$insertNode(_el$462, _el$463);
            _$setProp(_el$462, "wrapMode", "word");
            _$insert(_el$462, () => settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable", null);
            _$setProp(_el$464, "onInput", (value) => setFolderConfirmation(value.slice(0, 64)));
            _$setProp(_el$465, "flexDirection", "row");
            _$setProp(_el$465, "flexWrap", "wrap");
            _$setProp(_el$465, "gap", 1);
            _$insert(_el$465, () => localActionButton("Replace authoritative roots", () => void submitFolderList(), true, undefined, {
              action: "replace-global-root-policy",
              subject: "project"
            }), null);
            _$insert(_el$465, () => localActionButton("Cancel", () => {
              setFolderDraft(null);
              setFolderConfirmation("");
            }, false, undefined, undefined, "cancel-folder-update"), null);
            _$effect((_p$) => {
              var _v$83 = props.api.theme.current.warning, _v$84 = focusId("root-policy-confirmation"), _v$85 = folderConfirmation(), _v$86 = settings().globalRootPolicyConfirmation ?? "Fresh server confirmation unavailable";
              _v$83 !== _p$.e && (_p$.e = _$setProp(_el$458, "borderColor", _v$83, _p$.e));
              _v$84 !== _p$.t && (_p$.t = _$setProp(_el$464, "id", _v$84, _p$.t));
              _v$85 !== _p$.a && (_p$.a = _$setProp(_el$464, "value", _v$85, _p$.a));
              _v$86 !== _p$.o && (_p$.o = _$setProp(_el$464, "placeholder", _v$86, _p$.o));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined,
              o: undefined
            });
            return _el$458;
          })()
        }), _el$174);
        _$insertNode(_el$174, _el$175);
        _$insertNode(_el$175, _$createTextNode(`Limits and retention`));
        _$insertNode(_el$177, _$createTextNode(`These values are read-only here. Change configured numeric limits through startup configuration.`));
        _$setProp(_el$177, "wrapMode", "word");
        _$insert(_el$117, () => reactiveChild(() => settings().limits.map((limit) => (() => {
          var _el$469 = _$createElement("box"), _el$470 = _$createElement("text"), _el$471 = _$createElement("b"), _el$472 = _$createElement("text"), _el$473 = _$createTextNode(`Actual: `), _el$474 = _$createElement("text"), _el$475 = _$createTextNode(`Configured limit: `), _el$476 = _$createElement("text");
          _$insertNode(_el$469, _el$470);
          _$insertNode(_el$469, _el$472);
          _$insertNode(_el$469, _el$474);
          _$insertNode(_el$469, _el$476);
          _$setProp(_el$469, "border", true);
          _$setProp(_el$469, "paddingLeft", 1);
          _$setProp(_el$469, "paddingRight", 1);
          _$setProp(_el$469, "flexDirection", "column");
          _$insertNode(_el$470, _el$471);
          _$insert(_el$471, () => limit.label);
          _$insertNode(_el$472, _el$473);
          _$setProp(_el$472, "wrapMode", "word");
          _$insert(_el$472, () => limit.actual, null);
          _$insertNode(_el$474, _el$475);
          _$setProp(_el$474, "wrapMode", "word");
          _$insert(_el$474, () => limit.configured, null);
          _$insert(_el$469, _$createComponent(Show, {
            get when() {
              return limit.resetAt;
            },
            children: (resetAt) => (() => {
              var _el$477 = _$createElement("text"), _el$478 = _$createTextNode(`Resets: `);
              _$insertNode(_el$477, _el$478);
              _$setProp(_el$477, "wrapMode", "word");
              _$insert(_el$477, () => new Date(resetAt()).toISOString(), null);
              return _el$477;
            })()
          }), _el$476);
          _$setProp(_el$476, "wrapMode", "word");
          _$insert(_el$476, () => limit.explanation);
          _$effect((_p$) => {
            var _v$87 = props.api.theme.current.borderSubtle, _v$88 = props.api.theme.current.textMuted;
            _v$87 !== _p$.e && (_p$.e = _$setProp(_el$469, "borderColor", _v$87, _p$.e));
            _v$88 !== _p$.t && (_p$.t = _$setProp(_el$476, "fg", _v$88, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$469;
        })())), _el$179);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().rolloutProgress;
          },
          children: (rolloutProgress) => (() => {
            var _el$479 = _$createElement("box"), _el$480 = _$createElement("text"), _el$481 = _$createElement("b"), _el$483 = _$createTextNode(`: `), _el$484 = _$createElement("text"), _el$485 = _$createTextNode(`Actual: `), _el$486 = _$createElement("text"), _el$487 = _$createTextNode(`Configured requirement: `);
            _$insertNode(_el$479, _el$480);
            _$insertNode(_el$479, _el$484);
            _$insertNode(_el$479, _el$486);
            _$setProp(_el$479, "border", true);
            _$setProp(_el$479, "paddingLeft", 1);
            _$setProp(_el$479, "paddingRight", 1);
            _$setProp(_el$479, "flexDirection", "column");
            _$insertNode(_el$480, _el$481);
            _$insertNode(_el$480, _el$483);
            _$insertNode(_el$481, _$createTextNode(`Compatibility rollout diagnostics (no authority)`));
            _$insert(_el$480, () => rolloutProgress().ready ? "Threshold met" : "Threshold not met", null);
            _$insertNode(_el$484, _el$485);
            _$setProp(_el$484, "wrapMode", "word");
            _$insert(_el$484, () => rolloutProgress().actual, null);
            _$insertNode(_el$486, _el$487);
            _$setProp(_el$486, "wrapMode", "word");
            _$insert(_el$486, () => rolloutProgress().configured, null);
            _$effect((_$p) => _$setProp(_el$479, "borderColor", props.api.theme.current.borderSubtle, _$p));
            return _el$479;
          })()
        }), _el$179);
        _$insertNode(_el$179, _el$180);
        _$insertNode(_el$180, _$createTextNode(`Maintenance`));
        _$insertNode(_el$182, _$createTextNode(`Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.`));
        _$setProp(_el$182, "wrapMode", "word");
        _$setProp(_el$184, "flexDirection", "row");
        _$setProp(_el$184, "flexWrap", "wrap");
        _$setProp(_el$184, "gap", 1);
        _$insert(_el$184, () => reactiveChild(() => settings().maintenance.scopes.map((scope) => (() => {
          var _el$488 = _$createElement("box"), _el$489 = _$createElement("text");
          _$insertNode(_el$488, _el$489);
          _$setProp(_el$488, "focusable", true);
          _$setProp(_el$488, "border", true);
          _$setProp(_el$488, "paddingLeft", 1);
          _$setProp(_el$488, "paddingRight", 1);
          _$setProp(_el$488, "on:focused", () => setFocusedControl(`maintenance-scope:${scope.value}`));
          _$setProp(_el$488, "on:blurred", () => setFocusedControl((current) => current === `maintenance-scope:${scope.value}` ? null : current));
          _$setProp(_el$488, "onMouseUp", () => {
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$setProp(_el$488, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$insert(_el$489, () => focusMark(`maintenance-scope:${scope.value}`), null);
          _$insert(_el$489, () => scope.label, null);
          _$effect((_$p) => _$setProp(_el$488, "borderColor", maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$488;
        })())));
        _$setProp(_el$185, "wrapMode", "word");
        _$insert(_el$185, () => settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation);
        _$setProp(_el$186, "flexDirection", "row");
        _$setProp(_el$186, "flexWrap", "wrap");
        _$setProp(_el$186, "gap", 1);
        _$insert(_el$186, _$createComponent(Show, {
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
        _$insert(_el$186, _$createComponent(Show, {
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
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return maintenanceIntent();
          },
          get children() {
            var _el$187 = _$createElement("box"), _el$188 = _$createElement("text"), _el$189 = _$createElement("text"), _el$190 = _$createTextNode(`Type exactly: `), _el$191 = _$createElement("input"), _el$192 = _$createElement("box");
            _$insertNode(_el$187, _el$188);
            _$insertNode(_el$187, _el$189);
            _$insertNode(_el$187, _el$191);
            _$insertNode(_el$187, _el$192);
            _$setProp(_el$187, "border", true);
            _$setProp(_el$187, "paddingLeft", 1);
            _$setProp(_el$187, "paddingRight", 1);
            _$setProp(_el$187, "flexDirection", "column");
            _$setProp(_el$188, "wrapMode", "word");
            _$insert(_el$188, (() => {
              var _c$5 = _$memo(() => maintenanceIntent() === "export");
              return () => _c$5() ? "The export may contain classified Self-evolve evidence and active skill snapshots." : maintenanceScope() === "all" ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted." : "The selected retained data will be permanently deleted after fresh server validation.";
            })());
            _$insertNode(_el$189, _el$190);
            _$insert(_el$189, maintenancePhrase, null);
            _$setProp(_el$191, "onInput", (value) => setMaintenanceConfirmation(value.slice(0, 64)));
            _$setProp(_el$192, "flexDirection", "row");
            _$setProp(_el$192, "flexWrap", "wrap");
            _$setProp(_el$192, "gap", 1);
            _$insert(_el$192, () => localActionButton(maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently", () => void submitMaintenance(), true, undefined, {
              action: maintenanceIntent() === "export" ? "export-data" : maintenanceScope() === "all" ? "purge-all" : "purge-scope",
              subject: maintenanceScope() === "all" && maintenanceIntent() === "delete" ? "project" : `scope:${maintenanceScope()}`
            }), null);
            _$insert(_el$192, () => localActionButton("Cancel", () => {
              setMaintenanceIntent(null);
              setMaintenanceConfirmation("");
            }, false, undefined, undefined, "cancel-maintenance"), null);
            _$effect((_p$) => {
              var _v$31 = props.api.theme.current.warning, _v$32 = maintenanceConfirmation(), _v$33 = maintenancePhrase();
              _v$31 !== _p$.e && (_p$.e = _$setProp(_el$187, "borderColor", _v$31, _p$.e));
              _v$32 !== _p$.t && (_p$.t = _$setProp(_el$191, "value", _v$32, _p$.t));
              _v$33 !== _p$.a && (_p$.a = _$setProp(_el$191, "placeholder", _v$33, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$187;
          }
        }), _el$193);
        _$insert(_el$117, _$createComponent(Show, {
          get when() {
            return settings().latestExport;
          },
          children: (latestExport) => (() => {
            var _el$490 = _$createElement("box"), _el$491 = _$createElement("text"), _el$492 = _$createElement("b"), _el$494 = _$createElement("text"), _el$495 = _$createTextNode(`Scope: `), _el$496 = _$createElement("text"), _el$497 = _$createTextNode(`Private path: `), _el$498 = _$createElement("text"), _el$499 = _$createTextNode(`Size: `), _el$500 = _$createTextNode(` bytes`), _el$501 = _$createElement("text"), _el$502 = _$createTextNode(`SHA-256: `), _el$503 = _$createElement("text"), _el$504 = _$createTextNode(`Expires: `);
            _$insertNode(_el$490, _el$491);
            _$insertNode(_el$490, _el$494);
            _$insertNode(_el$490, _el$496);
            _$insertNode(_el$490, _el$498);
            _$insertNode(_el$490, _el$501);
            _$insertNode(_el$490, _el$503);
            _$setProp(_el$490, "border", true);
            _$setProp(_el$490, "paddingLeft", 1);
            _$setProp(_el$490, "paddingRight", 1);
            _$setProp(_el$490, "flexDirection", "column");
            _$insertNode(_el$491, _el$492);
            _$insertNode(_el$492, _$createTextNode(`Latest private export`));
            _$insertNode(_el$494, _el$495);
            _$setProp(_el$494, "wrapMode", "word");
            _$insert(_el$494, () => latestExport().scope, null);
            _$insertNode(_el$496, _el$497);
            _$setProp(_el$496, "wrapMode", "word");
            _$insert(_el$496, () => latestExport().path, null);
            _$insertNode(_el$498, _el$499);
            _$insertNode(_el$498, _el$500);
            _$setProp(_el$498, "wrapMode", "word");
            _$insert(_el$498, () => latestExport().bytes, _el$500);
            _$insertNode(_el$501, _el$502);
            _$setProp(_el$501, "wrapMode", "word");
            _$insert(_el$501, () => latestExport().sha256, null);
            _$insertNode(_el$503, _el$504);
            _$setProp(_el$503, "wrapMode", "word");
            _$insert(_el$503, () => new Date(latestExport().expiresAt).toISOString(), null);
            _$effect((_$p) => _$setProp(_el$490, "borderColor", props.api.theme.current.warning, _$p));
            return _el$490;
          })()
        }), _el$193);
        _$insertNode(_el$193, _el$194);
        _$insertNode(_el$193, _el$195);
        _$insertNode(_el$193, _el$196);
        _$insertNode(_el$193, _el$197);
        _$setProp(_el$193, "wrapMode", "word");
        _$insert(_el$193, () => settings().footer.hostVersion, _el$195);
        _$insert(_el$193, () => settings().footer.pluginVersion, _el$196);
        _$insert(_el$193, () => settings().footer.projectionVersion ?? "Unavailable", _el$197);
        _$insert(_el$193, () => settings().footer.dashboardVersion ?? "Unavailable", null);
        _$setProp(_el$198, "wrapMode", "word");
        _$insert(_el$198, () => settings().footer.help);
        _$effect((_p$) => {
          var _v$34 = props.api.theme.current.textMuted, _v$35 = props.api.theme.current.borderSubtle, _v$36 = props.api.theme.current.textMuted, _v$37 = props.api.theme.current.textMuted;
          _v$34 !== _p$.e && (_p$.e = _$setProp(_el$135, "fg", _v$34, _p$.e));
          _v$35 !== _p$.t && (_p$.t = _$setProp(_el$146, "borderColor", _v$35, _p$.t));
          _v$36 !== _p$.a && (_p$.a = _$setProp(_el$193, "fg", _v$36, _p$.a));
          _v$37 !== _p$.o && (_p$.o = _$setProp(_el$198, "fg", _v$37, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$117;
      }
    }), null);
    _$insert(_el$30, _$createComponent(Show, {
      get when() {
        return props.snapshot().responses.length || feedback();
      },
      get children() {
        var _el$199 = _$createElement("box"), _el$200 = _$createElement("box"), _el$201 = _$createElement("text"), _el$202 = _$createTextNode(`Outcomes and next steps \xB7 `), _el$203 = _$createTextNode(` retained`), _el$204 = _$createTextNode(` `);
        _$insertNode(_el$199, _el$200);
        _$setProp(_el$199, "id", "self-evolve-outcomes");
        _$setProp(_el$199, "border", true);
        _$setProp(_el$199, "paddingLeft", 1);
        _$setProp(_el$199, "paddingRight", 1);
        _$setProp(_el$199, "flexDirection", "column");
        _$insertNode(_el$200, _el$201);
        _$setProp(_el$200, "focusable", true);
        _$setProp(_el$200, "on:focused", () => setFocusedControl("outcomes-summary"));
        _$setProp(_el$200, "on:blurred", () => setFocusedControl((current) => current === "outcomes-summary" ? null : current));
        _$setProp(_el$200, "onMouseUp", () => setOutcomesExpanded((value) => !value));
        _$setProp(_el$200, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setOutcomesExpanded((value) => !value);
        });
        _$insertNode(_el$201, _el$202);
        _$insertNode(_el$201, _el$203);
        _$insertNode(_el$201, _el$204);
        _$insert(_el$201, () => focusMark("outcomes-summary"), _el$202);
        _$insert(_el$201, () => props.snapshot().responses.length, _el$203);
        _$insert(_el$201, () => feedback() ? " \xB7 current feedback" : "", _el$204);
        _$insert(_el$201, () => outcomesExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$199, _$createComponent(Show, {
          get when() {
            return outcomesExpanded();
          },
          get children() {
            return [_$memo(() => reactiveChild(() => props.snapshot().responses.map((completedResponse, index) => (() => {
              var _el$505 = _$createElement("box"), _el$506 = _$createElement("text");
              _$insertNode(_el$505, _el$506);
              _$setProp(_el$505, "focusable", true);
              _$setProp(_el$505, "on:focused", () => setFocusedControl(`outcome:${index}`));
              _$setProp(_el$505, "on:blurred", () => setFocusedControl((current) => current === `outcome:${index}` ? null : current));
              _$setProp(_el$506, "wrapMode", "word");
              _$insert(_el$506, () => focusMark(`outcome:${index}`), null);
              _$insert(_el$506, () => requestResponseMessage(completedResponse), null);
              _$effect((_p$) => {
                var _v$89 = focusId(`outcome:${index}`), _v$90 = completedResponse.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info;
                _v$89 !== _p$.e && (_p$.e = _$setProp(_el$505, "id", _v$89, _p$.e));
                _v$90 !== _p$.t && (_p$.t = _$setProp(_el$506, "fg", _v$90, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$505;
            })()))), _$createComponent(Show, {
              get when() {
                return feedback();
              },
              children: (message) => (() => {
                var _el$507 = _$createElement("box"), _el$508 = _$createElement("text");
                _$insertNode(_el$507, _el$508);
                _$setProp(_el$507, "focusable", true);
                _$setProp(_el$507, "on:focused", () => setFocusedControl("outcome-feedback"));
                _$setProp(_el$507, "on:blurred", () => setFocusedControl((current) => current === "outcome-feedback" ? null : current));
                _$setProp(_el$508, "wrapMode", "word");
                _$insert(_el$508, () => focusMark("outcome-feedback"), null);
                _$insert(_el$508, message, null);
                _$effect((_p$) => {
                  var _v$91 = focusId("outcome-feedback"), _v$92 = props.api.theme.current.info;
                  _v$91 !== _p$.e && (_p$.e = _$setProp(_el$507, "id", _v$91, _p$.e));
                  _v$92 !== _p$.t && (_p$.t = _$setProp(_el$508, "fg", _v$92, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$507;
              })()
            })];
          }
        }), null);
        _$effect((_p$) => {
          var _v$38 = outcomesExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$39 = focusId("outcomes-summary");
          _v$38 !== _p$.e && (_p$.e = _$setProp(_el$199, "borderColor", _v$38, _p$.e));
          _v$39 !== _p$.t && (_p$.t = _$setProp(_el$200, "id", _v$39, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$199;
      }
    }), null);
    _$insertNode(_el$205, _el$206);
    _$setProp(_el$205, "flexDirection", "column");
    _$setProp(_el$205, "flexShrink", 0);
    _$setProp(_el$205, "overflow", "hidden");
    _$insertNode(_el$206, _el$207);
    _$insert(_el$206, () => props.prior().name, null);
    _$effect((_p$) => {
      var _v$40 = compactShell() ? 1 : 2, _v$41 = compactShell() ? 1 : 2, _v$42 = compactShell() ? 3 : "auto", _v$43 = props.api.theme.current.text, _v$44 = props.api.theme.current.textMuted, _v$45 = compactShell() ? 2 : "auto", _v$46 = props.api.theme.current.textMuted;
      _v$40 !== _p$.e && (_p$.e = _$setProp(_el$21, "paddingLeft", _v$40, _p$.e));
      _v$41 !== _p$.t && (_p$.t = _$setProp(_el$21, "paddingRight", _v$41, _p$.t));
      _v$42 !== _p$.a && (_p$.a = _$setProp(_el$22, "height", _v$42, _p$.a));
      _v$43 !== _p$.o && (_p$.o = _$setProp(_el$24, "fg", _v$43, _p$.o));
      _v$44 !== _p$.i && (_p$.i = _$setProp(_el$27, "fg", _v$44, _p$.i));
      _v$45 !== _p$.n && (_p$.n = _$setProp(_el$205, "height", _v$45, _p$.n));
      _v$46 !== _p$.s && (_p$.s = _$setProp(_el$206, "fg", _v$46, _p$.s));
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
  const [routeRevision, setRouteRevision] = createSignal(0);
  const initialSnapshot = projectStore.getSnapshot();
  const [snapshot, setSnapshot] = createSignal(initialSnapshot);
  let activeGlobalIdentity = globalSnapshotIdentity(initialSnapshot);
  const unsubscribe = projectStore.subscribe((next) => {
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
      store: projectStore,
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
          var _el$509 = _$createElement("box");
          _$setProp(_el$509, "flexDirection", "column");
          _$setProp(_el$509, "width", "100%");
          _$setProp(_el$509, "gap", 1);
          _$insert(_el$509, _$createComponent(SidebarCard, {
            api,
            card: () => deriveSidebarCard(snapshot()),
            open: () => {
              const card = deriveSidebarCard(snapshot());
              openControlCenter(card.destination);
            }
          }), null);
          _$insert(_el$509, _$createComponent(SidebarModeControl, {
            api,
            store: projectStore,
            snapshot
          }), null);
          return _el$509;
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
