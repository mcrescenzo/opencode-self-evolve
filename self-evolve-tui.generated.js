// @bun
// self-evolve-tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setTimeout as delay } from "timers/promises";
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js";
import { CONTROL_CENTER_SECTIONS, acquireProjectTuiStore, buildControlCenterModel, controlCenterRouteParams, deriveSidebarCard, parseControlCenterDestination, validateApprovedSkillFolderInput } from "./self-evolve-tui-store.js";
var CONTROL_CENTER_COMMAND = TUI_IDENTITIES.command;
var CONTROL_CENTER_ROUTE = TUI_IDENTITIES.route;
var CONTROL_CENTER_MODE = TUI_IDENTITIES.mode;
var CONTROL_CENTER_VIEW_ID = TUI_IDENTITIES.view;
var activeApis = new WeakSet;
function isActivationKey(event) {
  return event.name === "return" || event.name === "linefeed" || event.name === "space";
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
      _$setProp(_el$, "onFocus", () => setFocused(true));
      _$setProp(_el$, "onBlur", () => setFocused(false));
      _$setProp(_el$, "onMouseDown", () => cardNode?.focus());
      _$setProp(_el$, "onKeyDown", (event) => {
        if (!isActivationKey(event))
          return;
        event.preventDefault();
        props.open();
      });
      _$insertNode(_el$2, _el$3);
      _$insert(_el$3, () => props.card()?.title);
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
  const [folderInput, setFolderInput] = createSignal("");
  const [folderError, setFolderError] = createSignal(null);
  const [folderDraft, setFolderDraft] = createSignal(null);
  const [folderConfirmation, setFolderConfirmation] = createSignal("");
  const [yoloTarget, setYoloTarget] = createSignal(null);
  const [yoloConfirmation, setYoloConfirmation] = createSignal("");
  const [maintenanceScope, setMaintenanceScope] = createSignal("observations");
  const [maintenanceIntent, setMaintenanceIntent] = createSignal(null);
  const [maintenanceConfirmation, setMaintenanceConfirmation] = createSignal("");
  const model = createMemo(() => buildControlCenterModel(props.snapshot(), {
    selectedIndex: selectedIndex(),
    recommendationFilter: recommendationFilter(),
    activityFilter: activityFilter()
  }));
  let popMode = () => {};
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE);
    selectRecommendation(selectedIndex());
  });
  onCleanup(() => popMode());
  const navigate = (next) => {
    setSection(next.section);
    setSettingsAnchor(next.section === "settings" ? next.anchor : undefined);
    if (Number.isSafeInteger(next.selectedIndex))
      setSelectedIndex(next.selectedIndex);
    if (typeof next.filter === "string")
      setActivityFilter(next.filter);
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
    selectRecommendation(queue[(current + offset + queue.length) % queue.length].sourceIndex);
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
  const actionButton = (key, label, operation, requiresConfirmation = false) => (() => {
    var _el$7 = _$createElement("box"), _el$8 = _$createElement("text");
    _$insertNode(_el$7, _el$8);
    _$setProp(_el$7, "focusable", true);
    _$setProp(_el$7, "border", true);
    _$setProp(_el$7, "paddingLeft", 1);
    _$setProp(_el$7, "paddingRight", 1);
    _$setProp(_el$7, "onMouseUp", () => void invoke(key, operation, requiresConfirmation));
    _$setProp(_el$7, "onKeyDown", (event) => {
      if (!isActivationKey(event))
        return;
      event.preventDefault();
      invoke(key, operation, requiresConfirmation);
    });
    _$insert(_el$8, () => confirmation() === key ? `Confirm ${label}` : label);
    _$effect((_p$) => {
      var _v$7 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$8 = props.api.theme.current.text;
      _v$7 !== _p$.e && (_p$.e = _$setProp(_el$7, "borderColor", _v$7, _p$.e));
      _v$8 !== _p$.t && (_p$.t = _$setProp(_el$8, "fg", _v$8, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$7;
  })();
  const localActionButton = (label, operation, warning = false, confirmationKey) => (() => {
    var _el$9 = _$createElement("box"), _el$0 = _$createElement("text");
    _$insertNode(_el$9, _el$0);
    _$setProp(_el$9, "focusable", true);
    _$setProp(_el$9, "border", true);
    _$setProp(_el$9, "paddingLeft", 1);
    _$setProp(_el$9, "paddingRight", 1);
    _$setProp(_el$9, "onMouseUp", operation);
    _$setProp(_el$9, "onKeyDown", (event) => {
      if (!isActivationKey(event))
        return;
      event.preventDefault();
      operation();
    });
    _$insert(_el$0, () => confirmation() === confirmationKey ? `Confirm ${label}` : label);
    _$effect((_p$) => {
      var _v$9 = warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle, _v$0 = props.api.theme.current.text;
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$9, "borderColor", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$0, "fg", _v$0, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$9;
  })();
  const granted = () => new Set((props.snapshot().projection?.index?.allowedActions ?? []).map((action) => action.action));
  const paused = () => props.snapshot().dashboard?.settings?.paused === true;
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true;
  const completedResponse = () => props.snapshot().responses.at(-1);
  const home = () => model().sections.home;
  const recommendations = () => model().sections.recommendations;
  const activity = () => model().sections.activity;
  const settings = () => model().sections.settings;
  const consentEnabled = (key) => settings().consent.find((entry) => entry.key === key)?.enabled === true;
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
  const waitForControlResponse = async (requestId, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      await props.store.refresh();
      const completed = props.snapshot().responses.find((entry) => entry.requestId === requestId);
      if (completed?.response) {
        if (completed.response.ok !== true) {
          throw new Error(completed.response.reason ?? "control-request-rejected");
        }
        return completed.response;
      }
      await delay(100);
    }
    throw new Error("control-response-timeout");
  };
  const submitControlAndWait = async (action, payload) => {
    const request = await props.store.submitControl(action, payload);
    await waitForControlResponse(request.requestId);
  };
  const enableAutomaticRecommendations = async () => {
    if (!consentEnabled("passiveCalls")) {
      await submitControlAndWait("set-consent", {
        key: "passiveCalls",
        enabled: true
      });
    }
    if (!consentEnabled("durableObservations")) {
      await submitControlAndWait("set-consent", {
        key: "durableObservations",
        enabled: true
      });
    }
    if (modeRank(settings().mode.global.value) < modeRank("auto")) {
      await submitControlAndWait("set-mode", {
        mode: "auto"
      });
    }
  };
  const automaticRecommendationsReady = () => modeRank(settings().mode.global.value) >= modeRank("auto") && consentEnabled("passiveCalls") && consentEnabled("durableObservations");
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
  const pendingRecommendation = () => props.snapshot().pending.some((entry) => ["apply-proposal", "reject-proposal", "snooze-proposal", "rollback-proposal"].includes(entry.action ?? ""));
  const activateRecommendation = async (action, snoozeMs) => {
    const proposalId = selectedProposalId();
    if (!proposalId || pendingRecommendation())
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
    var _el$1 = _$createElement("box"), _el$10 = _$createElement("box"), _el$11 = _$createElement("box"), _el$12 = _$createElement("text"), _el$13 = _$createElement("b"), _el$15 = _$createElement("text"), _el$16 = _$createTextNode(` \xB7 `), _el$17 = _$createElement("box"), _el$18 = _$createElement("scrollbox"), _el$181 = _$createElement("text"), _el$182 = _$createTextNode(`Esc returns to `);
    _$insertNode(_el$1, _el$10);
    _$insertNode(_el$1, _el$17);
    _$insertNode(_el$1, _el$18);
    _$insertNode(_el$1, _el$181);
    _$setProp(_el$1, "id", CONTROL_CENTER_VIEW_ID);
    _$setProp(_el$1, "focusable", true);
    _$setProp(_el$1, "width", "100%");
    _$setProp(_el$1, "height", "100%");
    _$setProp(_el$1, "flexDirection", "column");
    _$setProp(_el$1, "paddingLeft", 2);
    _$setProp(_el$1, "paddingRight", 2);
    _$insertNode(_el$10, _el$11);
    _$setProp(_el$10, "flexDirection", "row");
    _$setProp(_el$10, "gap", 1);
    _$setProp(_el$10, "flexWrap", "wrap");
    _$insertNode(_el$11, _el$12);
    _$insertNode(_el$11, _el$15);
    _$setProp(_el$11, "flexDirection", "column");
    _$setProp(_el$11, "flexGrow", 1);
    _$insertNode(_el$12, _el$13);
    _$insertNode(_el$13, _$createTextNode(`Self-evolve`));
    _$insertNode(_el$15, _el$16);
    _$setProp(_el$15, "wrapMode", "word");
    _$insert(_el$15, () => model().operational.label, _el$16);
    _$insert(_el$15, () => home().mode.effective.label, null);
    _$insert(_el$10, _$createComponent(Show, {
      get when() {
        return granted().has("set-paused");
      },
      get children() {
        return actionButton(paused() ? "resume" : "pause", paused() ? "Resume" : "Pause", () => props.store.submitOperation("set-paused", {
          paused: !paused()
        }));
      }
    }), null);
    _$insert(_el$10, _$createComponent(Show, {
      get when() {
        return granted().has("set-kill-switch");
      },
      get children() {
        return actionButton(emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop", emergencyStop() ? "Turn off Emergency stop" : "Emergency stop", () => props.store.submitOperation("set-kill-switch", {
          enabled: !emergencyStop()
        }), emergencyStop());
      }
    }), null);
    _$setProp(_el$17, "flexDirection", "row");
    _$setProp(_el$17, "gap", 1);
    _$setProp(_el$17, "flexWrap", "wrap");
    _$insert(_el$17, () => names.map((name) => (() => {
      var _el$183 = _$createElement("box"), _el$184 = _$createElement("text");
      _$insertNode(_el$183, _el$184);
      _$setProp(_el$183, "focusable", true);
      _$setProp(_el$183, "border", true);
      _$setProp(_el$183, "paddingLeft", 1);
      _$setProp(_el$183, "paddingRight", 1);
      _$setProp(_el$183, "onMouseUp", () => navigate({
        section: name
      }));
      _$setProp(_el$183, "onKeyDown", (event) => {
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
      _$insert(_el$184, () => name.charAt(0).toUpperCase() + name.slice(1), null);
      _$insert(_el$184, (() => {
        var _c$4 = _$memo(() => !!(name === "recommendations" && model().operational.count > 0));
        return () => _c$4() ? ` (${model().operational.count})` : "";
      })(), null);
      _$effect((_p$) => {
        var _v$25 = section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$26 = section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted;
        _v$25 !== _p$.e && (_p$.e = _$setProp(_el$183, "borderColor", _v$25, _p$.e));
        _v$26 !== _p$.t && (_p$.t = _$setProp(_el$184, "fg", _v$26, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$183;
    })()));
    _$setProp(_el$18, "flexGrow", 1);
    _$setProp(_el$18, "width", "100%");
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return section() === "home";
      },
      get children() {
        var _el$19 = _$createElement("box"), _el$20 = _$createElement("text"), _el$21 = _$createElement("b"), _el$22 = _$createElement("text"), _el$23 = _$createElement("text"), _el$24 = _$createElement("box"), _el$25 = _$createElement("text"), _el$26 = _$createElement("b"), _el$28 = _$createElement("text"), _el$29 = _$createTextNode(`Effective: `), _el$30 = _$createElement("text"), _el$31 = _$createTextNode(`Global default: `), _el$32 = _$createElement("text"), _el$33 = _$createTextNode(`This project: `), _el$57 = _$createElement("text");
        _$insertNode(_el$19, _el$20);
        _$insertNode(_el$19, _el$22);
        _$insertNode(_el$19, _el$23);
        _$insertNode(_el$19, _el$24);
        _$insertNode(_el$19, _el$57);
        _$setProp(_el$19, "flexDirection", "column");
        _$setProp(_el$19, "gap", 1);
        _$insertNode(_el$20, _el$21);
        _$insert(_el$21, () => home().operational.label);
        _$setProp(_el$22, "wrapMode", "word");
        _$insert(_el$22, () => home().operational.explanation);
        _$setProp(_el$23, "wrapMode", "word");
        _$insert(_el$23, () => home().operational.nextAction);
        _$insertNode(_el$24, _el$25);
        _$insertNode(_el$24, _el$28);
        _$insertNode(_el$24, _el$30);
        _$insertNode(_el$24, _el$32);
        _$setProp(_el$24, "border", true);
        _$setProp(_el$24, "paddingLeft", 1);
        _$setProp(_el$24, "paddingRight", 1);
        _$setProp(_el$24, "flexDirection", "column");
        _$insertNode(_el$25, _el$26);
        _$insertNode(_el$26, _$createTextNode(`Mode and scope`));
        _$insertNode(_el$28, _el$29);
        _$setProp(_el$28, "wrapMode", "word");
        _$insert(_el$28, () => home().mode.effective.label, null);
        _$insertNode(_el$30, _el$31);
        _$setProp(_el$30, "wrapMode", "word");
        _$insert(_el$30, () => home().mode.global.label, null);
        _$insertNode(_el$32, _el$33);
        _$setProp(_el$32, "wrapMode", "word");
        _$insert(_el$32, () => home().mode.repository.label, null);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().firstRun;
          },
          get children() {
            var _el$34 = _$createElement("box"), _el$35 = _$createElement("text"), _el$36 = _$createElement("b"), _el$38 = _$createElement("text"), _el$42 = _$createElement("text"), _el$43 = _$createElement("b"), _el$45 = _$createElement("text");
            _$insertNode(_el$34, _el$35);
            _$insertNode(_el$34, _el$38);
            _$insertNode(_el$34, _el$42);
            _$insertNode(_el$34, _el$45);
            _$setProp(_el$34, "border", true);
            _$setProp(_el$34, "paddingLeft", 1);
            _$setProp(_el$34, "paddingRight", 1);
            _$setProp(_el$34, "flexDirection", "column");
            _$setProp(_el$34, "gap", 1);
            _$insertNode(_el$35, _el$36);
            _$insertNode(_el$36, _$createTextNode(`Get automatic recommendations`));
            _$insertNode(_el$38, _$createTextNode(`Choose proactive review without granting automatic writes. Background AI analysis and saved structured patterns remain separate consent gates in Settings.`));
            _$setProp(_el$38, "wrapMode", "word");
            _$insert(_el$34, _$createComponent(Show, {
              get when() {
                return settings().controls.globalMode;
              },
              get children() {
                return actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true);
              }
            }), _el$42);
            _$insert(_el$34, _$createComponent(Show, {
              get when() {
                return !settings().controls.globalMode;
              },
              get children() {
                var _el$40 = _$createElement("text");
                _$insertNode(_el$40, _$createTextNode(`Controls are unavailable until the aligned server publishes fresh authority.`));
                _$effect((_$p) => _$setProp(_el$40, "fg", props.api.theme.current.textMuted, _$p));
                return _el$40;
              }
            }), _el$42);
            _$insertNode(_el$42, _el$43);
            _$insertNode(_el$43, _$createTextNode(`Optional evidence excerpts`));
            _$insertNode(_el$45, _$createTextNode(`Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations.`));
            _$setProp(_el$45, "wrapMode", "word");
            _$insert(_el$34, _$createComponent(Show, {
              get when() {
                return settings().controls.consent;
              },
              get children() {
                return actionButton("first-run-sanitized-excerpts", "Allow sanitized excerpts", () => props.store.submitControl("set-consent", {
                  key: "sanitizedExcerpts",
                  enabled: true
                }), true);
              }
            }), null);
            _$insert(_el$34, _$createComponent(Show, {
              get when() {
                return !settings().controls.consent;
              },
              get children() {
                var _el$47 = _$createElement("text");
                _$insertNode(_el$47, _$createTextNode(`Excerpt consent can be changed later in Settings.`));
                _$effect((_$p) => _$setProp(_el$47, "fg", props.api.theme.current.textMuted, _$p));
                return _el$47;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$34, "borderColor", props.api.theme.current.info, _$p));
            return _el$34;
          }
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().blockers.length;
          },
          get children() {
            var _el$49 = _$createElement("box"), _el$50 = _$createElement("text"), _el$51 = _$createElement("b");
            _$insertNode(_el$49, _el$50);
            _$setProp(_el$49, "flexDirection", "column");
            _$insertNode(_el$50, _el$51);
            _$insertNode(_el$51, _$createTextNode(`Setup`));
            _$insert(_el$49, () => home().blockers.map((blocker) => (() => {
              var _el$185 = _$createElement("box"), _el$186 = _$createElement("text"), _el$187 = _$createTextNode(` \xB7 Open Settings`);
              _$insertNode(_el$185, _el$186);
              _$setProp(_el$185, "focusable", true);
              _$setProp(_el$185, "border", true);
              _$setProp(_el$185, "paddingLeft", 1);
              _$setProp(_el$185, "paddingRight", 1);
              _$setProp(_el$185, "onMouseUp", () => navigate({
                section: "settings",
                anchor: blocker.code
              }));
              _$setProp(_el$185, "onKeyDown", (event) => {
                if (!isActivationKey(event))
                  return;
                event.preventDefault();
                navigate({
                  section: "settings",
                  anchor: blocker.code
                });
              });
              _$insertNode(_el$186, _el$187);
              _$setProp(_el$186, "wrapMode", "word");
              _$insert(_el$186, () => blocker.summary, _el$187);
              _$effect((_$p) => _$setProp(_el$185, "borderColor", props.api.theme.current.warning, _$p));
              return _el$185;
            })()), null);
            return _el$49;
          }
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().lastCycle;
          },
          children: (lastCycle) => (() => {
            var _el$188 = _$createElement("box"), _el$189 = _$createElement("text"), _el$190 = _$createElement("b"), _el$192 = _$createElement("text"), _el$193 = _$createTextNode(` \xB7 `), _el$194 = _$createTextNode(` observations \xB7 `), _el$195 = _$createTextNode(` eligible`);
            _$insertNode(_el$188, _el$189);
            _$insertNode(_el$188, _el$192);
            _$setProp(_el$188, "flexDirection", "column");
            _$insertNode(_el$189, _el$190);
            _$insertNode(_el$190, _$createTextNode(`Last cycle`));
            _$insertNode(_el$192, _el$193);
            _$insertNode(_el$192, _el$194);
            _$insertNode(_el$192, _el$195);
            _$setProp(_el$192, "wrapMode", "word");
            _$insert(_el$192, () => lastCycle().outcome.replaceAll("-", " "), _el$193);
            _$insert(_el$192, () => lastCycle().observationCount, _el$194);
            _$insert(_el$192, () => lastCycle().eligibilityCount, _el$195);
            return _el$188;
          })()
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().attention;
          },
          children: (attention) => (() => {
            var _el$196 = _$createElement("box"), _el$197 = _$createElement("text"), _el$198 = _$createTextNode(` `), _el$199 = _$createTextNode(` needs attention`);
            _$insertNode(_el$196, _el$197);
            _$setProp(_el$196, "focusable", true);
            _$setProp(_el$196, "border", true);
            _$setProp(_el$196, "paddingLeft", 1);
            _$setProp(_el$196, "paddingRight", 1);
            _$setProp(_el$196, "onMouseUp", () => navigate(attention().destination));
            _$setProp(_el$196, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              navigate(attention().destination);
            });
            _$insertNode(_el$197, _el$198);
            _$insertNode(_el$197, _el$199);
            _$insert(_el$197, () => attention().count, _el$198);
            _$insert(_el$197, () => attention().kind === "applied" ? "applied change" : "recommendation", _el$199);
            _$effect((_$p) => _$setProp(_el$196, "borderColor", props.api.theme.current.warning, _$p));
            return _el$196;
          })()
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().usage;
          },
          children: (usage) => (() => {
            var _el$200 = _$createElement("box"), _el$201 = _$createElement("text"), _el$202 = _$createElement("b"), _el$204 = _$createElement("text"), _el$205 = _$createTextNode(`Background analysis: `), _el$206 = _$createTextNode(` / `), _el$207 = _$createElement("text"), _el$208 = _$createTextNode(`Recommendation synthesis: `), _el$209 = _$createTextNode(` / `), _el$210 = _$createElement("text"), _el$211 = _$createTextNode(`Storage: `), _el$212 = _$createTextNode(` / `), _el$213 = _$createTextNode(` bytes`);
            _$insertNode(_el$200, _el$201);
            _$insertNode(_el$200, _el$204);
            _$insertNode(_el$200, _el$207);
            _$insertNode(_el$200, _el$210);
            _$setProp(_el$200, "flexDirection", "column");
            _$insertNode(_el$201, _el$202);
            _$insertNode(_el$202, _$createTextNode(`Actual usage`));
            _$insertNode(_el$204, _el$205);
            _$insertNode(_el$204, _el$206);
            _$insert(_el$204, () => usage().passive.used, _el$206);
            _$insert(_el$204, () => usage().passive.limit, null);
            _$insertNode(_el$207, _el$208);
            _$insertNode(_el$207, _el$209);
            _$insert(_el$207, () => usage().synthesis.used, _el$209);
            _$insert(_el$207, () => usage().synthesis.limit, null);
            _$insertNode(_el$210, _el$211);
            _$insertNode(_el$210, _el$212);
            _$insertNode(_el$210, _el$213);
            _$insert(_el$210, () => usage().storage.usedBytes, _el$212);
            _$insert(_el$210, () => usage().storage.limitBytes, _el$213);
            return _el$200;
          })()
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().recentActivity.length;
          },
          get children() {
            var _el$53 = _$createElement("box"), _el$54 = _$createElement("text"), _el$55 = _$createElement("b");
            _$insertNode(_el$53, _el$54);
            _$setProp(_el$53, "flexDirection", "column");
            _$insertNode(_el$54, _el$55);
            _$insertNode(_el$55, _$createTextNode(`Recent activity`));
            _$insert(_el$53, () => home().recentActivity.map((entry) => (() => {
              var _el$214 = _$createElement("text"), _el$215 = _$createTextNode(`[`), _el$216 = _$createTextNode(`] `);
              _$insertNode(_el$214, _el$215);
              _$insertNode(_el$214, _el$216);
              _$setProp(_el$214, "wrapMode", "word");
              _$insert(_el$214, () => entry.marker, _el$216);
              _$insert(_el$214, () => entry.summary, null);
              return _el$214;
            })()), null);
            return _el$53;
          }
        }), _el$57);
        _$insert(_el$19, _$createComponent(Show, {
          get when() {
            return home().emptyState;
          },
          children: (emptyState) => (() => {
            var _el$217 = _$createElement("box"), _el$218 = _$createElement("text"), _el$219 = _$createElement("b"), _el$220 = _$createElement("text");
            _$insertNode(_el$217, _el$218);
            _$insertNode(_el$217, _el$220);
            _$setProp(_el$217, "flexDirection", "column");
            _$insertNode(_el$218, _el$219);
            _$insert(_el$219, () => emptyState().heading);
            _$setProp(_el$220, "wrapMode", "word");
            _$insert(_el$220, () => emptyState().explanation);
            return _el$217;
          })()
        }), _el$57);
        _$setProp(_el$57, "wrapMode", "word");
        _$insert(_el$57, () => home().manualFallback);
        _$effect((_p$) => {
          var _v$1 = props.api.theme.current.text, _v$10 = props.api.theme.current.textMuted, _v$11 = props.api.theme.current.borderSubtle, _v$12 = props.api.theme.current.textMuted;
          _v$1 !== _p$.e && (_p$.e = _$setProp(_el$20, "fg", _v$1, _p$.e));
          _v$10 !== _p$.t && (_p$.t = _$setProp(_el$23, "fg", _v$10, _p$.t));
          _v$11 !== _p$.a && (_p$.a = _$setProp(_el$24, "borderColor", _v$11, _p$.a));
          _v$12 !== _p$.o && (_p$.o = _$setProp(_el$57, "fg", _v$12, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$19;
      }
    }), null);
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return section() === "recommendations";
      },
      get children() {
        var _el$58 = _$createElement("box"), _el$59 = _$createElement("text"), _el$60 = _$createElement("b"), _el$62 = _$createElement("box");
        _$insertNode(_el$58, _el$59);
        _$insertNode(_el$58, _el$62);
        _$setProp(_el$58, "flexDirection", "column");
        _$setProp(_el$58, "gap", 1);
        _$insertNode(_el$59, _el$60);
        _$insertNode(_el$60, _$createTextNode(`Recommendations`));
        _$setProp(_el$62, "flexDirection", "row");
        _$setProp(_el$62, "gap", 1);
        _$setProp(_el$62, "flexWrap", "wrap");
        _$insert(_el$62, () => [["needs-review", "Needs review"], ["applied", "Applied"], ["dismissed", "Dismissed"], ["all", "All"]].map(([value, label]) => (() => {
          var _el$221 = _$createElement("box"), _el$222 = _$createElement("text");
          _$insertNode(_el$221, _el$222);
          _$setProp(_el$221, "focusable", true);
          _$setProp(_el$221, "border", true);
          _$setProp(_el$221, "paddingLeft", 1);
          _$setProp(_el$221, "paddingRight", 1);
          _$setProp(_el$221, "onMouseUp", () => {
            setRecommendationFilter(value);
            const first = buildControlCenterModel(props.snapshot(), {
              recommendationFilter: value
            }).sections.recommendations.queue[0];
            if (first)
              selectRecommendation(first.sourceIndex);
          });
          _$setProp(_el$221, "onKeyDown", (event) => {
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
          _$insert(_el$222, label);
          _$effect((_$p) => _$setProp(_el$221, "borderColor", recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$221;
        })()));
        _$insert(_el$58, _$createComponent(Show, {
          get when() {
            return recommendations().emptyState;
          },
          get children() {
            var _el$63 = _$createElement("text");
            _$insert(_el$63, () => recommendations().emptyState);
            return _el$63;
          }
        }), null);
        _$insert(_el$58, () => recommendations().queue.map((item, index) => (() => {
          var _el$223 = _$createElement("box"), _el$224 = _$createElement("text"), _el$225 = _$createTextNode(` \xB7 `), _el$226 = _$createTextNode(` \xB7 `), _el$227 = _$createElement("text"), _el$228 = _$createElement("text"), _el$229 = _$createTextNode(`Risk: `), _el$230 = _$createTextNode(` \xB7 Evidence: `);
          _$insertNode(_el$223, _el$224);
          _$insertNode(_el$223, _el$227);
          _$insertNode(_el$223, _el$228);
          _$setProp(_el$223, "focusable", true);
          _$setProp(_el$223, "border", true);
          _$setProp(_el$223, "paddingLeft", 1);
          _$setProp(_el$223, "paddingRight", 1);
          _$setProp(_el$223, "flexDirection", "column");
          _$setProp(_el$223, "onMouseUp", () => selectRecommendation(item.sourceIndex));
          _$setProp(_el$223, "onKeyDown", (event) => {
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
          _$insertNode(_el$224, _el$225);
          _$insertNode(_el$224, _el$226);
          _$setProp(_el$224, "wrapMode", "word");
          _$insert(_el$224, (() => {
            var _c$5 = _$memo(() => item.attention === "critical");
            return () => _c$5() ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "";
          })(), _el$225);
          _$insert(_el$224, () => item.target, _el$225);
          _$insert(_el$224, () => item.state.replaceAll("-", " "), _el$226);
          _$insert(_el$224, () => relativeTime(item.updatedAt), null);
          _$setProp(_el$227, "wrapMode", "word");
          _$insert(_el$227, () => item.rationale);
          _$insertNode(_el$228, _el$229);
          _$insertNode(_el$228, _el$230);
          _$insert(_el$228, () => item.risk ?? "Loading", _el$230);
          _$insert(_el$228, () => item.evidenceCount ?? "Loading", null);
          _$effect((_p$) => {
            var _v$27 = recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _v$28 = props.api.theme.current.textMuted, _v$29 = props.api.theme.current.textMuted;
            _v$27 !== _p$.e && (_p$.e = _$setProp(_el$223, "borderColor", _v$27, _p$.e));
            _v$28 !== _p$.t && (_p$.t = _$setProp(_el$227, "fg", _v$28, _p$.t));
            _v$29 !== _p$.a && (_p$.a = _$setProp(_el$228, "fg", _v$29, _p$.a));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined
          });
          return _el$223;
        })()), null);
        _$insert(_el$58, _$createComponent(Show, {
          get when() {
            return recommendations().selected;
          },
          children: (selected) => (() => {
            var _el$231 = _$createElement("box"), _el$232 = _$createElement("text"), _el$233 = _$createElement("b"), _el$241 = _$createElement("box"), _el$242 = _$createElement("box"), _el$243 = _$createElement("text");
            _$insertNode(_el$231, _el$232);
            _$insertNode(_el$231, _el$241);
            _$setProp(_el$231, "border", true);
            _$setProp(_el$231, "paddingLeft", 1);
            _$setProp(_el$231, "paddingRight", 1);
            _$setProp(_el$231, "flexDirection", "column");
            _$setProp(_el$231, "gap", 1);
            _$insertNode(_el$232, _el$233);
            _$insert(_el$233, () => selected().target);
            _$insert(_el$231, _$createComponent(Show, {
              get when() {
                return selected().loading;
              },
              get children() {
                var _el$234 = _$createElement("text");
                _$insertNode(_el$234, _$createTextNode(`Loading authoritative recommendation detail\u2026`));
                return _el$234;
              }
            }), _el$241);
            _$insert(_el$231, _$createComponent(Show, {
              get when() {
                return selected().summary;
              },
              children: (summary) => [(() => {
                var _el$247 = _$createElement("box"), _el$248 = _$createElement("text"), _el$249 = _$createElement("b"), _el$251 = _$createElement("text");
                _$insertNode(_el$247, _el$248);
                _$insertNode(_el$247, _el$251);
                _$setProp(_el$247, "flexDirection", "column");
                _$insertNode(_el$248, _el$249);
                _$insertNode(_el$249, _$createTextNode(`Why this was suggested`));
                _$setProp(_el$251, "wrapMode", "word");
                _$insert(_el$251, () => summary().rationale);
                return _el$247;
              })(), (() => {
                var _el$252 = _$createElement("box"), _el$253 = _$createElement("text"), _el$254 = _$createElement("b");
                _$insertNode(_el$252, _el$253);
                _$setProp(_el$252, "flexDirection", "column");
                _$insertNode(_el$253, _el$254);
                _$insertNode(_el$254, _$createTextNode(`Proposed change`));
                _$insert(_el$252, () => selected().diff?.lines.map((line) => (() => {
                  var _el$295 = _$createElement("text");
                  _$setProp(_el$295, "wrapMode", "word");
                  _$insert(_el$295, line);
                  return _el$295;
                })()) ?? [], null);
                _$insert(_el$252, _$createComponent(Show, {
                  get when() {
                    return selected().diff?.overflow?.truncated;
                  },
                  get children() {
                    var _el$256 = _$createElement("text");
                    _$insertNode(_el$256, _$createTextNode(`The proposed change was truncated by the bounded projection.`));
                    _$effect((_$p) => _$setProp(_el$256, "fg", props.api.theme.current.warning, _$p));
                    return _el$256;
                  }
                }), null);
                return _el$252;
              })(), (() => {
                var _el$258 = _$createElement("box"), _el$259 = _$createElement("text"), _el$260 = _$createElement("b");
                _$insertNode(_el$258, _el$259);
                _$setProp(_el$258, "flexDirection", "column");
                _$insertNode(_el$259, _el$260);
                _$insertNode(_el$260, _$createTextNode(`Evidence`));
                _$insert(_el$258, () => selected().evidence.map((entry) => (() => {
                  var _el$296 = _$createElement("text"), _el$297 = _$createTextNode(`: `);
                  _$insertNode(_el$296, _el$297);
                  _$setProp(_el$296, "wrapMode", "word");
                  _$insert(_el$296, () => entry.kind, _el$297);
                  _$insert(_el$296, () => entry.summary, null);
                  _$insert(_el$296, () => entry.redacted ? " [redacted]" : "", null);
                  return _el$296;
                })()), null);
                _$insert(_el$258, _$createComponent(Show, {
                  get when() {
                    return !selected().evidence.length;
                  },
                  get children() {
                    var _el$262 = _$createElement("text");
                    _$insertNode(_el$262, _$createTextNode(`No bounded evidence detail is loaded.`));
                    return _el$262;
                  }
                }), null);
                return _el$258;
              })(), (() => {
                var _el$264 = _$createElement("box"), _el$265 = _$createElement("text"), _el$266 = _$createElement("b"), _el$268 = _$createElement("text"), _el$269 = _$createTextNode(`Critic: `), _el$270 = _$createElement("text"), _el$271 = _$createTextNode(`Deterministic checks: `), _el$272 = _$createElement("text"), _el$273 = _$createTextNode(`Injection scan: `);
                _$insertNode(_el$264, _el$265);
                _$insertNode(_el$264, _el$268);
                _$insertNode(_el$264, _el$270);
                _$insertNode(_el$264, _el$272);
                _$setProp(_el$264, "flexDirection", "column");
                _$insertNode(_el$265, _el$266);
                _$insertNode(_el$266, _$createTextNode(`Safety checks`));
                _$insertNode(_el$268, _el$269);
                _$insert(_el$268, () => summary().criticPassed ? "Passed" : "Not passed", null);
                _$insertNode(_el$270, _el$271);
                _$insert(_el$270, () => summary().validDeterministic ? "Passed" : "Not passed", null);
                _$insertNode(_el$272, _el$273);
                _$insert(_el$272, () => summary().injectionFlagged ? "Flagged" : "Clear", null);
                _$insert(_el$264, () => summary().eligibility.checks.map((check) => (() => {
                  var _el$298 = _$createElement("text"), _el$299 = _$createTextNode(`[`), _el$300 = _$createTextNode(`] `), _el$301 = _$createTextNode(`: `), _el$302 = _$createTextNode(` / `);
                  _$insertNode(_el$298, _el$299);
                  _$insertNode(_el$298, _el$300);
                  _$insertNode(_el$298, _el$301);
                  _$insertNode(_el$298, _el$302);
                  _$setProp(_el$298, "wrapMode", "word");
                  _$insert(_el$298, () => check.met ? "Passed" : "Blocked", _el$300);
                  _$insert(_el$298, () => check.name, _el$301);
                  _$insert(_el$298, () => check.actual, _el$302);
                  _$insert(_el$298, () => check.required, null);
                  return _el$298;
                })()), null);
                return _el$264;
              })(), (() => {
                var _el$274 = _$createElement("box"), _el$275 = _$createElement("text"), _el$276 = _$createElement("b"), _el$278 = _$createElement("text"), _el$279 = _$createTextNode(` estimated / `), _el$280 = _$createTextNode(` budgeted tokens`);
                _$insertNode(_el$274, _el$275);
                _$insertNode(_el$274, _el$278);
                _$setProp(_el$274, "flexDirection", "column");
                _$insertNode(_el$275, _el$276);
                _$insertNode(_el$276, _$createTextNode(`Token impact`));
                _$insertNode(_el$278, _el$279);
                _$insertNode(_el$278, _el$280);
                _$insert(_el$278, () => summary().tokenImpact.estimatedTokens, _el$279);
                _$insert(_el$278, () => summary().tokenImpact.budgetTokens, _el$280);
                return _el$274;
              })(), (() => {
                var _el$281 = _$createElement("box"), _el$282 = _$createElement("text"), _el$283 = _$createElement("b"), _el$285 = _$createElement("text");
                _$insertNode(_el$281, _el$282);
                _$insertNode(_el$281, _el$285);
                _$setProp(_el$281, "flexDirection", "column");
                _$insertNode(_el$282, _el$283);
                _$insertNode(_el$283, _$createTextNode(`Rollback`));
                _$insert(_el$285, (() => {
                  var _c$6 = _$memo(() => !!summary().rollback.eligible);
                  return () => _c$6() ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`;
                })());
                return _el$281;
              })(), (() => {
                var _el$286 = _$createElement("box"), _el$287 = _$createElement("text"), _el$288 = _$createTextNode(`Technical details `);
                _$insertNode(_el$286, _el$287);
                _$setProp(_el$286, "focusable", true);
                _$setProp(_el$286, "border", true);
                _$setProp(_el$286, "paddingLeft", 1);
                _$setProp(_el$286, "paddingRight", 1);
                _$setProp(_el$286, "onMouseUp", () => setTechnicalExpanded((value) => !value));
                _$setProp(_el$286, "onKeyDown", (event) => {
                  if (!isActivationKey(event))
                    return;
                  event.preventDefault();
                  setTechnicalExpanded((value) => !value);
                });
                _$insertNode(_el$287, _el$288);
                _$insert(_el$287, () => technicalExpanded() ? "\u25B2" : "\u25BC", null);
                _$effect((_$p) => _$setProp(_el$286, "borderColor", technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                return _el$286;
              })(), _$createComponent(Show, {
                get when() {
                  return technicalExpanded();
                },
                get children() {
                  return [(() => {
                    var _el$289 = _$createElement("text"), _el$290 = _$createTextNode(`State: `);
                    _$insertNode(_el$289, _el$290);
                    _$insert(_el$289, () => summary().state, null);
                    return _el$289;
                  })(), (() => {
                    var _el$291 = _$createElement("text"), _el$292 = _$createTextNode(`Effective mode: `);
                    _$insertNode(_el$291, _el$292);
                    _$insert(_el$291, () => summary().effectiveMode, null);
                    return _el$291;
                  })(), (() => {
                    var _el$293 = _$createElement("text"), _el$294 = _$createTextNode(`Operation: `);
                    _$insertNode(_el$293, _el$294);
                    _$insert(_el$293, () => summary().operation.status, null);
                    return _el$293;
                  })(), () => selected().audit.map((entry) => (() => {
                    var _el$303 = _$createElement("text"), _el$304 = _$createTextNode(`: `);
                    _$insertNode(_el$303, _el$304);
                    _$setProp(_el$303, "wrapMode", "word");
                    _$insert(_el$303, () => entry.kind, _el$304);
                    _$insert(_el$303, () => entry.summary, null);
                    return _el$303;
                  })())];
                }
              })]
            }), _el$241);
            _$insert(_el$231, _$createComponent(Show, {
              get when() {
                return selected().actions.some((action) => action.action === "reject-proposal" && action.feedbackSupported);
              },
              get children() {
                var _el$236 = _$createElement("box"), _el$237 = _$createElement("text"), _el$239 = _$createElement("box");
                _$insertNode(_el$236, _el$237);
                _$insertNode(_el$236, _el$239);
                _$setProp(_el$236, "flexDirection", "column");
                _$insertNode(_el$237, _$createTextNode(`Optional rejection feedback (audit-only)`));
                _$setProp(_el$239, "flexDirection", "row");
                _$setProp(_el$239, "gap", 1);
                _$setProp(_el$239, "flexWrap", "wrap");
                _$insert(_el$239, () => recommendations().rejectionFeedbackOptions.map((option) => (() => {
                  var _el$305 = _$createElement("box"), _el$306 = _$createElement("text");
                  _$insertNode(_el$305, _el$306);
                  _$setProp(_el$305, "focusable", true);
                  _$setProp(_el$305, "border", true);
                  _$setProp(_el$305, "paddingLeft", 1);
                  _$setProp(_el$305, "paddingRight", 1);
                  _$setProp(_el$305, "onMouseUp", () => setRejectionReason(rejectionReason() === option.value ? null : option.value));
                  _$setProp(_el$305, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setRejectionReason(rejectionReason() === option.value ? null : option.value);
                  });
                  _$insert(_el$306, () => option.label);
                  _$effect((_$p) => _$setProp(_el$305, "borderColor", rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
                  return _el$305;
                })()));
                _$insert(_el$236, _$createComponent(Show, {
                  get when() {
                    return rejectionReason() === "other";
                  },
                  get children() {
                    var _el$240 = _$createElement("input");
                    _$setProp(_el$240, "placeholder", "Optional bounded reason (512 characters)");
                    _$setProp(_el$240, "onInput", (value) => setRejectionText(value.slice(0, 512)));
                    _$effect((_$p) => _$setProp(_el$240, "value", rejectionText(), _$p));
                    return _el$240;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$237, "fg", props.api.theme.current.textMuted, _$p));
                return _el$236;
              }
            }), _el$241);
            _$insertNode(_el$241, _el$242);
            _$setProp(_el$241, "flexDirection", "row");
            _$setProp(_el$241, "gap", 1);
            _$setProp(_el$241, "flexWrap", "wrap");
            _$insert(_el$241, () => selected().actions.flatMap((action) => {
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
                  var _el$307 = _$createElement("box"), _el$308 = _$createElement("text");
                  _$insertNode(_el$307, _el$308);
                  _$setProp(_el$307, "border", true);
                  _$setProp(_el$307, "paddingLeft", 1);
                  _$setProp(_el$307, "paddingRight", 1);
                  _$setProp(_el$307, "onMouseUp", () => void activateRecommendation(action.action, choice.delay));
                  _$setProp(_el$307, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    activateRecommendation(action.action, choice.delay);
                  });
                  _$insert(_el$308, (() => {
                    var _c$7 = _$memo(() => confirmation() === key);
                    return () => _c$7() ? `Confirm ${choice.label}` : choice.label;
                  })());
                  _$effect((_p$) => {
                    var _v$32 = !pendingRecommendation(), _v$33 = confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle;
                    _v$32 !== _p$.e && (_p$.e = _$setProp(_el$307, "focusable", _v$32, _p$.e));
                    _v$33 !== _p$.t && (_p$.t = _$setProp(_el$307, "borderColor", _v$33, _p$.t));
                    return _p$;
                  }, {
                    e: undefined,
                    t: undefined
                  });
                  return _el$307;
                })();
              });
            }), _el$242);
            _$insertNode(_el$242, _el$243);
            _$setProp(_el$242, "focusable", true);
            _$setProp(_el$242, "border", true);
            _$setProp(_el$242, "paddingLeft", 1);
            _$setProp(_el$242, "paddingRight", 1);
            _$setProp(_el$242, "onMouseUp", () => void activateRecommendation("open-activity"));
            _$setProp(_el$242, "onKeyDown", (event) => {
              if (!isActivationKey(event))
                return;
              event.preventDefault();
              activateRecommendation("open-activity");
            });
            _$insertNode(_el$243, _$createTextNode(`Open in Activity`));
            _$insert(_el$231, _$createComponent(Show, {
              get when() {
                return pendingRecommendation();
              },
              get children() {
                var _el$245 = _$createElement("text");
                _$insertNode(_el$245, _$createTextNode(`Request pending server validation\u2026`));
                _$effect((_$p) => _$setProp(_el$245, "fg", props.api.theme.current.info, _$p));
                return _el$245;
              }
            }), null);
            _$effect((_p$) => {
              var _v$30 = props.api.theme.current.borderActive, _v$31 = props.api.theme.current.borderSubtle;
              _v$30 !== _p$.e && (_p$.e = _$setProp(_el$231, "borderColor", _v$30, _p$.e));
              _v$31 !== _p$.t && (_p$.t = _$setProp(_el$242, "borderColor", _v$31, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$231;
          })()
        }), null);
        return _el$58;
      }
    }), null);
    _$insert(_el$18, _$createComponent(Show, {
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
          var _el$309 = _$createElement("box"), _el$310 = _$createElement("text");
          _$insertNode(_el$309, _el$310);
          _$setProp(_el$309, "focusable", true);
          _$setProp(_el$309, "border", true);
          _$setProp(_el$309, "paddingLeft", 1);
          _$setProp(_el$309, "paddingRight", 1);
          _$setProp(_el$309, "onMouseUp", () => {
            setActivityFilter(value);
            setActivityExpanded(null);
          });
          _$setProp(_el$309, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setActivityFilter(value);
            setActivityExpanded(null);
          });
          _$insert(_el$310, label);
          _$effect((_$p) => _$setProp(_el$309, "borderColor", activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$309;
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
        _$insert(_el$64, () => activity().activity.map((entry, index) => (() => {
          var _el$311 = _$createElement("box"), _el$312 = _$createElement("text"), _el$313 = _$createTextNode(`[`), _el$314 = _$createTextNode(`] `), _el$315 = _$createTextNode(` \xB7 `);
          _$insertNode(_el$311, _el$312);
          _$setProp(_el$311, "focusable", true);
          _$setProp(_el$311, "border", true);
          _$setProp(_el$311, "paddingLeft", 1);
          _$setProp(_el$311, "paddingRight", 1);
          _$setProp(_el$311, "flexDirection", "column");
          _$setProp(_el$311, "onMouseUp", () => setActivityExpanded(activityExpanded() === index ? null : index));
          _$setProp(_el$311, "onKeyDown", (event) => {
            if (isActivationKey(event)) {
              event.preventDefault();
              setActivityExpanded(activityExpanded() === index ? null : index);
            } else if (event.name === "right" && entry.destination?.section === "recommendations") {
              event.preventDefault();
              openActivityDestination(entry);
            }
          });
          _$insertNode(_el$312, _el$313);
          _$insertNode(_el$312, _el$314);
          _$insertNode(_el$312, _el$315);
          _$setProp(_el$312, "wrapMode", "word");
          _$insert(_el$312, () => entry.marker, _el$314);
          _$insert(_el$312, () => entry.summary, _el$315);
          _$insert(_el$312, () => relativeTime(entry.occurredAt), null);
          _$insert(_el$311, _$createComponent(Show, {
            get when() {
              return entry.target;
            },
            get children() {
              var _el$316 = _$createElement("text"), _el$317 = _$createTextNode(`Skill: `);
              _$insertNode(_el$316, _el$317);
              _$insert(_el$316, () => entry.target, null);
              _$effect((_$p) => _$setProp(_el$316, "fg", props.api.theme.current.textMuted, _$p));
              return _el$316;
            }
          }), null);
          _$insert(_el$311, _$createComponent(Show, {
            get when() {
              return activityExpanded() === index;
            },
            get children() {
              return [(() => {
                var _el$318 = _$createElement("text"), _el$319 = _$createTextNode(`Category: `);
                _$insertNode(_el$318, _el$319);
                _$insert(_el$318, () => entry.technical.category, null);
                _$effect((_$p) => _$setProp(_el$318, "fg", props.api.theme.current.textMuted, _$p));
                return _el$318;
              })(), (() => {
                var _el$320 = _$createElement("text"), _el$321 = _$createTextNode(`Outcome: `);
                _$insertNode(_el$320, _el$321);
                _$insert(_el$320, () => entry.technical.outcome.replaceAll("-", " "), null);
                _$effect((_$p) => _$setProp(_el$320, "fg", props.api.theme.current.textMuted, _$p));
                return _el$320;
              })(), _$createComponent(Show, {
                get when() {
                  return entry.technical.reason;
                },
                children: (reason) => (() => {
                  var _el$325 = _$createElement("text"), _el$326 = _$createTextNode(`Reason: `);
                  _$insertNode(_el$325, _el$326);
                  _$insert(_el$325, () => reason().replaceAll("-", " "), null);
                  _$effect((_$p) => _$setProp(_el$325, "fg", props.api.theme.current.textMuted, _$p));
                  return _el$325;
                })()
              }), _$createComponent(Show, {
                get when() {
                  return entry.destination?.section === "recommendations";
                },
                get children() {
                  var _el$322 = _$createElement("box"), _el$323 = _$createElement("text");
                  _$insertNode(_el$322, _el$323);
                  _$setProp(_el$322, "focusable", true);
                  _$setProp(_el$322, "border", true);
                  _$setProp(_el$322, "paddingLeft", 1);
                  _$setProp(_el$322, "paddingRight", 1);
                  _$setProp(_el$322, "onMouseUp", () => openActivityDestination(entry));
                  _$setProp(_el$322, "onKeyDown", (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    openActivityDestination(entry);
                  });
                  _$insertNode(_el$323, _$createTextNode(`Open recommendation`));
                  _$effect((_$p) => _$setProp(_el$322, "borderColor", props.api.theme.current.borderSubtle, _$p));
                  return _el$322;
                }
              })];
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$311, "borderColor", activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$311;
        })()), _el$71);
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
        _$setProp(_el$71, "onMouseUp", () => setDiagnosticsExpanded((value) => !value));
        _$setProp(_el$71, "onKeyDown", (event) => {
          if (!isActivationKey(event))
            return;
          event.preventDefault();
          setDiagnosticsExpanded((value) => !value);
        });
        _$insertNode(_el$72, _el$73);
        _$insert(_el$72, () => diagnosticsExpanded() ? "\u25B2" : "\u25BC", null);
        _$insert(_el$64, _$createComponent(Show, {
          get when() {
            return diagnosticsExpanded();
          },
          get children() {
            var _el$74 = _$createElement("box"), _el$75 = _$createElement("text"), _el$76 = _$createTextNode(`Projection refreshed: `), _el$77 = _$createElement("text"), _el$78 = _$createTextNode(`Core projection: `), _el$79 = _$createElement("text"), _el$80 = _$createTextNode(`Enhanced projection: `), _el$81 = _$createElement("text"), _el$82 = _$createTextNode(`OpenCode: `), _el$83 = _$createTextNode(` (`), _el$84 = _$createTextNode(`)`), _el$85 = _$createElement("text"), _el$86 = _$createTextNode(`Self-evolve: `), _el$87 = _$createElement("text"), _el$88 = _$createTextNode(`Projection protocol: `), _el$89 = _$createElement("text"), _el$90 = _$createTextNode(`Dashboard protocol: `), _el$91 = _$createElement("text"), _el$92 = _$createTextNode(`Refresh watcher: `), _el$93 = _$createElement("text"), _el$94 = _$createTextNode(`Circuit breaker: `);
            _$insertNode(_el$74, _el$75);
            _$insertNode(_el$74, _el$77);
            _$insertNode(_el$74, _el$79);
            _$insertNode(_el$74, _el$81);
            _$insertNode(_el$74, _el$85);
            _$insertNode(_el$74, _el$87);
            _$insertNode(_el$74, _el$89);
            _$insertNode(_el$74, _el$91);
            _$insertNode(_el$74, _el$93);
            _$setProp(_el$74, "flexDirection", "column");
            _$insertNode(_el$75, _el$76);
            _$setProp(_el$75, "wrapMode", "word");
            _$insert(_el$75, (() => {
              var _c$ = _$memo(() => !!activity().diagnostics.refreshedAt);
              return () => _c$() ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable";
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
            _$insert(_el$81, () => activity().diagnostics.runtime.hostVersion, _el$83);
            _$insert(_el$81, () => activity().diagnostics.runtime.hostVersionSource, _el$84);
            _$insertNode(_el$85, _el$86);
            _$setProp(_el$85, "wrapMode", "word");
            _$insert(_el$85, () => activity().diagnostics.runtime.pluginVersion, null);
            _$insertNode(_el$87, _el$88);
            _$setProp(_el$87, "wrapMode", "word");
            _$insert(_el$87, () => activity().diagnostics.runtime.projectionVersion ?? "Unavailable", null);
            _$insertNode(_el$89, _el$90);
            _$setProp(_el$89, "wrapMode", "word");
            _$insert(_el$89, () => activity().diagnostics.runtime.dashboardVersion ?? "Unavailable", null);
            _$insertNode(_el$91, _el$92);
            _$setProp(_el$91, "wrapMode", "word");
            _$insert(_el$91, () => activity().diagnostics.watcherStatus, null);
            _$insertNode(_el$93, _el$94);
            _$setProp(_el$93, "wrapMode", "word");
            _$insert(_el$93, () => activity().diagnostics.breakerStatus, null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.automation;
              },
              children: (automation) => (() => {
                var _el$327 = _$createElement("text"), _el$328 = _$createTextNode(`Scheduler: `);
                _$insertNode(_el$327, _el$328);
                _$setProp(_el$327, "wrapMode", "word");
                _$insert(_el$327, () => automation().state.replaceAll("-", " "), null);
                return _el$327;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.backoffUntil;
              },
              children: (backoffUntil) => (() => {
                var _el$329 = _$createElement("text"), _el$330 = _$createTextNode(`Backoff ends: `);
                _$insertNode(_el$329, _el$330);
                _$setProp(_el$329, "wrapMode", "word");
                _$insert(_el$329, () => new Date(backoffUntil()).toISOString(), null);
                return _el$329;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.nextEligibleAt;
              },
              children: (nextEligibleAt) => (() => {
                var _el$331 = _$createElement("text"), _el$332 = _$createTextNode(`Next eligible: `);
                _$insertNode(_el$331, _el$332);
                _$setProp(_el$331, "wrapMode", "word");
                _$insert(_el$331, () => new Date(nextEligibleAt()).toISOString(), null);
                return _el$331;
              })()
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.usage;
              },
              children: (usage) => [(() => {
                var _el$333 = _$createElement("text"), _el$334 = _$createTextNode(`Background analysis used/remaining: `), _el$335 = _$createTextNode(` / `);
                _$insertNode(_el$333, _el$334);
                _$insertNode(_el$333, _el$335);
                _$setProp(_el$333, "wrapMode", "word");
                _$insert(_el$333, () => usage().passive.used, _el$335);
                _$insert(_el$333, () => usage().passive.remaining, null);
                return _el$333;
              })(), (() => {
                var _el$336 = _$createElement("text"), _el$337 = _$createTextNode(`Recommendation synthesis used/remaining: `), _el$338 = _$createTextNode(` / `);
                _$insertNode(_el$336, _el$337);
                _$insertNode(_el$336, _el$338);
                _$setProp(_el$336, "wrapMode", "word");
                _$insert(_el$336, () => usage().synthesis.used, _el$338);
                _$insert(_el$336, () => usage().synthesis.remaining, null);
                return _el$336;
              })(), (() => {
                var _el$339 = _$createElement("text"), _el$340 = _$createTextNode(`Storage used/quota: `), _el$341 = _$createTextNode(` / `), _el$342 = _$createTextNode(` bytes`);
                _$insertNode(_el$339, _el$340);
                _$insertNode(_el$339, _el$341);
                _$insertNode(_el$339, _el$342);
                _$setProp(_el$339, "wrapMode", "word");
                _$insert(_el$339, () => usage().storage.usedBytes, _el$341);
                _$insert(_el$339, () => usage().storage.limitBytes, _el$342);
                return _el$339;
              })(), _$createComponent(Show, {
                get when() {
                  return activity().diagnostics.budgetResetAt;
                },
                children: (budgetResetAt) => [(() => {
                  var _el$343 = _$createElement("text"), _el$344 = _$createTextNode(`Background analysis resets: `);
                  _$insertNode(_el$343, _el$344);
                  _$setProp(_el$343, "wrapMode", "word");
                  _$insert(_el$343, () => new Date(budgetResetAt().passive).toISOString(), null);
                  return _el$343;
                })(), (() => {
                  var _el$345 = _$createElement("text"), _el$346 = _$createTextNode(`Recommendation synthesis resets: `);
                  _$insertNode(_el$345, _el$346);
                  _$setProp(_el$345, "wrapMode", "word");
                  _$insert(_el$345, () => new Date(budgetResetAt().synthesis).toISOString(), null);
                  return _el$345;
                })()]
              })]
            }), null);
            _$insert(_el$74, _$createComponent(Show, {
              get when() {
                return activity().diagnostics.lastError;
              },
              children: (lastError) => (() => {
                var _el$347 = _$createElement("text"), _el$348 = _$createTextNode(`Last bounded error: `);
                _$insertNode(_el$347, _el$348);
                _$setProp(_el$347, "wrapMode", "word");
                _$insert(_el$347, () => lastError().summary, null);
                return _el$347;
              })()
            }), null);
            return _el$74;
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$71, "borderColor", diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
        return _el$64;
      }
    }), null);
    _$insert(_el$18, _$createComponent(Show, {
      get when() {
        return section() === "settings";
      },
      get children() {
        var _el$95 = _$createElement("box"), _el$96 = _$createElement("text"), _el$97 = _$createElement("b"), _el$102 = _$createElement("text"), _el$103 = _$createElement("b"), _el$105 = _$createElement("text"), _el$106 = _$createTextNode(`Effective result: `), _el$107 = _$createElement("text"), _el$108 = _$createTextNode(`Global default: `), _el$109 = _$createElement("text"), _el$110 = _$createTextNode(`This project: `), _el$111 = _$createElement("text"), _el$127 = _$createElement("text"), _el$128 = _$createElement("b"), _el$130 = _$createElement("box"), _el$131 = _$createElement("text"), _el$132 = _$createElement("b"), _el$134 = _$createTextNode(`: `), _el$135 = _$createElement("text"), _el$137 = _$createElement("text"), _el$138 = _$createTextNode(`Pause automatic work: `), _el$139 = _$createTextNode(`. Pause preserves modes and consent.`), _el$140 = _$createElement("text"), _el$141 = _$createTextNode(`Emergency stop: `), _el$142 = _$createTextNode(`. It overrides every automatic provider and write path.`), _el$143 = _$createElement("text"), _el$144 = _$createElement("b"), _el$146 = _$createElement("text"), _el$154 = _$createElement("text"), _el$155 = _$createElement("b"), _el$157 = _$createElement("text"), _el$159 = _$createElement("text"), _el$160 = _$createElement("b"), _el$162 = _$createElement("text"), _el$164 = _$createElement("box"), _el$165 = _$createElement("text"), _el$166 = _$createElement("box"), _el$173 = _$createElement("text"), _el$174 = _$createTextNode(`OpenCode `), _el$175 = _$createTextNode(` \xB7 Self-evolve `), _el$176 = _$createTextNode(` \xB7 Projection `), _el$177 = _$createTextNode(` \xB7 Dashboard `), _el$178 = _$createElement("text");
        _$insertNode(_el$95, _el$96);
        _$insertNode(_el$95, _el$102);
        _$insertNode(_el$95, _el$105);
        _$insertNode(_el$95, _el$107);
        _$insertNode(_el$95, _el$109);
        _$insertNode(_el$95, _el$111);
        _$insertNode(_el$95, _el$127);
        _$insertNode(_el$95, _el$130);
        _$insertNode(_el$95, _el$137);
        _$insertNode(_el$95, _el$140);
        _$insertNode(_el$95, _el$143);
        _$insertNode(_el$95, _el$146);
        _$insertNode(_el$95, _el$154);
        _$insertNode(_el$95, _el$157);
        _$insertNode(_el$95, _el$159);
        _$insertNode(_el$95, _el$162);
        _$insertNode(_el$95, _el$164);
        _$insertNode(_el$95, _el$165);
        _$insertNode(_el$95, _el$166);
        _$insertNode(_el$95, _el$173);
        _$insertNode(_el$95, _el$178);
        _$setProp(_el$95, "flexDirection", "column");
        _$setProp(_el$95, "gap", 1);
        _$insertNode(_el$96, _el$97);
        _$insertNode(_el$97, _$createTextNode(`Settings`));
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settingsAnchor();
          },
          children: (anchor) => (() => {
            var _el$349 = _$createElement("text"), _el$350 = _$createTextNode(`Opened at `), _el$351 = _$createTextNode(` settings.`);
            _$insertNode(_el$349, _el$350);
            _$insertNode(_el$349, _el$351);
            _$setProp(_el$349, "wrapMode", "word");
            _$insert(_el$349, () => anchor().replaceAll("-", " "), _el$351);
            _$effect((_$p) => _$setProp(_el$349, "fg", props.api.theme.current.info, _$p));
            return _el$349;
          })()
        }), _el$102);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().limited;
          },
          get children() {
            var _el$99 = _$createElement("text");
            _$insertNode(_el$99, _$createTextNode(`Limited view: enhanced usage, repository-mode editing, and prerequisite status require an aligned server.`));
            _$setProp(_el$99, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$99, "fg", props.api.theme.current.warning, _$p));
            return _el$99;
          }
        }), _el$102);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().enhancedError;
          },
          get children() {
            var _el$101 = _$createElement("text");
            _$setProp(_el$101, "wrapMode", "word");
            _$insert(_el$101, () => settings().enhancedError);
            _$effect((_$p) => _$setProp(_el$101, "fg", props.api.theme.current.error, _$p));
            return _el$101;
          }
        }), _el$102);
        _$insertNode(_el$102, _el$103);
        _$insertNode(_el$103, _$createTextNode(`Modes`));
        _$insertNode(_el$105, _el$106);
        _$setProp(_el$105, "wrapMode", "word");
        _$insert(_el$105, () => settings().mode.effective.label, null);
        _$insertNode(_el$107, _el$108);
        _$setProp(_el$107, "wrapMode", "word");
        _$insert(_el$107, () => settings().mode.global.label, null);
        _$insertNode(_el$109, _el$110);
        _$setProp(_el$109, "wrapMode", "word");
        _$insert(_el$109, () => settings().mode.repository.label, null);
        _$insertNode(_el$111, _$createTextNode(`The global default applies to every current and future project. \u201CUse for this project\u201D creates an override here only.`));
        _$setProp(_el$111, "wrapMode", "word");
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return _$memo(() => !!(settings().controls.globalMode && settings().controls.consent))() && !automaticRecommendationsReady();
          },
          get children() {
            var _el$113 = _$createElement("box"), _el$114 = _$createElement("text"), _el$115 = _$createElement("b"), _el$117 = _$createElement("text");
            _$insertNode(_el$113, _el$114);
            _$insertNode(_el$113, _el$117);
            _$setProp(_el$113, "border", true);
            _$setProp(_el$113, "paddingLeft", 1);
            _$setProp(_el$113, "paddingRight", 1);
            _$setProp(_el$113, "flexDirection", "column");
            _$setProp(_el$113, "gap", 1);
            _$insertNode(_el$114, _el$115);
            _$insertNode(_el$115, _$createTextNode(`Automatic recommendations setup`));
            _$insertNode(_el$117, _$createTextNode(`One confirmation enables background AI analysis, saved structured patterns, and the Analyze and recommend global mode in sequence. Sanitized excerpts remain a separate choice.`));
            _$setProp(_el$117, "wrapMode", "word");
            _$insert(_el$113, () => actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true), null);
            _$effect((_$p) => _$setProp(_el$113, "borderColor", props.api.theme.current.info, _$p));
            return _el$113;
          }
        }), _el$127);
        _$insert(_el$95, () => settings().modes.map((mode) => (() => {
          var _el$352 = _$createElement("box"), _el$353 = _$createElement("text"), _el$354 = _$createElement("b"), _el$355 = _$createElement("text"), _el$356 = _$createElement("text"), _el$357 = _$createTextNode(`Provider use: `), _el$358 = _$createElement("text"), _el$359 = _$createTextNode(`Saved data: `), _el$360 = _$createElement("text"), _el$361 = _$createTextNode(`Write authority: `), _el$362 = _$createElement("text"), _el$363 = _$createTextNode(`Prerequisites: `);
          _$insertNode(_el$352, _el$353);
          _$insertNode(_el$352, _el$355);
          _$insertNode(_el$352, _el$356);
          _$insertNode(_el$352, _el$358);
          _$insertNode(_el$352, _el$360);
          _$insertNode(_el$352, _el$362);
          _$setProp(_el$352, "border", true);
          _$setProp(_el$352, "paddingLeft", 1);
          _$setProp(_el$352, "paddingRight", 1);
          _$setProp(_el$352, "flexDirection", "column");
          _$insertNode(_el$353, _el$354);
          _$insert(_el$354, () => mode.label);
          _$insert(_el$353, () => settings().mode.effective.value === mode.value ? " \xB7 Effective now" : "", null);
          _$setProp(_el$355, "wrapMode", "word");
          _$insert(_el$355, () => mode.description);
          _$insertNode(_el$356, _el$357);
          _$setProp(_el$356, "wrapMode", "word");
          _$insert(_el$356, () => mode.providerUse, null);
          _$insertNode(_el$358, _el$359);
          _$setProp(_el$358, "wrapMode", "word");
          _$insert(_el$358, () => mode.savedData, null);
          _$insertNode(_el$360, _el$361);
          _$setProp(_el$360, "wrapMode", "word");
          _$insert(_el$360, () => mode.writeAuthority, null);
          _$insertNode(_el$362, _el$363);
          _$setProp(_el$362, "wrapMode", "word");
          _$insert(_el$362, () => mode.prerequisites, null);
          _$insert(_el$352, _$createComponent(Show, {
            get when() {
              return mode.blockers.length;
            },
            children: () => mode.blockers.map((blocker) => (() => {
              var _el$365 = _$createElement("text"), _el$366 = _$createTextNode(`\u2022 `);
              _$insertNode(_el$365, _el$366);
              _$setProp(_el$365, "wrapMode", "word");
              _$insert(_el$365, blocker, null);
              _$effect((_$p) => _$setProp(_el$365, "fg", props.api.theme.current.warning, _$p));
              return _el$365;
            })())
          }), null);
          _$insert(_el$352, _$createComponent(Show, {
            get when() {
              return mode.available;
            },
            get children() {
              var _el$364 = _$createElement("box");
              _$setProp(_el$364, "flexDirection", "row");
              _$setProp(_el$364, "flexWrap", "wrap");
              _$setProp(_el$364, "gap", 1);
              _$insert(_el$364, _$createComponent(Show, {
                get when() {
                  return settings().controls.globalMode;
                },
                get children() {
                  return localActionButton(settings().mode.global.value === mode.value ? "Global default \u2713" : "Set global default", () => submitMode("global", mode.value), mode.value === "yolo", `global-mode-${mode.value}`);
                }
              }), null);
              _$insert(_el$364, _$createComponent(Show, {
                get when() {
                  return settings().controls.repositoryMode;
                },
                get children() {
                  return localActionButton(settings().mode.repository.value === mode.value ? "This project \u2713" : "Use for this project", () => submitMode("project", mode.value), mode.value === "yolo", `project-mode-${mode.value}`);
                }
              }), null);
              return _el$364;
            }
          }), null);
          _$effect((_p$) => {
            var _v$34 = props.api.theme.current.borderSubtle, _v$35 = props.api.theme.current.textMuted, _v$36 = props.api.theme.current.textMuted, _v$37 = props.api.theme.current.textMuted, _v$38 = props.api.theme.current.textMuted;
            _v$34 !== _p$.e && (_p$.e = _$setProp(_el$352, "borderColor", _v$34, _p$.e));
            _v$35 !== _p$.t && (_p$.t = _$setProp(_el$356, "fg", _v$35, _p$.t));
            _v$36 !== _p$.a && (_p$.a = _$setProp(_el$358, "fg", _v$36, _p$.a));
            _v$37 !== _p$.o && (_p$.o = _$setProp(_el$360, "fg", _v$37, _p$.o));
            _v$38 !== _p$.i && (_p$.i = _$setProp(_el$362, "fg", _v$38, _p$.i));
            return _p$;
          }, {
            e: undefined,
            t: undefined,
            a: undefined,
            o: undefined,
            i: undefined
          });
          return _el$352;
        })()), _el$127);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().controls.repositoryMode;
          },
          get children() {
            return localActionButton(settings().mode.repository.value === "inherit" ? "Inherit global default \u2713" : "Make this project inherit global default", () => submitMode("project", "inherit"), false, "project-mode-inherit");
          }
        }), _el$127);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return yoloTarget();
          },
          get children() {
            var _el$119 = _$createElement("box"), _el$120 = _$createElement("text"), _el$121 = _$createTextNode(`Apply automatically expands write authority for the `), _el$122 = _$createTextNode(`. Approved folders and every current prerequisite will be revalidated by the server.`), _el$123 = _$createElement("text"), _el$125 = _$createElement("input"), _el$126 = _$createElement("box");
            _$insertNode(_el$119, _el$120);
            _$insertNode(_el$119, _el$123);
            _$insertNode(_el$119, _el$125);
            _$insertNode(_el$119, _el$126);
            _$setProp(_el$119, "border", true);
            _$setProp(_el$119, "paddingLeft", 1);
            _$setProp(_el$119, "paddingRight", 1);
            _$setProp(_el$119, "flexDirection", "column");
            _$insertNode(_el$120, _el$121);
            _$insertNode(_el$120, _el$122);
            _$setProp(_el$120, "wrapMode", "word");
            _$insert(_el$120, () => yoloTarget() === "global" ? "global default" : "current project", _el$122);
            _$insertNode(_el$123, _$createTextNode(`Type exactly: ENABLE YOLO`));
            _$setProp(_el$125, "placeholder", "ENABLE YOLO");
            _$setProp(_el$125, "onInput", (value) => setYoloConfirmation(value.slice(0, 64)));
            _$setProp(_el$126, "flexDirection", "row");
            _$setProp(_el$126, "flexWrap", "wrap");
            _$setProp(_el$126, "gap", 1);
            _$insert(_el$126, () => localActionButton("Submit Apply automatically", () => void confirmYolo(), true), null);
            _$insert(_el$126, () => localActionButton("Cancel", () => {
              setYoloTarget(null);
              setYoloConfirmation("");
            }), null);
            _$effect((_p$) => {
              var _v$13 = props.api.theme.current.warning, _v$14 = yoloConfirmation();
              _v$13 !== _p$.e && (_p$.e = _$setProp(_el$119, "borderColor", _v$13, _p$.e));
              _v$14 !== _p$.t && (_p$.t = _$setProp(_el$125, "value", _v$14, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$119;
          }
        }), _el$127);
        _$insertNode(_el$127, _el$128);
        _$insertNode(_el$128, _$createTextNode(`Privacy and project scope`));
        _$insertNode(_el$130, _el$131);
        _$insertNode(_el$130, _el$135);
        _$setProp(_el$130, "border", true);
        _$setProp(_el$130, "paddingLeft", 1);
        _$setProp(_el$130, "paddingRight", 1);
        _$setProp(_el$130, "flexDirection", "column");
        _$insertNode(_el$131, _el$132);
        _$insertNode(_el$131, _el$134);
        _$insertNode(_el$132, _$createTextNode(`Include this project`));
        _$insert(_el$131, () => settings().projectExcluded ? "No" : "Yes", null);
        _$insertNode(_el$135, _$createTextNode(`Excluding this project overrides automatic global modes without changing global settings.`));
        _$setProp(_el$135, "wrapMode", "word");
        _$insert(_el$130, _$createComponent(Show, {
          get when() {
            return settings().controls.projectInclusion;
          },
          get children() {
            return actionButton(settings().projectExcluded ? "include-project" : "exclude-project", settings().projectExcluded ? "Include this project" : "Exclude this project", () => props.store.submitControl("set-repo-excluded", {
              excluded: !settings().projectExcluded
            }), settings().projectExcluded === true);
          }
        }), null);
        _$insert(_el$95, () => settings().consent.map((entry) => (() => {
          var _el$367 = _$createElement("box"), _el$368 = _$createElement("text"), _el$369 = _$createElement("b"), _el$370 = _$createTextNode(`: `), _el$371 = _$createTextNode(` \xB7 `), _el$372 = _$createElement("text"), _el$373 = _$createElement("text");
          _$insertNode(_el$367, _el$368);
          _$insertNode(_el$367, _el$372);
          _$insertNode(_el$367, _el$373);
          _$setProp(_el$367, "border", true);
          _$setProp(_el$367, "paddingLeft", 1);
          _$setProp(_el$367, "paddingRight", 1);
          _$setProp(_el$367, "flexDirection", "column");
          _$insertNode(_el$368, _el$369);
          _$insertNode(_el$368, _el$370);
          _$insertNode(_el$368, _el$371);
          _$insert(_el$369, () => entry.label);
          _$insert(_el$368, () => entry.enabled ? "Allowed" : "Not allowed", _el$371);
          _$insert(_el$368, () => entry.scope, null);
          _$setProp(_el$372, "wrapMode", "word");
          _$insert(_el$372, () => entry.description);
          _$setProp(_el$373, "wrapMode", "word");
          _$insert(_el$373, () => entry.dependency);
          _$insert(_el$367, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!settings().controls.consent)() && (entry.enabled || entry.canEnable);
            },
            get children() {
              return actionButton(`consent-${entry.key}-${entry.enabled ? "off" : "on"}`, entry.enabled ? `Stop allowing ${entry.label}` : `Allow ${entry.label}`, () => props.store.submitControl("set-consent", {
                key: entry.key,
                enabled: !entry.enabled
              }), !entry.enabled);
            }
          }), null);
          _$insert(_el$367, _$createComponent(Show, {
            get when() {
              return _$memo(() => !!!entry.enabled)() && !entry.canEnable;
            },
            get children() {
              var _el$374 = _$createElement("text");
              _$insertNode(_el$374, _$createTextNode(`Resolve the dependency above before enabling this setting.`));
              _$setProp(_el$374, "wrapMode", "word");
              _$effect((_$p) => _$setProp(_el$374, "fg", props.api.theme.current.warning, _$p));
              return _el$374;
            }
          }), null);
          _$effect((_p$) => {
            var _v$39 = props.api.theme.current.borderSubtle, _v$40 = props.api.theme.current.textMuted;
            _v$39 !== _p$.e && (_p$.e = _$setProp(_el$367, "borderColor", _v$39, _p$.e));
            _v$40 !== _p$.t && (_p$.t = _$setProp(_el$373, "fg", _v$40, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$367;
        })()), _el$137);
        _$insertNode(_el$137, _el$138);
        _$insertNode(_el$137, _el$139);
        _$setProp(_el$137, "wrapMode", "word");
        _$insert(_el$137, () => settings().paused ? "Paused" : "Running when eligible", _el$139);
        _$insertNode(_el$140, _el$141);
        _$insertNode(_el$140, _el$142);
        _$setProp(_el$140, "wrapMode", "word");
        _$insert(_el$140, () => settings().emergencyStop ? "On" : "Off", _el$142);
        _$insertNode(_el$143, _el$144);
        _$insertNode(_el$144, _$createTextNode(`Approved skill folders`));
        _$setProp(_el$146, "wrapMode", "word");
        _$insert(_el$146, () => settings().approvedSkillFolderWarning);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return !settings().approvedSkillFolders.length;
          },
          get children() {
            var _el$147 = _$createElement("text");
            _$insertNode(_el$147, _$createTextNode(`No folder is approved; Apply automatically cannot be enabled.`));
            _$setProp(_el$147, "wrapMode", "word");
            _$effect((_$p) => _$setProp(_el$147, "fg", props.api.theme.current.warning, _$p));
            return _el$147;
          }
        }), _el$154);
        _$insert(_el$95, () => settings().approvedSkillFolders.map((folder) => (() => {
          var _el$376 = _$createElement("box"), _el$377 = _$createElement("text");
          _$insertNode(_el$376, _el$377);
          _$setProp(_el$376, "border", true);
          _$setProp(_el$376, "paddingLeft", 1);
          _$setProp(_el$376, "paddingRight", 1);
          _$setProp(_el$376, "flexDirection", "row");
          _$setProp(_el$376, "flexWrap", "wrap");
          _$setProp(_el$376, "gap", 1);
          _$setProp(_el$377, "wrapMode", "word");
          _$insert(_el$377, folder);
          _$insert(_el$376, _$createComponent(Show, {
            get when() {
              return settings().controls.approvedSkillFolders;
            },
            get children() {
              return localActionButton("Remove", () => stageFolderList(settings().approvedSkillFolders.filter((candidate) => candidate !== folder)));
            }
          }), null);
          _$effect((_$p) => _$setProp(_el$376, "borderColor", props.api.theme.current.borderSubtle, _$p));
          return _el$376;
        })()), _el$154);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().controls.approvedSkillFolders;
          },
          get children() {
            var _el$149 = _$createElement("box"), _el$150 = _$createElement("text"), _el$152 = _$createElement("input");
            _$insertNode(_el$149, _el$150);
            _$insertNode(_el$149, _el$152);
            _$setProp(_el$149, "flexDirection", "column");
            _$insertNode(_el$150, _$createTextNode(`Add one canonical absolute folder`));
            _$setProp(_el$152, "placeholder", "/canonical/path/to/skills");
            _$setProp(_el$152, "onInput", (value) => {
              setFolderInput(value.slice(0, 4096));
              setFolderError(null);
            });
            _$insert(_el$149, () => localActionButton("Add folder", stageFolderAdd), null);
            _$effect((_$p) => _$setProp(_el$152, "value", folderInput(), _$p));
            return _el$149;
          }
        }), _el$154);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return folderError();
          },
          get children() {
            var _el$153 = _$createElement("text");
            _$setProp(_el$153, "wrapMode", "word");
            _$insert(_el$153, folderError);
            _$effect((_$p) => _$setProp(_el$153, "fg", props.api.theme.current.warning, _$p));
            return _el$153;
          }
        }), _el$154);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return folderDraft();
          },
          children: (draft) => (() => {
            var _el$378 = _$createElement("box"), _el$379 = _$createElement("text"), _el$380 = _$createElement("b"), _el$384 = _$createElement("text"), _el$386 = _$createElement("input"), _el$387 = _$createElement("box");
            _$insertNode(_el$378, _el$379);
            _$insertNode(_el$378, _el$384);
            _$insertNode(_el$378, _el$386);
            _$insertNode(_el$378, _el$387);
            _$setProp(_el$378, "border", true);
            _$setProp(_el$378, "paddingLeft", 1);
            _$setProp(_el$378, "paddingRight", 1);
            _$setProp(_el$378, "flexDirection", "column");
            _$insertNode(_el$379, _el$380);
            _$insertNode(_el$380, _$createTextNode(`Exact replacement`));
            _$insert(_el$378, _$createComponent(Show, {
              get when() {
                return draft().length;
              },
              children: () => draft().map((folder) => (() => {
                var _el$388 = _$createElement("text"), _el$389 = _$createTextNode(`\u2022 `);
                _$insertNode(_el$388, _el$389);
                _$setProp(_el$388, "wrapMode", "word");
                _$insert(_el$388, folder, null);
                return _el$388;
              })())
            }), _el$384);
            _$insert(_el$378, _$createComponent(Show, {
              get when() {
                return draft().length === 0;
              },
              get children() {
                var _el$382 = _$createElement("text");
                _$insertNode(_el$382, _$createTextNode(`(empty)`));
                return _el$382;
              }
            }), _el$384);
            _$insertNode(_el$384, _$createTextNode(`Type exactly: UPDATE ALLOWLIST`));
            _$setProp(_el$386, "placeholder", "UPDATE ALLOWLIST");
            _$setProp(_el$386, "onInput", (value) => setFolderConfirmation(value.slice(0, 64)));
            _$setProp(_el$387, "flexDirection", "row");
            _$setProp(_el$387, "flexWrap", "wrap");
            _$setProp(_el$387, "gap", 1);
            _$insert(_el$387, () => localActionButton("Replace approved folders", () => void submitFolderList(), true), null);
            _$insert(_el$387, () => localActionButton("Cancel", () => {
              setFolderDraft(null);
              setFolderConfirmation("");
            }), null);
            _$effect((_p$) => {
              var _v$41 = props.api.theme.current.warning, _v$42 = folderConfirmation();
              _v$41 !== _p$.e && (_p$.e = _$setProp(_el$378, "borderColor", _v$41, _p$.e));
              _v$42 !== _p$.t && (_p$.t = _$setProp(_el$386, "value", _v$42, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$378;
          })()
        }), _el$154);
        _$insertNode(_el$154, _el$155);
        _$insertNode(_el$155, _$createTextNode(`Limits and retention`));
        _$insertNode(_el$157, _$createTextNode(`These values are read-only here. Change configured numeric limits through startup configuration.`));
        _$setProp(_el$157, "wrapMode", "word");
        _$insert(_el$95, () => settings().limits.map((limit) => (() => {
          var _el$390 = _$createElement("box"), _el$391 = _$createElement("text"), _el$392 = _$createElement("b"), _el$393 = _$createElement("text"), _el$394 = _$createTextNode(`Actual: `), _el$395 = _$createElement("text"), _el$396 = _$createTextNode(`Configured limit: `), _el$397 = _$createElement("text");
          _$insertNode(_el$390, _el$391);
          _$insertNode(_el$390, _el$393);
          _$insertNode(_el$390, _el$395);
          _$insertNode(_el$390, _el$397);
          _$setProp(_el$390, "border", true);
          _$setProp(_el$390, "paddingLeft", 1);
          _$setProp(_el$390, "paddingRight", 1);
          _$setProp(_el$390, "flexDirection", "column");
          _$insertNode(_el$391, _el$392);
          _$insert(_el$392, () => limit.label);
          _$insertNode(_el$393, _el$394);
          _$setProp(_el$393, "wrapMode", "word");
          _$insert(_el$393, () => limit.actual, null);
          _$insertNode(_el$395, _el$396);
          _$setProp(_el$395, "wrapMode", "word");
          _$insert(_el$395, () => limit.configured, null);
          _$insert(_el$390, _$createComponent(Show, {
            get when() {
              return limit.resetAt;
            },
            children: (resetAt) => (() => {
              var _el$398 = _$createElement("text"), _el$399 = _$createTextNode(`Resets: `);
              _$insertNode(_el$398, _el$399);
              _$setProp(_el$398, "wrapMode", "word");
              _$insert(_el$398, () => new Date(resetAt()).toISOString(), null);
              return _el$398;
            })()
          }), _el$397);
          _$setProp(_el$397, "wrapMode", "word");
          _$insert(_el$397, () => limit.explanation);
          _$effect((_p$) => {
            var _v$43 = props.api.theme.current.borderSubtle, _v$44 = props.api.theme.current.textMuted;
            _v$43 !== _p$.e && (_p$.e = _$setProp(_el$390, "borderColor", _v$43, _p$.e));
            _v$44 !== _p$.t && (_p$.t = _$setProp(_el$397, "fg", _v$44, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$390;
        })()), _el$159);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().rolloutProgress;
          },
          children: (rolloutProgress) => (() => {
            var _el$400 = _$createElement("box"), _el$401 = _$createElement("text"), _el$402 = _$createElement("b"), _el$404 = _$createTextNode(`: `), _el$405 = _$createElement("text"), _el$406 = _$createTextNode(`Actual: `), _el$407 = _$createElement("text"), _el$408 = _$createTextNode(`Configured requirement: `);
            _$insertNode(_el$400, _el$401);
            _$insertNode(_el$400, _el$405);
            _$insertNode(_el$400, _el$407);
            _$setProp(_el$400, "border", true);
            _$setProp(_el$400, "paddingLeft", 1);
            _$setProp(_el$400, "paddingRight", 1);
            _$setProp(_el$400, "flexDirection", "column");
            _$insertNode(_el$401, _el$402);
            _$insertNode(_el$401, _el$404);
            _$insertNode(_el$402, _$createTextNode(`Automatic-apply rollout evidence`));
            _$insert(_el$401, () => rolloutProgress().ready ? "Ready" : "Not ready", null);
            _$insertNode(_el$405, _el$406);
            _$setProp(_el$405, "wrapMode", "word");
            _$insert(_el$405, () => rolloutProgress().actual, null);
            _$insertNode(_el$407, _el$408);
            _$setProp(_el$407, "wrapMode", "word");
            _$insert(_el$407, () => rolloutProgress().configured, null);
            _$effect((_$p) => _$setProp(_el$400, "borderColor", props.api.theme.current.borderSubtle, _$p));
            return _el$400;
          })()
        }), _el$159);
        _$insertNode(_el$159, _el$160);
        _$insertNode(_el$160, _$createTextNode(`Maintenance`));
        _$insertNode(_el$162, _$createTextNode(`Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.`));
        _$setProp(_el$162, "wrapMode", "word");
        _$setProp(_el$164, "flexDirection", "row");
        _$setProp(_el$164, "flexWrap", "wrap");
        _$setProp(_el$164, "gap", 1);
        _$insert(_el$164, () => settings().maintenance.scopes.map((scope) => (() => {
          var _el$409 = _$createElement("box"), _el$410 = _$createElement("text");
          _$insertNode(_el$409, _el$410);
          _$setProp(_el$409, "focusable", true);
          _$setProp(_el$409, "border", true);
          _$setProp(_el$409, "paddingLeft", 1);
          _$setProp(_el$409, "paddingRight", 1);
          _$setProp(_el$409, "onMouseUp", () => {
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$setProp(_el$409, "onKeyDown", (event) => {
            if (!isActivationKey(event))
              return;
            event.preventDefault();
            setMaintenanceScope(scope.value);
            setMaintenanceIntent(null);
            setMaintenanceConfirmation("");
          });
          _$insert(_el$410, () => scope.label);
          _$effect((_$p) => _$setProp(_el$409, "borderColor", maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle, _$p));
          return _el$409;
        })()));
        _$setProp(_el$165, "wrapMode", "word");
        _$insert(_el$165, () => settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation);
        _$setProp(_el$166, "flexDirection", "row");
        _$setProp(_el$166, "flexWrap", "wrap");
        _$setProp(_el$166, "gap", 1);
        _$insert(_el$166, _$createComponent(Show, {
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
        _$insert(_el$166, _$createComponent(Show, {
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
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return maintenanceIntent();
          },
          get children() {
            var _el$167 = _$createElement("box"), _el$168 = _$createElement("text"), _el$169 = _$createElement("text"), _el$170 = _$createTextNode(`Type exactly: `), _el$171 = _$createElement("input"), _el$172 = _$createElement("box");
            _$insertNode(_el$167, _el$168);
            _$insertNode(_el$167, _el$169);
            _$insertNode(_el$167, _el$171);
            _$insertNode(_el$167, _el$172);
            _$setProp(_el$167, "border", true);
            _$setProp(_el$167, "paddingLeft", 1);
            _$setProp(_el$167, "paddingRight", 1);
            _$setProp(_el$167, "flexDirection", "column");
            _$setProp(_el$168, "wrapMode", "word");
            _$insert(_el$168, (() => {
              var _c$2 = _$memo(() => maintenanceIntent() === "export");
              return () => _c$2() ? "The export may contain classified Self-evolve evidence and active skill snapshots." : maintenanceScope() === "all" ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted." : "The selected retained data will be permanently deleted after fresh server validation.";
            })());
            _$insertNode(_el$169, _el$170);
            _$insert(_el$169, maintenancePhrase, null);
            _$setProp(_el$171, "onInput", (value) => setMaintenanceConfirmation(value.slice(0, 64)));
            _$setProp(_el$172, "flexDirection", "row");
            _$setProp(_el$172, "flexWrap", "wrap");
            _$setProp(_el$172, "gap", 1);
            _$insert(_el$172, () => localActionButton(maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently", () => void submitMaintenance(), true), null);
            _$insert(_el$172, () => localActionButton("Cancel", () => {
              setMaintenanceIntent(null);
              setMaintenanceConfirmation("");
            }), null);
            _$effect((_p$) => {
              var _v$15 = props.api.theme.current.warning, _v$16 = maintenanceConfirmation(), _v$17 = maintenancePhrase();
              _v$15 !== _p$.e && (_p$.e = _$setProp(_el$167, "borderColor", _v$15, _p$.e));
              _v$16 !== _p$.t && (_p$.t = _$setProp(_el$171, "value", _v$16, _p$.t));
              _v$17 !== _p$.a && (_p$.a = _$setProp(_el$171, "placeholder", _v$17, _p$.a));
              return _p$;
            }, {
              e: undefined,
              t: undefined,
              a: undefined
            });
            return _el$167;
          }
        }), _el$173);
        _$insert(_el$95, _$createComponent(Show, {
          get when() {
            return settings().latestExport;
          },
          children: (latestExport) => (() => {
            var _el$411 = _$createElement("box"), _el$412 = _$createElement("text"), _el$413 = _$createElement("b"), _el$415 = _$createElement("text"), _el$416 = _$createTextNode(`Scope: `), _el$417 = _$createElement("text"), _el$418 = _$createTextNode(`Private path: `), _el$419 = _$createElement("text"), _el$420 = _$createTextNode(`Size: `), _el$421 = _$createTextNode(` bytes`), _el$422 = _$createElement("text"), _el$423 = _$createTextNode(`SHA-256: `), _el$424 = _$createElement("text"), _el$425 = _$createTextNode(`Expires: `);
            _$insertNode(_el$411, _el$412);
            _$insertNode(_el$411, _el$415);
            _$insertNode(_el$411, _el$417);
            _$insertNode(_el$411, _el$419);
            _$insertNode(_el$411, _el$422);
            _$insertNode(_el$411, _el$424);
            _$setProp(_el$411, "border", true);
            _$setProp(_el$411, "paddingLeft", 1);
            _$setProp(_el$411, "paddingRight", 1);
            _$setProp(_el$411, "flexDirection", "column");
            _$insertNode(_el$412, _el$413);
            _$insertNode(_el$413, _$createTextNode(`Latest private export`));
            _$insertNode(_el$415, _el$416);
            _$setProp(_el$415, "wrapMode", "word");
            _$insert(_el$415, () => latestExport().scope, null);
            _$insertNode(_el$417, _el$418);
            _$setProp(_el$417, "wrapMode", "word");
            _$insert(_el$417, () => latestExport().path, null);
            _$insertNode(_el$419, _el$420);
            _$insertNode(_el$419, _el$421);
            _$setProp(_el$419, "wrapMode", "word");
            _$insert(_el$419, () => latestExport().bytes, _el$421);
            _$insertNode(_el$422, _el$423);
            _$setProp(_el$422, "wrapMode", "word");
            _$insert(_el$422, () => latestExport().sha256, null);
            _$insertNode(_el$424, _el$425);
            _$setProp(_el$424, "wrapMode", "word");
            _$insert(_el$424, () => new Date(latestExport().expiresAt).toISOString(), null);
            _$effect((_$p) => _$setProp(_el$411, "borderColor", props.api.theme.current.warning, _$p));
            return _el$411;
          })()
        }), _el$173);
        _$insertNode(_el$173, _el$174);
        _$insertNode(_el$173, _el$175);
        _$insertNode(_el$173, _el$176);
        _$insertNode(_el$173, _el$177);
        _$setProp(_el$173, "wrapMode", "word");
        _$insert(_el$173, () => settings().footer.hostVersion, _el$175);
        _$insert(_el$173, () => settings().footer.pluginVersion, _el$176);
        _$insert(_el$173, () => settings().footer.projectionVersion ?? "Unavailable", _el$177);
        _$insert(_el$173, () => settings().footer.dashboardVersion ?? "Unavailable", null);
        _$setProp(_el$178, "wrapMode", "word");
        _$insert(_el$178, () => settings().footer.help);
        _$effect((_p$) => {
          var _v$18 = props.api.theme.current.textMuted, _v$19 = props.api.theme.current.borderSubtle, _v$20 = props.api.theme.current.textMuted, _v$21 = props.api.theme.current.textMuted;
          _v$18 !== _p$.e && (_p$.e = _$setProp(_el$111, "fg", _v$18, _p$.e));
          _v$19 !== _p$.t && (_p$.t = _$setProp(_el$130, "borderColor", _v$19, _p$.t));
          _v$20 !== _p$.a && (_p$.a = _$setProp(_el$173, "fg", _v$20, _p$.a));
          _v$21 !== _p$.o && (_p$.o = _$setProp(_el$178, "fg", _v$21, _p$.o));
          return _p$;
        }, {
          e: undefined,
          t: undefined,
          a: undefined,
          o: undefined
        });
        return _el$95;
      }
    }), null);
    _$insert(_el$1, _$createComponent(Show, {
      get when() {
        return completedResponse();
      },
      get children() {
        var _el$179 = _$createElement("text");
        _$setProp(_el$179, "wrapMode", "word");
        _$insert(_el$179, (() => {
          var _c$3 = _$memo(() => completedResponse()?.response?.ok === false);
          return () => _c$3() ? `Server rejected ${completedResponse()?.action?.replaceAll("-", " ") ?? "the request"}: ${completedResponse()?.response?.reason}` : _$memo(() => !!(completedResponse()?.action === "purge-all" && completedResponse()?.response?.status === "accepted-terminal"))() ? "Purge all accepted; Self-evolve authority stopped. Restart OpenCode to reinitialize durable state." : `${completedResponse()?.action?.replaceAll("-", " ") ?? "Request"} accepted by the server.`;
        })());
        _$effect((_$p) => _$setProp(_el$179, "fg", completedResponse()?.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info, _$p));
        return _el$179;
      }
    }), _el$181);
    _$insert(_el$1, _$createComponent(Show, {
      get when() {
        return feedback();
      },
      get children() {
        var _el$180 = _$createElement("text");
        _$setProp(_el$180, "wrapMode", "word");
        _$insert(_el$180, feedback);
        _$effect((_$p) => _$setProp(_el$180, "fg", props.api.theme.current.info, _$p));
        return _el$180;
      }
    }), _el$181);
    _$insertNode(_el$181, _el$182);
    _$insert(_el$181, () => props.prior.name, null);
    _$effect((_p$) => {
      var _v$22 = props.api.theme.current.text, _v$23 = props.api.theme.current.textMuted, _v$24 = props.api.theme.current.textMuted;
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$12, "fg", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$15, "fg", _v$23, _p$.t));
      _v$24 !== _p$.a && (_p$.a = _$setProp(_el$181, "fg", _v$24, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$1;
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
  const [snapshot, setSnapshot] = createSignal(projectStore.getSnapshot());
  const unsubscribe = projectStore.subscribe(setSnapshot);
  api.lifecycle.onDispose(unsubscribe);
  let priorRoute = {
    name: "home"
  };
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE)
      return;
    api.route.navigate(priorRoute.name, priorRoute.params);
  };
  const openControlCenter = (destination = {
    section: "home"
  }) => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      priorRoute = {
        name: api.route.current.name,
        ..."params" in api.route.current ? {
          params: api.route.current.params
        } : {}
      };
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
      api.route.navigate(priorRoute.name, priorRoute.params);
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
