/** @jsxImportSource @opentui/solid */

import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, Renderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { setTimeout as delay } from "node:timers/promises"
// The legacy helper module is JSDoc-typed (allowJs) as a default-only module at
// typecheck time; its named package-owned exports are present at runtime because
// Bun transpiles this raw TUI target. Suppress the resolver limitation here.
// @ts-ignore
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js"
import {
  CONTROL_CENTER_SECTIONS,
  acquireProjectTuiStore,
  buildControlCenterModel,
  controlCenterRouteParams,
  deriveSidebarCard,
  parseControlCenterDestination,
  validateApprovedSkillFolderInput,
} from "./self-evolve-tui-store.js"

const CARD_ID = "self-evolve-sidebar-card"
const CONTROL_CENTER_COMMAND = TUI_IDENTITIES.command
const CONTROL_CENTER_ROUTE = TUI_IDENTITIES.route
const CONTROL_CENTER_MODE = TUI_IDENTITIES.mode
const CONTROL_CENTER_VIEW_ID = TUI_IDENTITIES.view
const activeApis = new WeakSet<object>()

type ProjectStore = ReturnType<typeof acquireProjectTuiStore>
type MaintenanceScope = "observations" | "proposals" | "project" | "all"
type YoloTarget = "global" | "project"

function isActivationKey(event: KeyEvent) {
  return event.name === "return" || event.name === "linefeed" || event.name === "space"
}

