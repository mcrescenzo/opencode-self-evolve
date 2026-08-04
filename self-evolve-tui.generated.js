import { jsxDEV as jsxDEV_7x81h0kn } from "@opentui/solid/jsx-dev-runtime";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { setTimeout as delay } from "node:timers/promises";
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js";
import {
  CONTROL_CENTER_SECTIONS,
  acquireProjectTuiStore,
  buildControlCenterModel,
  controlCenterRouteParams,
  deriveSidebarCard,
  parseControlCenterDestination,
  validateApprovedSkillFolderInput
} from "./self-evolve-tui-store.js";
const CARD_ID = "self-evolve-sidebar-card";
const CONTROL_CENTER_COMMAND = TUI_IDENTITIES.command;
const CONTROL_CENTER_ROUTE = TUI_IDENTITIES.route;
const CONTROL_CENTER_MODE = TUI_IDENTITIES.mode;
const CONTROL_CENTER_VIEW_ID = TUI_IDENTITIES.view;
const activeApis = new WeakSet;
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
  return /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
    when: props.card(),
    children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
      id: CARD_ID,
      ref: (value) => cardNode = value,
      focusable: true,
      border: true,
      borderColor: borderColor(),
      width: "100%",
      paddingLeft: 1,
      paddingRight: 1,
      flexDirection: "column",
      onFocus: () => setFocused(true),
      onBlur: () => setFocused(false),
      onMouseDown: () => cardNode?.focus(),
      onMouseUp: props.open,
      onKeyDown: (event) => {
        if (!isActivationKey(event))
          return;
        event.preventDefault();
        props.open();
      },
      children: [
        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: props.api.theme.current.text,
          children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
            children: props.card()?.title
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: props.api.theme.current.textMuted,
          wrapMode: "word",
          children: props.card()?.summary
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: props.api.theme.current.textMuted,
          wrapMode: "word",
          children: props.card()?.detail
        }, undefined, false, undefined, this),
        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: props.api.theme.current.info,
          wrapMode: "word",
          children: props.card()?.action
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this)
  }, undefined, false, undefined, this);
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
    navigate({ section: names[(index + offset + names.length) % names.length] });
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
  const actionButton = (key, label, operation, requiresConfirmation = false) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
    focusable: true,
    border: true,
    paddingLeft: 1,
    paddingRight: 1,
    borderColor: confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle,
    onMouseUp: () => void invoke(key, operation, requiresConfirmation),
    onKeyDown: (event) => {
      if (!isActivationKey(event))
        return;
      event.preventDefault();
      invoke(key, operation, requiresConfirmation);
    },
    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
      fg: props.api.theme.current.text,
      children: confirmation() === key ? `Confirm ${label}` : label
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
  const localActionButton = (label, operation, warning = false, confirmationKey) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
    focusable: true,
    border: true,
    paddingLeft: 1,
    paddingRight: 1,
    borderColor: warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle,
    onMouseUp: operation,
    onKeyDown: (event) => {
      if (!isActivationKey(event))
        return;
      event.preventDefault();
      operation();
    },
    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
      fg: props.api.theme.current.text,
      children: confirmation() === confirmationKey ? `Confirm ${label}` : label
    }, undefined, false, undefined, this)
  }, undefined, false, undefined, this);
  const granted = () => new Set((props.snapshot().projection?.index?.allowedActions ?? []).map((action) => action.action));
  const paused = () => props.snapshot().dashboard?.settings?.paused === true;
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true;
  const completedResponse = () => props.snapshot().responses.at(-1);
  const home = () => model().sections.home;
  const recommendations = () => model().sections.recommendations;
  const activity = () => model().sections.activity;
  const settings = () => model().sections.settings;
  const consentEnabled = (key) => settings().consent.find((entry) => entry.key === key)?.enabled === true;
  const modeRank = (value) => ({ manual: 0, auto: 1, yolo: 2 })[value ?? ""] ?? 0;
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
    invoke(`${scope}-mode-${mode}`, () => props.store.submitControl(action, { mode }), riskIncreasing);
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
      await submitControlAndWait("set-consent", { key: "passiveCalls", enabled: true });
    }
    if (!consentEnabled("durableObservations")) {
      await submitControlAndWait("set-consent", { key: "durableObservations", enabled: true });
    }
    if (modeRank(settings().mode.global.value) < modeRank("auto")) {
      await submitControlAndWait("set-mode", { mode: "auto" });
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
      } : { mode: "yolo" });
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
        await props.store.submitOperation("export-data", { scope, confirmation: phrase });
      } else if (scope === "all") {
        await props.store.submitOperation("purge-all", { confirmation: phrase });
      } else {
        await props.store.submitOperation("purge-scope", { scope, confirmation: phrase });
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
    navigate({ section: "recommendations", selectedIndex: sourceIndex });
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
      navigate({ section: "activity", filter: "recommendations" });
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
        await props.store.submitDecision({ proposalId, newState: "approved" });
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
          ...feedbackValue ? { feedback: feedbackValue } : {}
        });
      } else if (action === "snooze-proposal") {
        await props.store.submitOperation("snooze-proposal", {
          snoozedUntil: Date.now() + (snoozeMs ?? 86400000)
        }, { proposalId });
      } else if (action === "rollback-proposal") {
        await props.store.submitOperation("rollback-proposal", {}, { proposalId });
      } else {
        throw new Error("unsupported-recommendation-action");
      }
      setConfirmation(null);
      setFeedback("Request submitted. Server validation and the mounted outcome determine completion.");
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
    id: CONTROL_CENTER_VIEW_ID,
    focusable: true,
    width: "100%",
    height: "100%",
    flexDirection: "column",
    paddingLeft: 2,
    paddingRight: 2,
    children: [
      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
        flexDirection: "row",
        gap: 1,
        flexWrap: "wrap",
        children: [
          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
            flexDirection: "column",
            flexGrow: 1,
            children: [
              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                fg: props.api.theme.current.text,
                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                  children: "Self-evolve"
                }, undefined, false, undefined, this)
              }, undefined, false, undefined, this),
              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                fg: props.api.theme.current.textMuted,
                wrapMode: "word",
                children: [
                  model().operational.label,
                  " \xB7 ",
                  home().mode.effective.label
                ]
              }, undefined, true, undefined, this)
            ]
          }, undefined, true, undefined, this),
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: granted().has("set-paused"),
            children: actionButton(paused() ? "resume" : "pause", paused() ? "Resume" : "Pause", () => props.store.submitOperation("set-paused", { paused: !paused() }))
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: granted().has("set-kill-switch"),
            children: actionButton(emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop", emergencyStop() ? "Turn off Emergency stop" : "Emergency stop", () => props.store.submitOperation("set-kill-switch", { enabled: !emergencyStop() }), emergencyStop())
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
        flexDirection: "row",
        gap: 1,
        flexWrap: "wrap",
        children: names.map((name) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
          focusable: true,
          border: true,
          paddingLeft: 1,
          paddingRight: 1,
          borderColor: section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
          onMouseUp: () => navigate({ section: name }),
          onKeyDown: (event) => {
            if (isActivationKey(event)) {
              event.preventDefault();
              navigate({ section: name });
            } else if (event.name === "left") {
              event.preventDefault();
              moveSection(-1);
            } else if (event.name === "right") {
              event.preventDefault();
              moveSection(1);
            }
          },
          children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
            fg: section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted,
            children: [
              name.charAt(0).toUpperCase() + name.slice(1),
              name === "recommendations" && model().operational.count > 0 ? ` (${model().operational.count})` : ""
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this))
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV_7x81h0kn("scrollbox", {
        flexGrow: 1,
        width: "100%",
        children: [
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: section() === "home",
            children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
              flexDirection: "column",
              gap: 1,
              children: [
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.text,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: home().operational.label
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: home().operational.explanation
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.textMuted,
                  wrapMode: "word",
                  children: home().operational.nextAction
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                        children: "Mode and scope"
                      }, undefined, false, undefined, this)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "Effective: ",
                        home().mode.effective.label
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "Global default: ",
                        home().mode.global.label
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "This project: ",
                        home().mode.repository.label
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().firstRun,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.info,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    gap: 1,
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Get automatic recommendations"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: "Choose proactive review without granting automatic writes. Background AI analysis and saved structured patterns remain separate consent gates in Settings."
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: settings().controls.globalMode,
                        children: actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: !settings().controls.globalMode,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          fg: props.api.theme.current.textMuted,
                          children: "Controls are unavailable until the aligned server publishes fresh authority."
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Optional evidence excerpts"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: "Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations."
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: settings().controls.consent,
                        children: actionButton("first-run-sanitized-excerpts", "Allow sanitized excerpts", () => props.store.submitControl("set-consent", { key: "sanitizedExcerpts", enabled: true }), true)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: !settings().controls.consent,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          fg: props.api.theme.current.textMuted,
                          children: "Excerpt consent can be changed later in Settings."
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().blockers.length,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Setup"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      () => home().blockers.map((blocker) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        focusable: true,
                        border: true,
                        borderColor: props.api.theme.current.warning,
                        paddingLeft: 1,
                        paddingRight: 1,
                        onMouseUp: () => navigate({ section: "settings", anchor: blocker.code }),
                        onKeyDown: (event) => {
                          if (!isActivationKey(event))
                            return;
                          event.preventDefault();
                          navigate({ section: "settings", anchor: blocker.code });
                        },
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            blocker.summary,
                            " \xB7 Open Settings"
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this))
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().lastCycle,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Last cycle"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          home().lastCycle.outcome.replaceAll("-", " "),
                          " \xB7 ",
                          home().lastCycle.observationCount,
                          " observations \xB7 ",
                          home().lastCycle.eligibilityCount,
                          " eligible"
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().attention,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    focusable: true,
                    border: true,
                    borderColor: props.api.theme.current.warning,
                    paddingLeft: 1,
                    paddingRight: 1,
                    onMouseUp: () => navigate(home().attention.destination),
                    onKeyDown: (event) => {
                      if (!isActivationKey(event))
                        return;
                      event.preventDefault();
                      navigate(home().attention.destination);
                    },
                    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: [
                        home().attention.count,
                        " ",
                        home().attention.kind === "applied" ? "applied change" : "recommendation",
                        " needs attention"
                      ]
                    }, undefined, true, undefined, this)
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().usage,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Actual usage"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: [
                          "Background analysis: ",
                          home().usage.passive.used,
                          " / ",
                          home().usage.passive.limit
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: [
                          "Recommendation synthesis: ",
                          home().usage.synthesis.used,
                          " / ",
                          home().usage.synthesis.limit
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: [
                          "Storage: ",
                          home().usage.storage.usedBytes,
                          " / ",
                          home().usage.storage.limitBytes,
                          " bytes"
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().recentActivity.length,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Recent activity"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      () => home().recentActivity.map((entry) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "[",
                          entry.marker,
                          "] ",
                          entry.summary
                        ]
                      }, undefined, true, undefined, this))
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: home().emptyState,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: home().emptyState.heading
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: home().emptyState.explanation
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.textMuted,
                  wrapMode: "word",
                  children: home().manualFallback
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: section() === "recommendations",
            children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
              flexDirection: "column",
              gap: 1,
              children: [
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Recommendations"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  flexDirection: "row",
                  gap: 1,
                  flexWrap: "wrap",
                  children: [
                    ["needs-review", "Needs review"],
                    ["applied", "Applied"],
                    ["dismissed", "Dismissed"],
                    ["all", "All"]
                  ].map(([value, label]) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    focusable: true,
                    border: true,
                    borderColor: recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                    paddingLeft: 1,
                    paddingRight: 1,
                    onMouseUp: () => {
                      setRecommendationFilter(value);
                      const first = buildControlCenterModel(props.snapshot(), { recommendationFilter: value }).sections.recommendations.queue[0];
                      if (first)
                        selectRecommendation(first.sourceIndex);
                    },
                    onKeyDown: (event) => {
                      if (!isActivationKey(event))
                        return;
                      event.preventDefault();
                      setRecommendationFilter(value);
                      const first = buildControlCenterModel(props.snapshot(), { recommendationFilter: value }).sections.recommendations.queue[0];
                      if (first)
                        selectRecommendation(first.sourceIndex);
                    },
                    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: label
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this))
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: recommendations().emptyState,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    children: recommendations().emptyState
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                () => recommendations().queue.map((item, index) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  focusable: true,
                  border: true,
                  borderColor: recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  onMouseUp: () => selectRecommendation(item.sourceIndex),
                  onKeyDown: (event) => {
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
                  },
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        item.attention === "critical" ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : "",
                        item.target,
                        " \xB7 ",
                        item.state.replaceAll("-", " "),
                        " \xB7 ",
                        relativeTime(item.updatedAt)
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: item.rationale
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      children: [
                        "Risk: ",
                        item.risk ?? "Loading",
                        " \xB7 Evidence: ",
                        item.evidenceCount ?? "Loading"
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: recommendations().selected,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.borderActive,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    gap: 1,
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: recommendations().selected.target
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: recommendations().selected.loading,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          children: "Loading authoritative recommendation detail\u2026"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: recommendations().selected.summary,
                        children: [
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Why this was suggested"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                wrapMode: "word",
                                children: recommendations().selected.summary.rationale
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Proposed change"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              () => recommendations().selected.diff?.lines.map((line) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                wrapMode: "word",
                                children: line
                              }, undefined, false, undefined, this)) ?? [],
                              /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                                when: recommendations().selected.diff?.overflow?.truncated,
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                  fg: props.api.theme.current.warning,
                                  children: "The proposed change was truncated by the bounded projection."
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Evidence"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              () => recommendations().selected.evidence.map((entry) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                wrapMode: "word",
                                children: [
                                  entry.kind,
                                  ": ",
                                  entry.summary,
                                  entry.redacted ? " [redacted]" : ""
                                ]
                              }, undefined, true, undefined, this)),
                              /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                                when: !recommendations().selected.evidence.length,
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                  children: "No bounded evidence detail is loaded."
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Safety checks"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "Critic: ",
                                  recommendations().selected.summary.criticPassed ? "Passed" : "Not passed"
                                ]
                              }, undefined, true, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "Deterministic checks: ",
                                  recommendations().selected.summary.validDeterministic ? "Passed" : "Not passed"
                                ]
                              }, undefined, true, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "Injection scan: ",
                                  recommendations().selected.summary.injectionFlagged ? "Flagged" : "Clear"
                                ]
                              }, undefined, true, undefined, this),
                              () => recommendations().selected.summary.eligibility.checks.map((check) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                wrapMode: "word",
                                children: [
                                  "[",
                                  check.met ? "Passed" : "Blocked",
                                  "] ",
                                  check.name,
                                  ": ",
                                  check.actual,
                                  " / ",
                                  check.required
                                ]
                              }, undefined, true, undefined, this))
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Token impact"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  recommendations().selected.summary.tokenImpact.estimatedTokens,
                                  " estimated / ",
                                  recommendations().selected.summary.tokenImpact.budgetTokens,
                                  " budgeted tokens"
                                ]
                              }, undefined, true, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            flexDirection: "column",
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                                  children: "Rollback"
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: recommendations().selected.summary.rollback.eligible ? "Undo is currently eligible." : `Unavailable: ${recommendations().selected.summary.rollback.reason ?? "not offered"}`
                              }, undefined, false, undefined, this)
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            focusable: true,
                            border: true,
                            borderColor: technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                            paddingLeft: 1,
                            paddingRight: 1,
                            onMouseUp: () => setTechnicalExpanded((value) => !value),
                            onKeyDown: (event) => {
                              if (!isActivationKey(event))
                                return;
                              event.preventDefault();
                              setTechnicalExpanded((value) => !value);
                            },
                            children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                              children: [
                                "Technical details ",
                                technicalExpanded() ? "\u25B2" : "\u25BC"
                              ]
                            }, undefined, true, undefined, this)
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                            when: technicalExpanded(),
                            children: [
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "State: ",
                                  recommendations().selected.summary.state
                                ]
                              }, undefined, true, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "Effective mode: ",
                                  recommendations().selected.summary.effectiveMode
                                ]
                              }, undefined, true, undefined, this),
                              /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                children: [
                                  "Operation: ",
                                  recommendations().selected.summary.operation.status
                                ]
                              }, undefined, true, undefined, this),
                              () => recommendations().selected.audit.map((entry) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                wrapMode: "word",
                                children: [
                                  entry.kind,
                                  ": ",
                                  entry.summary
                                ]
                              }, undefined, true, undefined, this))
                            ]
                          }, undefined, true, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: recommendations().selected.actions.some((action) => action.action === "reject-proposal" && action.feedbackSupported),
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                          flexDirection: "column",
                          children: [
                            /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                              fg: props.api.theme.current.textMuted,
                              children: "Optional rejection feedback (audit-only)"
                            }, undefined, false, undefined, this),
                            /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                              flexDirection: "row",
                              gap: 1,
                              flexWrap: "wrap",
                              children: () => recommendations().rejectionFeedbackOptions.map((option) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                                focusable: true,
                                border: true,
                                borderColor: rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                                paddingLeft: 1,
                                paddingRight: 1,
                                onMouseUp: () => setRejectionReason(rejectionReason() === option.value ? null : option.value),
                                onKeyDown: (event) => {
                                  if (!isActivationKey(event))
                                    return;
                                  event.preventDefault();
                                  setRejectionReason(rejectionReason() === option.value ? null : option.value);
                                },
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                  children: option.label
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this))
                            }, undefined, false, undefined, this),
                            /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                              when: rejectionReason() === "other",
                              children: /* @__PURE__ */ jsxDEV_7x81h0kn("input", {
                                value: rejectionText(),
                                placeholder: "Optional bounded reason (512 characters)",
                                onInput: (value) => setRejectionText(value.slice(0, 512))
                              }, undefined, false, undefined, this)
                            }, undefined, false, undefined, this)
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        flexDirection: "row",
                        gap: 1,
                        flexWrap: "wrap",
                        children: [
                          () => recommendations().selected.actions.flatMap((action) => {
                            const choices = action.action === "snooze-proposal" ? [
                              { label: "Snooze 1 hour", delay: 3600000 },
                              { label: "Snooze 1 day", delay: 86400000 },
                              { label: "Snooze 7 days", delay: 604800000 }
                            ] : [{
                              label: action.action === "rollback-proposal" ? "Undo" : action.action === "acknowledge-audit" ? "Acknowledge" : action.label,
                              delay: undefined
                            }];
                            return choices.map((choice) => {
                              const key = `${action.action}:${choice.delay ?? ""}`;
                              return /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                                focusable: !pendingRecommendation(),
                                border: true,
                                borderColor: confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle,
                                paddingLeft: 1,
                                paddingRight: 1,
                                onMouseUp: () => void activateRecommendation(action.action, choice.delay),
                                onKeyDown: (event) => {
                                  if (!isActivationKey(event))
                                    return;
                                  event.preventDefault();
                                  activateRecommendation(action.action, choice.delay);
                                },
                                children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                                  children: confirmation() === key ? `Confirm ${choice.label}` : choice.label
                                }, undefined, false, undefined, this)
                              }, undefined, false, undefined, this);
                            });
                          }),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            focusable: true,
                            border: true,
                            borderColor: props.api.theme.current.borderSubtle,
                            paddingLeft: 1,
                            paddingRight: 1,
                            onMouseUp: () => void activateRecommendation("open-activity"),
                            onKeyDown: (event) => {
                              if (!isActivationKey(event))
                                return;
                              event.preventDefault();
                              activateRecommendation("open-activity");
                            },
                            children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                              children: "Open in Activity"
                            }, undefined, false, undefined, this)
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: pendingRecommendation(),
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          fg: props.api.theme.current.info,
                          children: "Request pending server validation\u2026"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: section() === "activity",
            children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
              flexDirection: "column",
              gap: 1,
              children: [
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Activity"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  flexDirection: "row",
                  gap: 1,
                  flexWrap: "wrap",
                  children: [
                    ["all", "All"],
                    ["recommendations", "Recommendations"],
                    ["system", "System"],
                    ["errors", "Errors"]
                  ].map(([value, label]) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    focusable: true,
                    border: true,
                    borderColor: activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                    paddingLeft: 1,
                    paddingRight: 1,
                    onMouseUp: () => {
                      setActivityFilter(value);
                      setActivityExpanded(null);
                    },
                    onKeyDown: (event) => {
                      if (!isActivationKey(event))
                        return;
                      event.preventDefault();
                      setActivityFilter(value);
                      setActivityExpanded(null);
                    },
                    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: label
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this))
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: activity().emptyState,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    wrapMode: "word",
                    children: activity().emptyState
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                () => activity().activity.map((entry, index) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  focusable: true,
                  border: true,
                  borderColor: activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  onMouseUp: () => setActivityExpanded(activityExpanded() === index ? null : index),
                  onKeyDown: (event) => {
                    if (isActivationKey(event)) {
                      event.preventDefault();
                      setActivityExpanded(activityExpanded() === index ? null : index);
                    } else if (event.name === "right" && entry.destination?.section === "recommendations") {
                      event.preventDefault();
                      openActivityDestination(entry);
                    }
                  },
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "[",
                        entry.marker,
                        "] ",
                        entry.summary,
                        " \xB7 ",
                        relativeTime(entry.occurredAt)
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: entry.target,
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        fg: props.api.theme.current.textMuted,
                        children: [
                          "Skill: ",
                          entry.target
                        ]
                      }, undefined, true, undefined, this)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: activityExpanded() === index,
                      children: [
                        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          fg: props.api.theme.current.textMuted,
                          children: [
                            "Category: ",
                            entry.technical.category
                          ]
                        }, undefined, true, undefined, this),
                        /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          fg: props.api.theme.current.textMuted,
                          children: [
                            "Outcome: ",
                            entry.technical.outcome.replaceAll("-", " ")
                          ]
                        }, undefined, true, undefined, this),
                        /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                          when: entry.technical.reason,
                          children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            fg: props.api.theme.current.textMuted,
                            children: [
                              "Reason: ",
                              entry.technical.reason.replaceAll("-", " ")
                            ]
                          }, undefined, true, undefined, this)
                        }, undefined, false, undefined, this),
                        /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                          when: entry.destination?.section === "recommendations",
                          children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                            focusable: true,
                            border: true,
                            borderColor: props.api.theme.current.borderSubtle,
                            paddingLeft: 1,
                            paddingRight: 1,
                            onMouseUp: () => openActivityDestination(entry),
                            onKeyDown: (event) => {
                              if (!isActivationKey(event))
                                return;
                              event.preventDefault();
                              openActivityDestination(entry);
                            },
                            children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                              children: "Open recommendation"
                            }, undefined, false, undefined, this)
                          }, undefined, false, undefined, this)
                        }, undefined, false, undefined, this)
                      ]
                    }, undefined, true, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: activity().overflowMessage,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.warning,
                    wrapMode: "word",
                    children: activity().overflowMessage
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  focusable: true,
                  border: true,
                  borderColor: diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  onMouseUp: () => setDiagnosticsExpanded((value) => !value),
                  onKeyDown: (event) => {
                    if (!isActivationKey(event))
                      return;
                    event.preventDefault();
                    setDiagnosticsExpanded((value) => !value);
                  },
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    children: [
                      "Diagnostics ",
                      diagnosticsExpanded() ? "\u25B2" : "\u25BC"
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: diagnosticsExpanded(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Projection refreshed: ",
                          activity().diagnostics.refreshedAt ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Core projection: ",
                          activity().diagnostics.coreProjection
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Enhanced projection: ",
                          activity().diagnostics.enhancedProjection
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "OpenCode: ",
                          activity().diagnostics.runtime.hostVersion,
                          " (",
                          activity().diagnostics.runtime.hostVersionSource,
                          ")"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Self-evolve: ",
                          activity().diagnostics.runtime.pluginVersion
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Projection protocol: ",
                          activity().diagnostics.runtime.projectionVersion ?? "Unavailable"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Dashboard protocol: ",
                          activity().diagnostics.runtime.dashboardVersion ?? "Unavailable"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Refresh watcher: ",
                          activity().diagnostics.watcherStatus
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Circuit breaker: ",
                          activity().diagnostics.breakerStatus
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: activity().diagnostics.automation,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            "Scheduler: ",
                            activity().diagnostics.automation.state.replaceAll("-", " ")
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: activity().diagnostics.backoffUntil,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            "Backoff ends: ",
                            new Date(activity().diagnostics.backoffUntil).toISOString()
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: activity().diagnostics.nextEligibleAt,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            "Next eligible: ",
                            new Date(activity().diagnostics.nextEligibleAt).toISOString()
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: activity().diagnostics.usage,
                        children: [
                          /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            wrapMode: "word",
                            children: [
                              "Background analysis used/remaining: ",
                              activity().diagnostics.usage.passive.used,
                              " / ",
                              activity().diagnostics.usage.passive.remaining
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            wrapMode: "word",
                            children: [
                              "Background analysis resets: ",
                              new Date(activity().diagnostics.budgetResetAt.passive).toISOString()
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            wrapMode: "word",
                            children: [
                              "Recommendation synthesis used/remaining: ",
                              activity().diagnostics.usage.synthesis.used,
                              " / ",
                              activity().diagnostics.usage.synthesis.remaining
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            wrapMode: "word",
                            children: [
                              "Recommendation synthesis resets: ",
                              new Date(activity().diagnostics.budgetResetAt.synthesis).toISOString()
                            ]
                          }, undefined, true, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                            wrapMode: "word",
                            children: [
                              "Storage used/quota: ",
                              activity().diagnostics.usage.storage.usedBytes,
                              " / ",
                              activity().diagnostics.usage.storage.limitBytes,
                              " bytes"
                            ]
                          }, undefined, true, undefined, this)
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: activity().diagnostics.lastError,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            "Last bounded error: ",
                            activity().diagnostics.lastError.summary
                          ]
                        }, undefined, true, undefined, this)
                      }, undefined, false, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this),
          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
            when: section() === "settings",
            children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
              flexDirection: "column",
              gap: 1,
              children: [
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Settings"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settingsAnchor(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.info,
                    wrapMode: "word",
                    children: [
                      "Opened at ",
                      settingsAnchor().replaceAll("-", " "),
                      " settings."
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().limited,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.warning,
                    wrapMode: "word",
                    children: "Limited view: enhanced usage, repository-mode editing, and prerequisite status require an aligned server."
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().enhancedError,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.error,
                    wrapMode: "word",
                    children: settings().enhancedError
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Modes"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: [
                    "Effective result: ",
                    settings().mode.effective.label
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: [
                    "Global default: ",
                    settings().mode.global.label
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: [
                    "This project: ",
                    settings().mode.repository.label
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.textMuted,
                  wrapMode: "word",
                  children: "The global default applies to every current and future project. \u201CUse for this project\u201D creates an override here only."
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().controls.globalMode && settings().controls.consent && !automaticRecommendationsReady(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.info,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    gap: 1,
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Automatic recommendations setup"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: "One confirmation enables background AI analysis, saved structured patterns, and the Analyze and recommend global mode in sequence. Sanitized excerpts remain a separate choice."
                      }, undefined, false, undefined, this),
                      actionButton("automatic-recommendations", "Turn on automatic recommendations", enableAutomaticRecommendations, true)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                () => settings().modes.map((mode) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: [
                        /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: mode.label
                        }, undefined, false, undefined, this),
                        settings().mode.effective.value === mode.value ? " \xB7 Effective now" : ""
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: mode.description
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: [
                        "Provider use: ",
                        mode.providerUse
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: [
                        "Saved data: ",
                        mode.savedData
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: [
                        "Write authority: ",
                        mode.writeAuthority
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: [
                        "Prerequisites: ",
                        mode.prerequisites
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: mode.blockers.length,
                      children: () => mode.blockers.map((blocker) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        fg: props.api.theme.current.warning,
                        wrapMode: "word",
                        children: [
                          "\u2022 ",
                          blocker
                        ]
                      }, undefined, true, undefined, this))
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: mode.available,
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: 1,
                        children: [
                          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                            when: settings().controls.globalMode,
                            children: localActionButton(settings().mode.global.value === mode.value ? "Global default \u2713" : "Set global default", () => submitMode("global", mode.value), mode.value === "yolo", `global-mode-${mode.value}`)
                          }, undefined, false, undefined, this),
                          /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                            when: settings().controls.repositoryMode,
                            children: localActionButton(settings().mode.repository.value === mode.value ? "This project \u2713" : "Use for this project", () => submitMode("project", mode.value), mode.value === "yolo", `project-mode-${mode.value}`)
                          }, undefined, false, undefined, this)
                        ]
                      }, undefined, true, undefined, this)
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().controls.repositoryMode,
                  children: localActionButton(settings().mode.repository.value === "inherit" ? "Inherit global default \u2713" : "Make this project inherit global default", () => submitMode("project", "inherit"), false, "project-mode-inherit")
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: yoloTarget(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.warning,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Apply automatically expands write authority for the ",
                          yoloTarget() === "global" ? "global default" : "current project",
                          ". Approved folders and every current prerequisite will be revalidated by the server."
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: "Type exactly: ENABLE YOLO"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("input", {
                        value: yoloConfirmation(),
                        placeholder: "ENABLE YOLO",
                        onInput: (value) => setYoloConfirmation(value.slice(0, 64))
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: 1,
                        children: [
                          localActionButton("Submit Apply automatically", () => void confirmYolo(), true),
                          localActionButton("Cancel", () => {
                            setYoloTarget(null);
                            setYoloConfirmation("");
                          })
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Privacy and project scope"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: [
                        /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Include this project"
                        }, undefined, false, undefined, this),
                        ": ",
                        settings().projectExcluded ? "No" : "Yes"
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: "Excluding this project overrides automatic global modes without changing global settings."
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: settings().controls.projectInclusion,
                      children: actionButton(settings().projectExcluded ? "include-project" : "exclude-project", settings().projectExcluded ? "Include this project" : "Exclude this project", () => props.store.submitControl("set-repo-excluded", { excluded: !settings().projectExcluded }), settings().projectExcluded === true)
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                () => settings().consent.map((entry) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: [
                        /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: entry.label
                        }, undefined, false, undefined, this),
                        ": ",
                        entry.enabled ? "Allowed" : "Not allowed",
                        " \xB7 ",
                        entry.scope
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: entry.description
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: entry.dependency
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: settings().controls.consent && (entry.enabled || entry.canEnable),
                      children: actionButton(`consent-${entry.key}-${entry.enabled ? "off" : "on"}`, entry.enabled ? `Stop allowing ${entry.label}` : `Allow ${entry.label}`, () => props.store.submitControl("set-consent", { key: entry.key, enabled: !entry.enabled }), !entry.enabled)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: !entry.enabled && !entry.canEnable,
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        fg: props.api.theme.current.warning,
                        wrapMode: "word",
                        children: "Resolve the dependency above before enabling this setting."
                      }, undefined, false, undefined, this)
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: [
                    "Pause automatic work: ",
                    settings().paused ? "Paused" : "Running when eligible",
                    ". Pause preserves modes and consent."
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: [
                    "Emergency stop: ",
                    settings().emergencyStop ? "On" : "Off",
                    ". It overrides every automatic provider and write path."
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Approved skill folders"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: settings().approvedSkillFolderWarning
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: !settings().approvedSkillFolders.length,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.warning,
                    wrapMode: "word",
                    children: "No folder is approved; Apply automatically cannot be enabled."
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                () => settings().approvedSkillFolders.map((folder) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 1,
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: folder
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: settings().controls.approvedSkillFolders,
                      children: localActionButton("Remove", () => stageFolderList(settings().approvedSkillFolders.filter((candidate) => candidate !== folder)))
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().controls.approvedSkillFolders,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: "Add one canonical absolute folder"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("input", {
                        value: folderInput(),
                        placeholder: "/canonical/path/to/skills",
                        onInput: (value) => {
                          setFolderInput(value.slice(0, 4096));
                          setFolderError(null);
                        }
                      }, undefined, false, undefined, this),
                      localActionButton("Add folder", stageFolderAdd)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: folderError(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                    fg: props.api.theme.current.warning,
                    wrapMode: "word",
                    children: folderError()
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: folderDraft(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.warning,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Exact replacement"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: folderDraft().length,
                        children: () => folderDraft().map((folder) => /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          wrapMode: "word",
                          children: [
                            "\u2022 ",
                            folder
                          ]
                        }, undefined, true, undefined, this))
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                        when: folderDraft().length === 0,
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                          children: "(empty)"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: "Type exactly: UPDATE ALLOWLIST"
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("input", {
                        value: folderConfirmation(),
                        placeholder: "UPDATE ALLOWLIST",
                        onInput: (value) => setFolderConfirmation(value.slice(0, 64))
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: 1,
                        children: [
                          localActionButton("Replace approved folders", () => void submitFolderList(), true),
                          localActionButton("Cancel", () => {
                            setFolderDraft(null);
                            setFolderConfirmation("");
                          })
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Limits and retention"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: "These values are read-only here. Change configured numeric limits through startup configuration."
                }, undefined, false, undefined, this),
                () => settings().limits.map((limit) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  border: true,
                  borderColor: props.api.theme.current.borderSubtle,
                  paddingLeft: 1,
                  paddingRight: 1,
                  flexDirection: "column",
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                        children: limit.label
                      }, undefined, false, undefined, this)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "Actual: ",
                        limit.actual
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      wrapMode: "word",
                      children: [
                        "Configured limit: ",
                        limit.configured
                      ]
                    }, undefined, true, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: limit.resetAt,
                      children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Resets: ",
                          new Date(limit.resetAt).toISOString()
                        ]
                      }, undefined, true, undefined, this)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      fg: props.api.theme.current.textMuted,
                      wrapMode: "word",
                      children: limit.explanation
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this)),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().rolloutProgress,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.borderSubtle,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: [
                          /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                            children: "Automatic-apply rollout evidence"
                          }, undefined, false, undefined, this),
                          ": ",
                          settings().rolloutProgress.ready ? "Ready" : "Not ready"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Actual: ",
                          settings().rolloutProgress.actual
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Configured requirement: ",
                          settings().rolloutProgress.configured
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                    children: "Maintenance"
                  }, undefined, false, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: "Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data."
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 1,
                  children: () => settings().maintenance.scopes.map((scope) => /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    focusable: true,
                    border: true,
                    borderColor: maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle,
                    paddingLeft: 1,
                    paddingRight: 1,
                    onMouseUp: () => {
                      setMaintenanceScope(scope.value);
                      setMaintenanceIntent(null);
                      setMaintenanceConfirmation("");
                    },
                    onKeyDown: (event) => {
                      if (!isActivationKey(event))
                        return;
                      event.preventDefault();
                      setMaintenanceScope(scope.value);
                      setMaintenanceIntent(null);
                      setMaintenanceConfirmation("");
                    },
                    children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                      children: scope.label
                    }, undefined, false, undefined, this)
                  }, undefined, false, undefined, this))
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  wrapMode: "word",
                  children: settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                  flexDirection: "row",
                  flexWrap: "wrap",
                  gap: 1,
                  children: [
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: settings().maintenance.canExport,
                      children: localActionButton("Export selected scope", () => {
                        setMaintenanceIntent("export");
                        setMaintenanceConfirmation("");
                      }, true)
                    }, undefined, false, undefined, this),
                    /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                      when: maintenanceScope() === "all" ? settings().maintenance.canDeleteAll : settings().maintenance.canDeleteScope,
                      children: localActionButton("Delete selected scope", () => {
                        setMaintenanceIntent("delete");
                        setMaintenanceConfirmation("");
                      }, true)
                    }, undefined, false, undefined, this)
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: maintenanceIntent(),
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.warning,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: maintenanceIntent() === "export" ? "The export may contain classified Self-evolve evidence and active skill snapshots." : maintenanceScope() === "all" ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted." : "The selected retained data will be permanently deleted after fresh server validation."
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: [
                          "Type exactly: ",
                          maintenancePhrase()
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("input", {
                        value: maintenanceConfirmation(),
                        placeholder: maintenancePhrase(),
                        onInput: (value) => setMaintenanceConfirmation(value.slice(0, 64))
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                        flexDirection: "row",
                        flexWrap: "wrap",
                        gap: 1,
                        children: [
                          localActionButton(maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently", () => void submitMaintenance(), true),
                          localActionButton("Cancel", () => {
                            setMaintenanceIntent(null);
                            setMaintenanceConfirmation("");
                          })
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
                  when: settings().latestExport,
                  children: /* @__PURE__ */ jsxDEV_7x81h0kn("box", {
                    border: true,
                    borderColor: props.api.theme.current.warning,
                    paddingLeft: 1,
                    paddingRight: 1,
                    flexDirection: "column",
                    children: [
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        children: /* @__PURE__ */ jsxDEV_7x81h0kn("b", {
                          children: "Latest private export"
                        }, undefined, false, undefined, this)
                      }, undefined, false, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Scope: ",
                          settings().latestExport.scope
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Private path: ",
                          settings().latestExport.path
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Size: ",
                          settings().latestExport.bytes,
                          " bytes"
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "SHA-256: ",
                          settings().latestExport.sha256
                        ]
                      }, undefined, true, undefined, this),
                      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                        wrapMode: "word",
                        children: [
                          "Expires: ",
                          new Date(settings().latestExport.expiresAt).toISOString()
                        ]
                      }, undefined, true, undefined, this)
                    ]
                  }, undefined, true, undefined, this)
                }, undefined, false, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.textMuted,
                  wrapMode: "word",
                  children: [
                    "OpenCode ",
                    settings().footer.hostVersion,
                    " \xB7 Self-evolve ",
                    settings().footer.pluginVersion,
                    " \xB7 Projection ",
                    settings().footer.projectionVersion ?? "Unavailable",
                    " \xB7 Dashboard ",
                    settings().footer.dashboardVersion ?? "Unavailable"
                  ]
                }, undefined, true, undefined, this),
                /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
                  fg: props.api.theme.current.textMuted,
                  wrapMode: "word",
                  children: settings().footer.help
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        ]
      }, undefined, true, undefined, this),
      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
        when: completedResponse(),
        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: completedResponse()?.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info,
          wrapMode: "word",
          children: completedResponse()?.response?.ok === false ? `Server rejected ${completedResponse()?.action?.replaceAll("-", " ") ?? "the request"}: ${completedResponse()?.response?.reason}` : completedResponse()?.action === "purge-all" && completedResponse()?.response?.status === "accepted-terminal" ? "Purge all accepted; Self-evolve authority stopped. Restart OpenCode to reinitialize durable state." : `${completedResponse()?.action?.replaceAll("-", " ") ?? "Request"} accepted by the server.`
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV_7x81h0kn(Show, {
        when: feedback(),
        children: /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
          fg: props.api.theme.current.info,
          wrapMode: "word",
          children: feedback()
        }, undefined, false, undefined, this)
      }, undefined, false, undefined, this),
      /* @__PURE__ */ jsxDEV_7x81h0kn("text", {
        fg: props.api.theme.current.textMuted,
        children: [
          "Esc returns to ",
          props.prior.name
        ]
      }, undefined, true, undefined, this)
    ]
  }, undefined, true, undefined, this);
}
const tui = async (api, options, meta) => {
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
  const compatibilityOptions = {
    ...options ?? {},
    __nativeSidebar: true,
    __testTuiStoreFactory(input) {
      projectStore = acquireProjectTuiStore(input);
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
  let priorRoute = { name: "home" };
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE)
      return;
    api.route.navigate(priorRoute.name, priorRoute.params);
  };
  const openControlCenter = (destination = { section: "home" }) => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      priorRoute = {
        name: api.route.current.name,
        ..."params" in api.route.current ? { params: api.route.current.params } : {}
      };
    }
    api.route.navigate(CONTROL_CENTER_ROUTE, controlCenterRouteParams(destination, snapshot()));
  };
  const unregisterRoute = api.route.register([{
    name: CONTROL_CENTER_ROUTE,
    render: () => /* @__PURE__ */ jsxDEV_7x81h0kn(ControlCenter, {
      api,
      store: projectStore,
      snapshot,
      prior: priorRoute,
      initial: parseControlCenterDestination("params" in api.route.current ? api.route.current.params : undefined, snapshot())
    }, undefined, false, undefined, this)
  }]);
  const unregisterPaletteKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.paletteLayer,
    commands: [{
      name: CONTROL_CENTER_COMMAND,
      title: "Self-evolve control center",
      category: "Self-evolve",
      namespace: "palette",
      run: () => openControlCenter({ section: "home" })
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
        return /* @__PURE__ */ jsxDEV_7x81h0kn(SidebarCard, {
          api,
          card: () => deriveSidebarCard(snapshot()),
          open: () => {
            const card = deriveSidebarCard(snapshot());
            openControlCenter(card.destination);
          }
        }, undefined, false, undefined, this);
      }
    }
  });
};
const SelfEvolveTuiModule = {
  id: "mcrescenzo.self-evolve",
  tui
};
export default SelfEvolveTuiModule;