function relativeTime(timestamp: number, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function SidebarCard(props: {
  api: Parameters<TuiPlugin>[0]
  card: () => ReturnType<typeof deriveSidebarCard>
  open: () => void
}) {
  let cardNode: Renderable | undefined
  const [focused, setFocused] = createSignal(false)
  const borderColor = () => {
    if (focused()) return props.api.theme.current.borderActive
    const tone = props.card()?.tone
    if (tone === "error") return props.api.theme.current.error
    if (tone === "warning") return props.api.theme.current.warning
    if (tone === "success") return props.api.theme.current.success
    if (tone === "neutral") return props.api.theme.current.borderSubtle
    return props.api.theme.current.info
  }
  return (
    <Show when={props.card()}>
      <box
        id={CARD_ID}
        ref={(value: Renderable) => (cardNode = value)}
        focusable
        border
        borderColor={borderColor()}
        width="100%"
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onMouseDown={() => cardNode?.focus()}
        onMouseUp={props.open}
        onKeyDown={(event: KeyEvent) => {
          if (!isActivationKey(event)) return
          event.preventDefault()
          props.open()
        }}
      >
        <text fg={props.api.theme.current.text}><b>{props.card()?.title}</b></text>
        <text fg={props.api.theme.current.textMuted} wrapMode="word">{props.card()?.summary}</text>
        <text fg={props.api.theme.current.textMuted} wrapMode="word">{props.card()?.detail}</text>
        <text fg={props.api.theme.current.info} wrapMode="word">{props.card()?.action}</text>
      </box>
    </Show>
  )
}

function ControlCenter(props: {
  api: Parameters<TuiPlugin>[0]
  store: ProjectStore
  snapshot: () => ReturnType<ProjectStore["getSnapshot"]>
  prior: { name: string; params?: Record<string, unknown> }
  initial: ReturnType<typeof parseControlCenterDestination>
}) {
  const names = CONTROL_CENTER_SECTIONS
  const [section, setSection] = createSignal<(typeof names)[number]>(props.initial.section)
  const [selectedIndex, setSelectedIndex] = createSignal(props.initial.selectedIndex ?? 0)
  const initialRecommendationState = props.snapshot().projection?.index?.reviews?.[props.initial.selectedIndex ?? 0]?.state
  const [recommendationFilter, setRecommendationFilter] = createSignal<"needs-review" | "applied" | "dismissed" | "all">(
    ["applied", "rolled-back"].includes(initialRecommendationState ?? "")
      ? "applied"
      : ["rejected", "superseded"].includes(initialRecommendationState ?? "")
        ? "dismissed"
        : "needs-review",
  )
  const [activityFilter, setActivityFilter] = createSignal(props.initial.filter ?? "all")
  const [settingsAnchor, setSettingsAnchor] = createSignal<string | undefined>(props.initial.anchor)
  const [rejectionReason, setRejectionReason] = createSignal<string | null>(null)
  const [rejectionText, setRejectionText] = createSignal("")
  const [technicalExpanded, setTechnicalExpanded] = createSignal(false)
  const [activityExpanded, setActivityExpanded] = createSignal<number | null>(null)
  const [diagnosticsExpanded, setDiagnosticsExpanded] = createSignal(false)
  const [feedback, setFeedback] = createSignal<string | null>(null)
  const [confirmation, setConfirmation] = createSignal<string | null>(null)
  const [folderInput, setFolderInput] = createSignal("")
  const [folderError, setFolderError] = createSignal<string | null>(null)
  const [folderDraft, setFolderDraft] = createSignal<string[] | null>(null)
  const [folderConfirmation, setFolderConfirmation] = createSignal("")
  const [yoloTarget, setYoloTarget] = createSignal<YoloTarget | null>(null)
  const [yoloConfirmation, setYoloConfirmation] = createSignal("")
  const [maintenanceScope, setMaintenanceScope] = createSignal<MaintenanceScope>("observations")
  const [maintenanceIntent, setMaintenanceIntent] = createSignal<"export" | "delete" | null>(null)
  const [maintenanceConfirmation, setMaintenanceConfirmation] = createSignal("")
  const model = createMemo(() => buildControlCenterModel(props.snapshot(), {
    selectedIndex: selectedIndex(),
    recommendationFilter: recommendationFilter(),
    activityFilter: activityFilter(),
  }))
  let popMode = () => {}
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE)
    selectRecommendation(selectedIndex())
  })
  onCleanup(() => popMode())
  const navigate = (next: {
    section: (typeof names)[number]
    selectedIndex?: number
    filter?: string
    anchor?: string
  }) => {
    setSection(next.section)
    setSettingsAnchor(next.section === "settings" ? next.anchor : undefined)
    if (Number.isSafeInteger(next.selectedIndex)) setSelectedIndex(next.selectedIndex!)
    if (typeof next.filter === "string") setActivityFilter(next.filter)
  }
  const moveSection = (offset: number) => {
    const index = names.indexOf(section())
    navigate({ section: names[(index + offset + names.length) % names.length] })
  }
  const selectRecommendation = (sourceIndex: number) => {
    const reviews = props.snapshot().projection?.index?.reviews ?? []
    if (!reviews[sourceIndex]) return
    setSelectedIndex(sourceIndex)
    const adjacent = reviews[sourceIndex + 1]?.proposalId ?? reviews[sourceIndex - 1]?.proposalId
    const ids = [reviews[sourceIndex].proposalId, adjacent].filter(Boolean).slice(0, 2)
    void props.store.selectDetails(ids)
    setConfirmation(null)
    setRejectionReason(null)
    setRejectionText("")
    setTechnicalExpanded(false)
  }
  const moveRecommendation = (offset: number) => {
    const queue = recommendations().queue
    if (!queue.length) return
    const current = Math.max(0, queue.findIndex((item) => item.sourceIndex === selectedIndex()))
    selectRecommendation(queue[(current + offset + queue.length) % queue.length].sourceIndex)
  }
  const invoke = async (key: string, operation: () => Promise<unknown> | unknown, requiresConfirmation = false) => {
    if (requiresConfirmation && confirmation() !== key) {
      setConfirmation(key)
      setFeedback(`Review the current state, then activate “Confirm ${key.replaceAll("-", " ")}”.`)
      return
    }
    try {
      await operation()
      setConfirmation(null)
      setFeedback("Request submitted. Server validation and the persistent state below determine the outcome.")
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const actionButton = (key: string, label: string, operation: () => Promise<unknown> | unknown, requiresConfirmation = false) => (
    <box
      focusable
      border
      paddingLeft={1}
      paddingRight={1}
      borderColor={confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
      onMouseUp={() => void invoke(key, operation, requiresConfirmation)}
      onKeyDown={(event: KeyEvent) => {
        if (!isActivationKey(event)) return
        event.preventDefault()
        void invoke(key, operation, requiresConfirmation)
      }}
    >
      <text fg={props.api.theme.current.text}>{confirmation() === key ? `Confirm ${label}` : label}</text>
    </box>
  )
  const localActionButton = (label: string, operation: () => void, warning = false, confirmationKey?: string) => (
    <box
      focusable
      border
      paddingLeft={1}
      paddingRight={1}
      borderColor={warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
      onMouseUp={operation}
      onKeyDown={(event: KeyEvent) => {
        if (!isActivationKey(event)) return
        event.preventDefault()
        operation()
      }}
    >
      <text fg={props.api.theme.current.text}>{confirmation() === confirmationKey ? `Confirm ${label}` : label}</text>
    </box>
  )
  const granted = () => new Set(
    (props.snapshot().projection?.index?.allowedActions ?? []).map((action) => action.action),
  )
  const paused = () => props.snapshot().dashboard?.settings?.paused === true
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true
  const completedResponse = () => props.snapshot().responses.at(-1)
  const home = () => model().sections.home
  const recommendations = () => model().sections.recommendations
  const activity = () => model().sections.activity
  const settings = () => model().sections.settings
  const consentEnabled = (key: string) => settings().consent.find((entry) => entry.key === key)?.enabled === true
  const modeRank = (value: string | null) => ({ manual: 0, auto: 1, yolo: 2 }[value ?? ""] ?? 0)
  const projectedModeFor = (target: string, scope: "global" | "project") => {
    if (scope === "global") return target
    return target === "inherit" ? settings().mode.global.value : target
  }
  const submitMode = (scope: "global" | "project", mode: "inherit" | "manual" | "auto" | "yolo") => {
    if (mode === "yolo") {
      if (!settings().modes.find((entry) => entry.value === "yolo")?.available) {
        setFeedback("Apply automatically is unavailable until every listed prerequisite passes.")
        return
      }
      setYoloTarget(scope)
      setYoloConfirmation("")
      setFeedback(`Type ENABLE YOLO to grant Apply automatically for the ${scope === "global" ? "global default" : "current project"}.`)
      return
    }
    const current = scope === "global" ? settings().mode.global.value : settings().mode.effective.value
    const riskIncreasing = modeRank(projectedModeFor(mode, scope)) > modeRank(current)
    const action = scope === "global" ? "set-mode" : "set-repo-mode"
    void invoke(
      `${scope}-mode-${mode}`,
      () => props.store.submitControl(action, { mode }),
      riskIncreasing,
    )
  }
  const waitForControlResponse = async (requestId: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      await props.store.refresh()
      const completed = props.snapshot().responses.find((entry) => entry.requestId === requestId)
      if (completed?.response) {
        if (completed.response.ok !== true) {
          throw new Error(completed.response.reason ?? "control-request-rejected")
        }
        return completed.response
      }
      await delay(100)
    }
    throw new Error("control-response-timeout")
  }
  const submitControlAndWait = async (action: string, payload: Record<string, unknown>) => {
    const request = await props.store.submitControl(action, payload)
    await waitForControlResponse(request.requestId)
  }
  const enableAutomaticRecommendations = async () => {
    if (!consentEnabled("passiveCalls")) {
      await submitControlAndWait("set-consent", { key: "passiveCalls", enabled: true })
    }
    if (!consentEnabled("durableObservations")) {
      await submitControlAndWait("set-consent", { key: "durableObservations", enabled: true })
    }
    if (modeRank(settings().mode.global.value) < modeRank("auto")) {
      await submitControlAndWait("set-mode", { mode: "auto" })
    }
  }
  const automaticRecommendationsReady = () => modeRank(settings().mode.global.value) >= modeRank("auto")
    && consentEnabled("passiveCalls")
    && consentEnabled("durableObservations")
  const confirmYolo = async () => {
    const target = yoloTarget()
    if (!target || yoloConfirmation() !== "ENABLE YOLO") {
      setFeedback("The exact phrase ENABLE YOLO is required.")
      return
    }
    try {
      await props.store.submitControl(
        target === "global" ? "set-mode" : "set-repo-mode",
        target === "global"
          ? {
            mode: "yolo",
            allowlist: [...settings().approvedSkillFolders],
            confirmation: "ENABLE YOLO",
          }
          : { mode: "yolo" },
      )
      setYoloTarget(null)
      setYoloConfirmation("")
      setFeedback("Apply automatically request submitted for fresh server-side prerequisite validation.")
    } catch (error) {
      setFeedback(`Apply automatically was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const stageFolderList = (next: string[]) => {
    if (next.length === 0 && settings().approvedSkillFolderRequiresNonEmpty) {
      setFolderError("At least one approved skill folder is required while Apply automatically is stored globally or for this project.")
      return
    }
    setFolderDraft(next)
    setFolderConfirmation("")
    setFolderError(null)
    setFeedback("Review the exact folder list below, then type UPDATE ALLOWLIST.")
  }
  const stageFolderAdd = () => {
    const checked = validateApprovedSkillFolderInput(folderInput(), settings().approvedSkillFolders)
    if (!checked.ok) {
      setFolderError(checked.error)
      return
    }
    setFolderInput("")
    stageFolderList([...settings().approvedSkillFolders, checked.value!])
    setFolderError(checked.warning)
  }
  const submitFolderList = async () => {
    const draft = folderDraft()
    if (!draft || folderConfirmation() !== "UPDATE ALLOWLIST") {
      setFolderError("The exact phrase UPDATE ALLOWLIST is required.")
      return
    }
    try {
      await props.store.submitControl("update-allowlist", {
        allowlist: draft,
        confirmation: "UPDATE ALLOWLIST",
      })
      setFolderDraft(null)
      setFolderConfirmation("")
      setFolderError(null)
      setFeedback("Approved skill folder replacement submitted for canonical server revalidation.")
    } catch (error) {
      setFolderError(`Folder replacement was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const maintenancePhrase = () => maintenanceIntent() === "export"
    ? "EXPORT SENSITIVE SELF-EVOLVE DATA"
    : maintenanceScope() === "all"
      ? "PURGE ALL SELF-EVOLVE DATA"
      : `PURGE ${maintenanceScope().toUpperCase()}`
  const submitMaintenance = async () => {
    const intent = maintenanceIntent()
    const scope = maintenanceScope()
    const phrase = maintenancePhrase()
    if (!intent || maintenanceConfirmation() !== phrase) {
      setFeedback(`The exact phrase ${phrase} is required.`)
      return
    }
    try {
      if (intent === "export") {
        await props.store.submitOperation("export-data", { scope, confirmation: phrase })
      } else if (scope === "all") {
        await props.store.submitOperation("purge-all", { confirmation: phrase })
      } else {
        await props.store.submitOperation("purge-scope", { scope, confirmation: phrase })
      }
      setMaintenanceIntent(null)
      setMaintenanceConfirmation("")
      setFeedback(scope === "all" && intent === "delete"
        ? "Purge all was submitted. An accepted response is terminal and requires restarting OpenCode."
        : "Maintenance request submitted. Server validation and the mounted outcome determine completion.")
    } catch (error) {
      setFeedback(`Maintenance request was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const openActivityDestination = (entry: ReturnType<typeof activity>["activity"][number]) => {
    if (entry.destination?.section !== "recommendations") return
    const sourceIndex = entry.destination.selectedIndex ?? 0
    const state = props.snapshot().projection?.index?.reviews?.[sourceIndex]?.state
    setRecommendationFilter(
      ["applied", "rolled-back"].includes(state ?? "")
        ? "applied"
        : ["rejected", "superseded"].includes(state ?? "")
          ? "dismissed"
          : "needs-review",
    )
    selectRecommendation(sourceIndex)
    navigate({ section: "recommendations", selectedIndex: sourceIndex })
  }
  const selectedProposalId = () => {
    const sourceIndex = recommendations().selected?.sourceIndex
    return Number.isSafeInteger(sourceIndex)
      ? props.snapshot().projection?.index?.reviews?.[sourceIndex!]?.proposalId ?? null
      : null
  }
  const pendingRecommendation = () => props.snapshot().pending.some((entry) =>
    ["apply-proposal", "reject-proposal", "snooze-proposal", "rollback-proposal"].includes(entry.action ?? ""))
  const activateRecommendation = async (action: string, snoozeMs?: number) => {
    const proposalId = selectedProposalId()
    if (!proposalId || pendingRecommendation()) return
    if (action === "open-activity") {
      navigate({ section: "activity", filter: "recommendations" })
      return
    }
    if (action === "acknowledge-audit") {
      const auditIds = (props.snapshot().dashboard?.activity ?? [])
        .filter((entry) => entry.outcome === "applied" && entry.proposalId === proposalId)
        .map((entry) => entry.id)
      props.store.acknowledgeAudits([...auditIds, proposalId])
      setFeedback("Applied result acknowledged locally. Activity history was retained.")
      return
    }
    const key = `${action}:${snoozeMs ?? ""}`
    if (confirmation() !== key) {
      setConfirmation(key)
      setFeedback(`Activate “Confirm ${action.replaceAll("-", " ")}” to continue.`)
      return
    }
    try {
      if (action === "apply-proposal") {
        await props.store.submitDecision({ proposalId, newState: "approved" })
      } else if (action === "reject-proposal") {
        const reason = rejectionReason()
        const feedbackValue = reason === null ? undefined : {
          reason,
          text: reason === "other" ? rejectionText().trim() : null,
        }
        if (reason === "other" && !feedbackValue!.text) {
          setFeedback("Add a short Other reason before rejecting, or clear the optional feedback.")
          return
        }
        await props.store.submitDecision({
          proposalId,
          newState: "rejected",
          ...(feedbackValue ? { feedback: feedbackValue } : {}),
        })
      } else if (action === "snooze-proposal") {
        await props.store.submitOperation("snooze-proposal", {
          snoozedUntil: Date.now() + (snoozeMs ?? 86_400_000),
        }, { proposalId })
      } else if (action === "rollback-proposal") {
        await props.store.submitOperation("rollback-proposal", {}, { proposalId })
      } else {
        throw new Error("unsupported-recommendation-action")
      }
      setConfirmation(null)
      setFeedback("Request submitted. Server validation and the mounted outcome determine completion.")
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <box
      id={CONTROL_CENTER_VIEW_ID}
      focusable
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" gap={1} flexWrap="wrap">
        <box flexDirection="column" flexGrow={1}>
          <text fg={props.api.theme.current.text}><b>Self-evolve</b></text>
          <text fg={props.api.theme.current.textMuted} wrapMode="word">
            {model().operational.label} · {home().mode.effective.label}
          </text>
        </box>
        <Show when={granted().has("set-paused")}>
          {actionButton(
            paused() ? "resume" : "pause",
            paused() ? "Resume" : "Pause",
            () => props.store.submitOperation("set-paused", { paused: !paused() }),
          )}
        </Show>
        <Show when={granted().has("set-kill-switch")}>
          {actionButton(
            emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop",
            emergencyStop() ? "Turn off Emergency stop" : "Emergency stop",
            () => props.store.submitOperation("set-kill-switch", { enabled: !emergencyStop() }),
            emergencyStop(),
          )}
        </Show>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap">
        {names.map((name) => (
          <box
            focusable
            border
            paddingLeft={1}
            paddingRight={1}
            borderColor={section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
            onMouseUp={() => navigate({ section: name })}
            onKeyDown={(event: KeyEvent) => {
              if (isActivationKey(event)) {
                event.preventDefault()
                navigate({ section: name })
              } else if (event.name === "left") {
                event.preventDefault()
                moveSection(-1)
              } else if (event.name === "right") {
                event.preventDefault()
                moveSection(1)
              }
            }}
          >
            <text fg={section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
              {name === "recommendations" && model().operational.count > 0 ? ` (${model().operational.count})` : ""}
            </text>
          </box>
        ))}
      </box>
      <scrollbox flexGrow={1} width="100%">
        <Show when={section() === "home"}>
          <box flexDirection="column" gap={1}>
            <text fg={props.api.theme.current.text}><b>{home().operational.label}</b></text>
            <text wrapMode="word">{home().operational.explanation}</text>
            <text fg={props.api.theme.current.textMuted} wrapMode="word">{home().operational.nextAction}</text>
            <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
              <text><b>Mode and scope</b></text>
              <text wrapMode="word">Effective: {home().mode.effective.label}</text>
              <text wrapMode="word">Global default: {home().mode.global.label}</text>
              <text wrapMode="word">This project: {home().mode.repository.label}</text>
            </box>
            <Show when={home().firstRun}>
              <box border borderColor={props.api.theme.current.info} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
                <text><b>Get automatic recommendations</b></text>
                <text wrapMode="word">Choose proactive review without granting automatic writes. Background AI analysis and saved structured patterns remain separate consent gates in Settings.</text>
                <Show when={settings().controls.globalMode}>
                  {actionButton(
                    "automatic-recommendations",
                    "Turn on automatic recommendations",
                    enableAutomaticRecommendations,
                    true,
                  )}
                </Show>
                <Show when={!settings().controls.globalMode}>
                  <text fg={props.api.theme.current.textMuted}>Controls are unavailable until the aligned server publishes fresh authority.</text>
                </Show>
                <text><b>Optional evidence excerpts</b></text>
                <text wrapMode="word">Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations.</text>
                <Show when={settings().controls.consent}>
                  {actionButton(
                    "first-run-sanitized-excerpts",
                    "Allow sanitized excerpts",
                    () => props.store.submitControl("set-consent", { key: "sanitizedExcerpts", enabled: true }),
                    true,
                  )}
                </Show>
                <Show when={!settings().controls.consent}>
                  <text fg={props.api.theme.current.textMuted}>Excerpt consent can be changed later in Settings.</text>
                </Show>
              </box>
            </Show>
            <Show when={home().blockers.length}>
              <box flexDirection="column">
                <text><b>Setup</b></text>
                {() => home().blockers.map((blocker) => (
                  <box
                    focusable
                    border
                    borderColor={props.api.theme.current.warning}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={() => navigate({ section: "settings", anchor: blocker.code })}
                    onKeyDown={(event: KeyEvent) => {
                      if (!isActivationKey(event)) return
                      event.preventDefault()
                      navigate({ section: "settings", anchor: blocker.code })
                    }}
                  >
                    <text wrapMode="word">{blocker.summary} · Open Settings</text>
                  </box>
                ))}
              </box>
            </Show>
            <Show when={home().lastCycle}>
              <box flexDirection="column">
                <text><b>Last cycle</b></text>
                <text wrapMode="word">{home().lastCycle!.outcome.replaceAll("-", " ")} · {home().lastCycle!.observationCount} observations · {home().lastCycle!.eligibilityCount} eligible</text>
              </box>
            </Show>
            <Show when={home().attention}>
              <box
                focusable
                border
                borderColor={props.api.theme.current.warning}
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => navigate(home().attention!.destination)}
                onKeyDown={(event: KeyEvent) => {
                  if (!isActivationKey(event)) return
                  event.preventDefault()
                  navigate(home().attention!.destination)
                }}
              >
                <text>{home().attention!.count} {home().attention!.kind === "applied" ? "applied change" : "recommendation"} needs attention</text>
              </box>
            </Show>
            <Show when={home().usage}>
              <box flexDirection="column">
                <text><b>Actual usage</b></text>
                <text>Background analysis: {home().usage!.passive.used} / {home().usage!.passive.limit}</text>
                <text>Recommendation synthesis: {home().usage!.synthesis.used} / {home().usage!.synthesis.limit}</text>
                <text>Storage: {home().usage!.storage.usedBytes} / {home().usage!.storage.limitBytes} bytes</text>
              </box>
            </Show>
            <Show when={home().recentActivity.length}>
              <box flexDirection="column">
                <text><b>Recent activity</b></text>
                {() => home().recentActivity.map((entry) => <text wrapMode="word">[{entry.marker}] {entry.summary}</text>)}
              </box>
            </Show>
            <Show when={home().emptyState}>
              <box flexDirection="column">
                <text><b>{home().emptyState!.heading}</b></text>
                <text wrapMode="word">{home().emptyState!.explanation}</text>
              </box>
            </Show>
            <text fg={props.api.theme.current.textMuted} wrapMode="word">{home().manualFallback}</text>
          </box>
        </Show>
        <Show when={section() === "recommendations"}>
          <box flexDirection="column" gap={1}>
            <text><b>Recommendations</b></text>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {([
                ["needs-review", "Needs review"],
                ["applied", "Applied"],
                ["dismissed", "Dismissed"],
                ["all", "All"],
              ] as const).map(([value, label]) => (
                <box
                  focusable
                  border
                  borderColor={recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => {
                    setRecommendationFilter(value)
                    const first = buildControlCenterModel(props.snapshot(), { recommendationFilter: value }).sections.recommendations.queue[0]
                    if (first) selectRecommendation(first.sourceIndex)
                  }}
                  onKeyDown={(event: KeyEvent) => {
                    if (!isActivationKey(event)) return
                    event.preventDefault()
                    setRecommendationFilter(value)
                    const first = buildControlCenterModel(props.snapshot(), { recommendationFilter: value }).sections.recommendations.queue[0]
                    if (first) selectRecommendation(first.sourceIndex)
                  }}
                >
                  <text>{label}</text>
                </box>
              ))}
            </box>
            <Show when={recommendations().emptyState}><text>{recommendations().emptyState}</text></Show>
            {() => recommendations().queue.map((item, index) => (
              <box
                focusable
                border
                borderColor={recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                paddingLeft={1}
                paddingRight={1}
                flexDirection="column"
                onMouseUp={() => selectRecommendation(item.sourceIndex)}
                onKeyDown={(event: KeyEvent) => {
                  if (isActivationKey(event)) {
                    event.preventDefault()
                    selectRecommendation(item.sourceIndex)
                  } else if (event.name === "up") {
                    event.preventDefault()
                    moveRecommendation(-1)
                  } else if (event.name === "down") {
                    event.preventDefault()
                    moveRecommendation(1)
                  }
                }}
              >
                <text wrapMode="word">
                  {item.attention === "critical" ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : ""}
                  {item.target} · {item.state.replaceAll("-", " ")} · {relativeTime(item.updatedAt)}
                </text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{item.rationale}</text>
                <text fg={props.api.theme.current.textMuted}>
                  Risk: {item.risk ?? "Loading"} · Evidence: {item.evidenceCount ?? "Loading"}
                </text>
              </box>
            ))}
            <Show when={recommendations().selected}>
              <box border borderColor={props.api.theme.current.borderActive} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
                <text><b>{recommendations().selected!.target}</b></text>
                <Show when={recommendations().selected!.loading}>
                  <text>Loading authoritative recommendation detail…</text>
                </Show>
                <Show when={recommendations().selected!.summary}>
                  <box flexDirection="column">
                    <text><b>Why this was suggested</b></text>
                    <text wrapMode="word">{recommendations().selected!.summary!.rationale}</text>
                  </box>
                  <box flexDirection="column">
                    <text><b>Proposed change</b></text>
                    {() => recommendations().selected!.diff?.lines.map((line) => <text wrapMode="word">{line}</text>) ?? []}
                    <Show when={recommendations().selected!.diff?.overflow?.truncated}>
                      <text fg={props.api.theme.current.warning}>The proposed change was truncated by the bounded projection.</text>
                    </Show>
                  </box>
                  <box flexDirection="column">
                    <text><b>Evidence</b></text>
                    {() => recommendations().selected!.evidence.map((entry) =>
                      <text wrapMode="word">{entry.kind}: {entry.summary}{entry.redacted ? " [redacted]" : ""}</text>)}
                    <Show when={!recommendations().selected!.evidence.length}><text>No bounded evidence detail is loaded.</text></Show>
                  </box>
                  <box flexDirection="column">
                    <text><b>Safety checks</b></text>
                    <text>Critic: {recommendations().selected!.summary!.criticPassed ? "Passed" : "Not passed"}</text>
                    <text>Deterministic checks: {recommendations().selected!.summary!.validDeterministic ? "Passed" : "Not passed"}</text>
                    <text>Injection scan: {recommendations().selected!.summary!.injectionFlagged ? "Flagged" : "Clear"}</text>
                    {() => recommendations().selected!.summary!.eligibility.checks.map((check) =>
                      <text wrapMode="word">[{check.met ? "Passed" : "Blocked"}] {check.name}: {check.actual} / {check.required}</text>)}
                  </box>
                  <box flexDirection="column">
                    <text><b>Token impact</b></text>
                    <text>{recommendations().selected!.summary!.tokenImpact.estimatedTokens} estimated / {recommendations().selected!.summary!.tokenImpact.budgetTokens} budgeted tokens</text>
                  </box>
                  <box flexDirection="column">
                    <text><b>Rollback</b></text>
                    <text>{recommendations().selected!.summary!.rollback.eligible ? "Undo is currently eligible." : `Unavailable: ${recommendations().selected!.summary!.rollback.reason ?? "not offered"}`}</text>
                  </box>
                  <box
                    focusable
                    border
                    borderColor={technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={() => setTechnicalExpanded((value) => !value)}
                    onKeyDown={(event: KeyEvent) => {
                      if (!isActivationKey(event)) return
                      event.preventDefault()
                      setTechnicalExpanded((value) => !value)
                    }}
                  >
                    <text>Technical details {technicalExpanded() ? "▲" : "▼"}</text>
                  </box>
                  <Show when={technicalExpanded()}>
                    <text>State: {recommendations().selected!.summary!.state}</text>
                    <text>Effective mode: {recommendations().selected!.summary!.effectiveMode}</text>
                    <text>Operation: {recommendations().selected!.summary!.operation.status}</text>
                    {() => recommendations().selected!.audit.map((entry) =>
                      <text wrapMode="word">{entry.kind}: {entry.summary}</text>)}
                  </Show>
                </Show>
                <Show when={recommendations().selected!.actions.some((action) =>
                  action.action === "reject-proposal" && action.feedbackSupported)}>
                  <box flexDirection="column">
                    <text fg={props.api.theme.current.textMuted}>Optional rejection feedback (audit-only)</text>
                    <box flexDirection="row" gap={1} flexWrap="wrap">
                      {() => recommendations().rejectionFeedbackOptions.map((option) => (
                        <box
                          focusable
                          border
                          borderColor={rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                          paddingLeft={1}
                          paddingRight={1}
                          onMouseUp={() => setRejectionReason(rejectionReason() === option.value ? null : option.value)}
                          onKeyDown={(event: KeyEvent) => {
                            if (!isActivationKey(event)) return
                            event.preventDefault()
                            setRejectionReason(rejectionReason() === option.value ? null : option.value)
                          }}
                        >
                          <text>{option.label}</text>
                        </box>
                      ))}
                    </box>
                    <Show when={rejectionReason() === "other"}>
                      <input
                        value={rejectionText()}
                        placeholder="Optional bounded reason (512 characters)"
                        onInput={(value: string) => setRejectionText(value.slice(0, 512))}
                      />
                    </Show>
                  </box>
                </Show>
                <box flexDirection="row" gap={1} flexWrap="wrap">
                  {() => recommendations().selected!.actions.flatMap((action) => {
                    const choices = action.action === "snooze-proposal"
                      ? [
                        { label: "Snooze 1 hour", delay: 3_600_000 },
                        { label: "Snooze 1 day", delay: 86_400_000 },
                        { label: "Snooze 7 days", delay: 604_800_000 },
                      ]
                      : [{
                        label: action.action === "rollback-proposal"
                          ? "Undo"
                          : action.action === "acknowledge-audit"
                            ? "Acknowledge"
                            : action.label,
                        delay: undefined,
                      }]
                    return choices.map((choice) => {
                      const key = `${action.action}:${choice.delay ?? ""}`
                      return (
                        <box
                          focusable={!pendingRecommendation()}
                          border
                          borderColor={confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
                          paddingLeft={1}
                          paddingRight={1}
                          onMouseUp={() => void activateRecommendation(action.action, choice.delay)}
                          onKeyDown={(event: KeyEvent) => {
                            if (!isActivationKey(event)) return
                            event.preventDefault()
                            void activateRecommendation(action.action, choice.delay)
                          }}
                        >
                          <text>{confirmation() === key ? `Confirm ${choice.label}` : choice.label}</text>
                        </box>
                      )
                    })
                  })}
                  <box
                    focusable
                    border
                    borderColor={props.api.theme.current.borderSubtle}
                    paddingLeft={1}
                    paddingRight={1}
                    onMouseUp={() => void activateRecommendation("open-activity")}
                    onKeyDown={(event: KeyEvent) => {
                      if (!isActivationKey(event)) return
                      event.preventDefault()
                      void activateRecommendation("open-activity")
                    }}
                  >
                    <text>Open in Activity</text>
                  </box>
                </box>
                <Show when={pendingRecommendation()}>
                  <text fg={props.api.theme.current.info}>Request pending server validation…</text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
        <Show when={section() === "activity"}>
          <box flexDirection="column" gap={1}>
            <text><b>Activity</b></text>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {([
                ["all", "All"],
                ["recommendations", "Recommendations"],
                ["system", "System"],
                ["errors", "Errors"],
              ] as const).map(([value, label]) => (
                <box
                  focusable
                  border
                  borderColor={activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => {
                    setActivityFilter(value)
                    setActivityExpanded(null)
                  }}
                  onKeyDown={(event: KeyEvent) => {
                    if (!isActivationKey(event)) return
                    event.preventDefault()
                    setActivityFilter(value)
                    setActivityExpanded(null)
                  }}
                >
                  <text>{label}</text>
                </box>
              ))}
            </box>
            <Show when={activity().emptyState}><text wrapMode="word">{activity().emptyState}</text></Show>
            {() => activity().activity.map((entry, index) => (
              <box
                focusable
                border
                borderColor={activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                paddingLeft={1}
                paddingRight={1}
                flexDirection="column"
                onMouseUp={() => setActivityExpanded(activityExpanded() === index ? null : index)}
                onKeyDown={(event: KeyEvent) => {
                  if (isActivationKey(event)) {
                    event.preventDefault()
                    setActivityExpanded(activityExpanded() === index ? null : index)
                  } else if (event.name === "right" && entry.destination?.section === "recommendations") {
                    event.preventDefault()
                    openActivityDestination(entry)
                  }
                }}
              >
                <text wrapMode="word">
                  [{entry.marker}] {entry.summary} · {relativeTime(entry.occurredAt)}
                </text>
                <Show when={entry.target}><text fg={props.api.theme.current.textMuted}>Skill: {entry.target}</text></Show>
                <Show when={activityExpanded() === index}>
                  <text fg={props.api.theme.current.textMuted}>Category: {entry.technical.category}</text>
                  <text fg={props.api.theme.current.textMuted}>Outcome: {entry.technical.outcome.replaceAll("-", " ")}</text>
                  <Show when={entry.technical.reason}>
                    <text fg={props.api.theme.current.textMuted}>Reason: {entry.technical.reason!.replaceAll("-", " ")}</text>
                  </Show>
                  <Show when={entry.destination?.section === "recommendations"}>
                    <box
                      focusable
                      border
                      borderColor={props.api.theme.current.borderSubtle}
                      paddingLeft={1}
                      paddingRight={1}
                      onMouseUp={() => openActivityDestination(entry)}
                      onKeyDown={(event: KeyEvent) => {
                        if (!isActivationKey(event)) return
                        event.preventDefault()
                        openActivityDestination(entry)
                      }}
                    >
                      <text>Open recommendation</text>
                    </box>
                  </Show>
                </Show>
              </box>
            ))}
            <Show when={activity().overflowMessage}>
              <text fg={props.api.theme.current.warning} wrapMode="word">{activity().overflowMessage}</text>
            </Show>
            <box
              focusable
              border
              borderColor={diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
              paddingLeft={1}
              paddingRight={1}
              onMouseUp={() => setDiagnosticsExpanded((value) => !value)}
              onKeyDown={(event: KeyEvent) => {
                if (!isActivationKey(event)) return
                event.preventDefault()
                setDiagnosticsExpanded((value) => !value)
              }}
            >
              <text>Diagnostics {diagnosticsExpanded() ? "▲" : "▼"}</text>
            </box>
            <Show when={diagnosticsExpanded()}>
              <box flexDirection="column">
                <text wrapMode="word">Projection refreshed: {activity().diagnostics.refreshedAt ? relativeTime(activity().diagnostics.refreshedAt) : "Unavailable"}</text>
                <text wrapMode="word">Core projection: {activity().diagnostics.coreProjection}</text>
                <text wrapMode="word">Enhanced projection: {activity().diagnostics.enhancedProjection}</text>
                <text wrapMode="word">OpenCode: {activity().diagnostics.runtime.hostVersion} ({activity().diagnostics.runtime.hostVersionSource})</text>
                <text wrapMode="word">Self-evolve: {activity().diagnostics.runtime.pluginVersion}</text>
                <text wrapMode="word">Projection protocol: {activity().diagnostics.runtime.projectionVersion ?? "Unavailable"}</text>
                <text wrapMode="word">Dashboard protocol: {activity().diagnostics.runtime.dashboardVersion ?? "Unavailable"}</text>
                <text wrapMode="word">Refresh watcher: {activity().diagnostics.watcherStatus}</text>
                <text wrapMode="word">Circuit breaker: {activity().diagnostics.breakerStatus}</text>
                <Show when={activity().diagnostics.automation}>
                  <text wrapMode="word">Scheduler: {activity().diagnostics.automation!.state.replaceAll("-", " ")}</text>
                </Show>
                <Show when={activity().diagnostics.backoffUntil}>
                  <text wrapMode="word">Backoff ends: {new Date(activity().diagnostics.backoffUntil!).toISOString()}</text>
                </Show>
                <Show when={activity().diagnostics.nextEligibleAt}>
                  <text wrapMode="word">Next eligible: {new Date(activity().diagnostics.nextEligibleAt!).toISOString()}</text>
                </Show>
                <Show when={activity().diagnostics.usage}>
                  <text wrapMode="word">Background analysis used/remaining: {activity().diagnostics.usage!.passive.used} / {activity().diagnostics.usage!.passive.remaining}</text>
                  <text wrapMode="word">Background analysis resets: {new Date(activity().diagnostics.budgetResetAt!.passive).toISOString()}</text>
                  <text wrapMode="word">Recommendation synthesis used/remaining: {activity().diagnostics.usage!.synthesis.used} / {activity().diagnostics.usage!.synthesis.remaining}</text>
                  <text wrapMode="word">Recommendation synthesis resets: {new Date(activity().diagnostics.budgetResetAt!.synthesis).toISOString()}</text>
                  <text wrapMode="word">Storage used/quota: {activity().diagnostics.usage!.storage.usedBytes} / {activity().diagnostics.usage!.storage.limitBytes} bytes</text>
                </Show>
                <Show when={activity().diagnostics.lastError}>
                  <text wrapMode="word">Last bounded error: {activity().diagnostics.lastError!.summary}</text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
        <Show when={section() === "settings"}>
          <box flexDirection="column" gap={1}>
            <text><b>Settings</b></text>
            <Show when={settingsAnchor()}>
              <text fg={props.api.theme.current.info} wrapMode="word">
                Opened at {settingsAnchor()!.replaceAll("-", " ")} settings.
              </text>
            </Show>
            <Show when={settings().limited}>
              <text fg={props.api.theme.current.warning} wrapMode="word">
                Limited view: enhanced usage, repository-mode editing, and prerequisite status require an aligned server.
              </text>
            </Show>
            <Show when={settings().enhancedError}>
              <text fg={props.api.theme.current.error} wrapMode="word">{settings().enhancedError}</text>
            </Show>

            <text><b>Modes</b></text>
            <text wrapMode="word">Effective result: {settings().mode.effective.label}</text>
            <text wrapMode="word">Global default: {settings().mode.global.label}</text>
            <text wrapMode="word">This project: {settings().mode.repository.label}</text>
            <text fg={props.api.theme.current.textMuted} wrapMode="word">
              The global default applies to every current and future project. “Use for this project” creates an override here only.
            </text>
            <Show when={settings().controls.globalMode && settings().controls.consent && !automaticRecommendationsReady()}>
              <box border borderColor={props.api.theme.current.info} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
                <text><b>Automatic recommendations setup</b></text>
                <text wrapMode="word">
                  One confirmation enables background AI analysis, saved structured patterns, and the Analyze and recommend global mode in sequence. Sanitized excerpts remain a separate choice.
                </text>
                {actionButton(
                  "automatic-recommendations",
                  "Turn on automatic recommendations",
                  enableAutomaticRecommendations,
                  true,
                )}
              </box>
            </Show>
            {() => settings().modes.map((mode) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{mode.label}</b>{settings().mode.effective.value === mode.value ? " · Effective now" : ""}</text>
                <text wrapMode="word">{mode.description}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Provider use: {mode.providerUse}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Saved data: {mode.savedData}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Write authority: {mode.writeAuthority}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Prerequisites: {mode.prerequisites}</text>
                <Show when={mode.blockers.length}>
                  {() => mode.blockers.map((blocker) => <text fg={props.api.theme.current.warning} wrapMode="word">• {blocker}</text>)}
                </Show>
                <Show when={mode.available}>
                  <box flexDirection="row" flexWrap="wrap" gap={1}>
                    <Show when={settings().controls.globalMode}>
                      {localActionButton(
                        settings().mode.global.value === mode.value ? "Global default ✓" : "Set global default",
                        () => submitMode("global", mode.value as "manual" | "auto" | "yolo"),
                        mode.value === "yolo",
                        `global-mode-${mode.value}`,
                      )}
                    </Show>
                    <Show when={settings().controls.repositoryMode}>
                      {localActionButton(
                        settings().mode.repository.value === mode.value ? "This project ✓" : "Use for this project",
                        () => submitMode("project", mode.value as "manual" | "auto" | "yolo"),
                        mode.value === "yolo",
                        `project-mode-${mode.value}`,
                      )}
                    </Show>
                  </box>
                </Show>
              </box>
            ))}
            <Show when={settings().controls.repositoryMode}>
              {localActionButton(
                settings().mode.repository.value === "inherit" ? "Inherit global default ✓" : "Make this project inherit global default",
                () => submitMode("project", "inherit"),
                false,
                "project-mode-inherit",
              )}
            </Show>
            <Show when={yoloTarget()}>
              <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text wrapMode="word">
                  Apply automatically expands write authority for the {yoloTarget() === "global" ? "global default" : "current project"}.
                  Approved folders and every current prerequisite will be revalidated by the server.
                </text>
                <text>Type exactly: ENABLE YOLO</text>
                <input
                  value={yoloConfirmation()}
                  placeholder="ENABLE YOLO"
                  onInput={(value: string) => setYoloConfirmation(value.slice(0, 64))}
                />
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  {localActionButton("Submit Apply automatically", () => void confirmYolo(), true)}
                  {localActionButton("Cancel", () => {
                    setYoloTarget(null)
                    setYoloConfirmation("")
                  })}
                </box>
              </box>
            </Show>

            <text><b>Privacy and project scope</b></text>
            <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
              <text><b>Include this project</b>: {settings().projectExcluded ? "No" : "Yes"}</text>
              <text wrapMode="word">
                Excluding this project overrides automatic global modes without changing global settings.
              </text>
              <Show when={settings().controls.projectInclusion}>
                {actionButton(
                  settings().projectExcluded ? "include-project" : "exclude-project",
                  settings().projectExcluded ? "Include this project" : "Exclude this project",
                  () => props.store.submitControl("set-repo-excluded", { excluded: !settings().projectExcluded }),
                  settings().projectExcluded === true,
                )}
              </Show>
            </box>
            {() => settings().consent.map((entry) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{entry.label}</b>: {entry.enabled ? "Allowed" : "Not allowed"} · {entry.scope}</text>
                <text wrapMode="word">{entry.description}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{entry.dependency}</text>
                <Show when={settings().controls.consent && (entry.enabled || entry.canEnable)}>
                  {actionButton(
                    `consent-${entry.key}-${entry.enabled ? "off" : "on"}`,
                    entry.enabled ? `Stop allowing ${entry.label}` : `Allow ${entry.label}`,
                    () => props.store.submitControl("set-consent", { key: entry.key, enabled: !entry.enabled }),
                    !entry.enabled,
                  )}
                </Show>
                <Show when={!entry.enabled && !entry.canEnable}>
                  <text fg={props.api.theme.current.warning} wrapMode="word">Resolve the dependency above before enabling this setting.</text>
                </Show>
              </box>
            ))}
            <text wrapMode="word">Pause automatic work: {settings().paused ? "Paused" : "Running when eligible"}. Pause preserves modes and consent.</text>
            <text wrapMode="word">Emergency stop: {settings().emergencyStop ? "On" : "Off"}. It overrides every automatic provider and write path.</text>

            <text><b>Approved skill folders</b></text>
            <text wrapMode="word">{settings().approvedSkillFolderWarning}</text>
            <Show when={!settings().approvedSkillFolders.length}>
              <text fg={props.api.theme.current.warning} wrapMode="word">No folder is approved; Apply automatically cannot be enabled.</text>
            </Show>
            {() => settings().approvedSkillFolders.map((folder) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="row" flexWrap="wrap" gap={1}>
                <text wrapMode="word">{folder}</text>
                <Show when={settings().controls.approvedSkillFolders}>
                  {localActionButton("Remove", () => stageFolderList(
                    settings().approvedSkillFolders.filter((candidate) => candidate !== folder),
                  ))}
                </Show>
              </box>
            ))}
            <Show when={settings().controls.approvedSkillFolders}>
              <box flexDirection="column">
                <text>Add one canonical absolute folder</text>
                <input
                  value={folderInput()}
                  placeholder="/canonical/path/to/skills"
                  onInput={(value: string) => {
                    setFolderInput(value.slice(0, 4096))
                    setFolderError(null)
                  }}
                />
                {localActionButton("Add folder", stageFolderAdd)}
              </box>
            </Show>
            <Show when={folderError()}>
              <text fg={props.api.theme.current.warning} wrapMode="word">{folderError()}</text>
            </Show>
            <Show when={folderDraft()}>
              <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>Exact replacement</b></text>
                <Show when={folderDraft()!.length}>
                  {() => folderDraft()!.map((folder) => <text wrapMode="word">• {folder}</text>)}
                </Show>
                <Show when={folderDraft()!.length === 0}><text>(empty)</text></Show>
                <text>Type exactly: UPDATE ALLOWLIST</text>
                <input
                  value={folderConfirmation()}
                  placeholder="UPDATE ALLOWLIST"
                  onInput={(value: string) => setFolderConfirmation(value.slice(0, 64))}
                />
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  {localActionButton("Replace approved folders", () => void submitFolderList(), true)}
                  {localActionButton("Cancel", () => {
                    setFolderDraft(null)
                    setFolderConfirmation("")
                  })}
                </box>
              </box>
            </Show>

            <text><b>Limits and retention</b></text>
            <text wrapMode="word">These values are read-only here. Change configured numeric limits through startup configuration.</text>
            {() => settings().limits.map((limit) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{limit.label}</b></text>
                <text wrapMode="word">Actual: {limit.actual}</text>
                <text wrapMode="word">Configured limit: {limit.configured}</text>
                <Show when={limit.resetAt}><text wrapMode="word">Resets: {new Date(limit.resetAt!).toISOString()}</text></Show>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{limit.explanation}</text>
              </box>
            ))}
            <Show when={settings().rolloutProgress}>
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>Automatic-apply rollout evidence</b>: {settings().rolloutProgress!.ready ? "Ready" : "Not ready"}</text>
                <text wrapMode="word">Actual: {settings().rolloutProgress!.actual}</text>
                <text wrapMode="word">Configured requirement: {settings().rolloutProgress!.configured}</text>
              </box>
            </Show>

            <text><b>Maintenance</b></text>
            <text wrapMode="word">Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.</text>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              {() => settings().maintenance.scopes.map((scope) => (
                <box
                  focusable
                  border
                  borderColor={maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  onMouseUp={() => {
                    setMaintenanceScope(scope.value as MaintenanceScope)
                    setMaintenanceIntent(null)
                    setMaintenanceConfirmation("")
                  }}
                  onKeyDown={(event: KeyEvent) => {
                    if (!isActivationKey(event)) return
                    event.preventDefault()
                    setMaintenanceScope(scope.value as MaintenanceScope)
                    setMaintenanceIntent(null)
                    setMaintenanceConfirmation("")
                  }}
                >
                  <text>{scope.label}</text>
                </box>
              ))}
            </box>
            <text wrapMode="word">
              {settings().maintenance.scopes.find((scope) => scope.value === maintenanceScope())?.explanation}
            </text>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              <Show when={settings().maintenance.canExport}>
                {localActionButton("Export selected scope", () => {
                  setMaintenanceIntent("export")
                  setMaintenanceConfirmation("")
                }, true)}
              </Show>
              <Show when={maintenanceScope() === "all" ? settings().maintenance.canDeleteAll : settings().maintenance.canDeleteScope}>
                {localActionButton("Delete selected scope", () => {
                  setMaintenanceIntent("delete")
                  setMaintenanceConfirmation("")
                }, true)}
              </Show>
            </box>
            <Show when={maintenanceIntent()}>
              <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text wrapMode="word">
                  {maintenanceIntent() === "export"
                    ? "The export may contain classified Self-evolve evidence and active skill snapshots."
                    : maintenanceScope() === "all"
                      ? "Deleting everything is accepted-terminal: Self-evolve stops authority before deleting its mailbox subtree, and OpenCode must be restarted."
                      : "The selected retained data will be permanently deleted after fresh server validation."}
                </text>
                <text>Type exactly: {maintenancePhrase()}</text>
                <input
                  value={maintenanceConfirmation()}
                  placeholder={maintenancePhrase()}
                  onInput={(value: string) => setMaintenanceConfirmation(value.slice(0, 64))}
                />
                <box flexDirection="row" flexWrap="wrap" gap={1}>
                  {localActionButton(
                    maintenanceIntent() === "export" ? "Create sensitive export" : "Delete permanently",
                    () => void submitMaintenance(),
                    true,
                  )}
                  {localActionButton("Cancel", () => {
                    setMaintenanceIntent(null)
                    setMaintenanceConfirmation("")
                  })}
                </box>
              </box>
            </Show>
            <Show when={settings().latestExport}>
              <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>Latest private export</b></text>
                <text wrapMode="word">Scope: {settings().latestExport!.scope}</text>
                <text wrapMode="word">Private path: {settings().latestExport!.path}</text>
                <text wrapMode="word">Size: {settings().latestExport!.bytes} bytes</text>
                <text wrapMode="word">SHA-256: {settings().latestExport!.sha256}</text>
                <text wrapMode="word">Expires: {new Date(settings().latestExport!.expiresAt).toISOString()}</text>
              </box>
            </Show>

            <text fg={props.api.theme.current.textMuted} wrapMode="word">
              OpenCode {settings().footer.hostVersion} · Self-evolve {settings().footer.pluginVersion} · Projection {settings().footer.projectionVersion ?? "Unavailable"} · Dashboard {settings().footer.dashboardVersion ?? "Unavailable"}
            </text>
            <text fg={props.api.theme.current.textMuted} wrapMode="word">{settings().footer.help}</text>
          </box>
        </Show>
      </scrollbox>
      <Show when={completedResponse()}>
        <text fg={completedResponse()?.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info} wrapMode="word">
          {completedResponse()?.response?.ok === false
            ? `Server rejected ${completedResponse()?.action?.replaceAll("-", " ") ?? "the request"}: ${completedResponse()?.response?.reason}`
            : completedResponse()?.action === "purge-all" && completedResponse()?.response?.status === "accepted-terminal"
              ? "Purge all accepted; Self-evolve authority stopped. Restart OpenCode to reinitialize durable state."
              : `${completedResponse()?.action?.replaceAll("-", " ") ?? "Request"} accepted by the server.`}
        </text>
      </Show>
      <Show when={feedback()}>
        <text fg={props.api.theme.current.info} wrapMode="word">{feedback()}</text>
      </Show>
      <text fg={props.api.theme.current.textMuted}>
        Esc returns to {props.prior.name}
      </text>
    </box>
  )
}

const tui: TuiPlugin = async (api, options, meta) => {
  if (activeApis.has(api)) return
  const surfaceOwnership = claimTuiSurfaceOwnership(api)
  if (!surfaceOwnership.owned) {
    console.warn(`self-evolve TUI registration skipped: ${surfaceOwnership.reason}`.slice(0, 240))
    return
  }
  if (surfaceOwnership.duplicate) return
  activeApis.add(api)
  let releaseWithNativeCleanup = false
  api.lifecycle.onDispose(() => {
    activeApis.delete(api)
    if (!releaseWithNativeCleanup) surfaceOwnership.release?.()
  })
  let projectStore: ProjectStore | undefined
  const compatibilityOptions = {
    ...(options ?? {}),
    __nativeSidebar: true,
    __testTuiStoreFactory(input: Parameters<typeof acquireProjectTuiStore>[0]) {
      projectStore = acquireProjectTuiStore(input)
      return projectStore
    },
  }
  await legacyModule.tui(api, compatibilityOptions, meta)
  if (!projectStore) return
  releaseWithNativeCleanup = true
  const [snapshot, setSnapshot] = createSignal(projectStore.getSnapshot())
  const unsubscribe = projectStore.subscribe(setSnapshot)
  api.lifecycle.onDispose(unsubscribe)
  let priorRoute: { name: string; params?: Record<string, unknown> } = { name: "home" }
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) return
    api.route.navigate(priorRoute.name, priorRoute.params)
  }
  const openControlCenter = (destination: ReturnType<typeof deriveSidebarCard>["destination"] = { section: "home" }) => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      priorRoute = {
        name: api.route.current.name,
        ...("params" in api.route.current ? { params: api.route.current.params } : {}),
      }
    }
    api.route.navigate(CONTROL_CENTER_ROUTE, controlCenterRouteParams(destination, snapshot()))
  }
  const unregisterRoute = api.route.register([{
    name: CONTROL_CENTER_ROUTE,
    render: () => <ControlCenter
      api={api}
      store={projectStore!}
      snapshot={snapshot}
      prior={priorRoute}
      initial={parseControlCenterDestination(
        "params" in api.route.current ? api.route.current.params : undefined,
        snapshot(),
      )}
    />,
  }])
  const unregisterPaletteKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.paletteLayer,
    commands: [{
      name: CONTROL_CENTER_COMMAND,
      title: "Self-evolve control center",
      category: "Self-evolve",
      namespace: "palette",
      run: () => openControlCenter({ section: "home" }),
    }],
  })
  const unregisterControlCenterKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.modeLayer,
    mode: CONTROL_CENTER_MODE,
    bindings: [{
      key: "escape",
      cmd: closeControlCenter,
      desc: "Close self-evolve control center",
    }],
  })
  api.lifecycle.onDispose(() => {
    if (surfaceOwnership.owns?.() && api.route.current.name === CONTROL_CENTER_ROUTE) {
      api.route.navigate(priorRoute.name, priorRoute.params)
    }
    if (surfaceOwnership.owns?.()) {
      unregisterRoute?.()
      if (typeof unregisterPaletteKeymap === "function") unregisterPaletteKeymap()
      if (typeof unregisterControlCenterKeymap === "function") unregisterControlCenterKeymap()
    }
    surfaceOwnership.release?.()
  })
  api.slots.register({
    order: 275,
    slots: {
      sidebar_content() {
        return <SidebarCard
          api={api}
          card={() => deriveSidebarCard(snapshot())}
          open={() => {
            const card = deriveSidebarCard(snapshot())
            openControlCenter(card.destination)
          }}
        />
      },
    },
  })
}

const SelfEvolveTuiModule: TuiPluginModule = {
  id: "mcrescenzo.self-evolve",
  tui,
}

export default SelfEvolveTuiModule
