/** @jsxImportSource @opentui/solid */

import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, Renderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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
const MAX_DESTINATION_SCROLL_FRAMES = 8
const activeApis = new WeakSet<object>()

type ProjectStore = ReturnType<typeof acquireProjectTuiStore>
type RequestResponse = ReturnType<ProjectStore["getSnapshot"]>["responses"][number]
type MaintenanceScope = "observations" | "proposals" | "project" | "all"
type YoloTarget = "global" | "project"
type FocusableRenderable = Renderable & {
  id: string
  focusable: boolean
  focused: boolean
  visible: boolean
  getChildren(): FocusableRenderable[]
  findDescendantById(id: string): FocusableRenderable | undefined
}
type BlurAwareRenderable = FocusableRenderable & {
  on(event: "blurred", listener: () => void): void
  off(event: "blurred", listener: () => void): void
}
type ScrollableRenderable = FocusableRenderable & {
  viewport?: Pick<FocusableRenderable, "screenY" | "height">
  scrollChildIntoView(id: string): void
}
type NavigationKeyEvent = KeyEvent & { shift: boolean, stopPropagation(): void }

function snapshotIdentity(snapshot: ReturnType<ProjectStore["getSnapshot"]>) {
  if (!snapshot?.key && !snapshot?.stateRootIdentity && !snapshot?.projectFingerprint) return null
  return JSON.stringify([
    snapshot.key ?? null,
    snapshot.stateRootIdentity ?? null,
    snapshot.projectFingerprint ?? null,
  ])
}

function isActivationKey(event: KeyEvent) {
  return event.name === "return" || event.name === "linefeed" || event.name === "space"
}

// OpenTUI executes accessor children reactively, but its supported 0.4/0.5
// declarations currently omit that runtime form from JSX.Element. Keep the
// type bridge limited to children; intrinsic element props still come directly
// from each installed peer and remain closed against arbitrary properties.
function reactiveChild<Value>(render: () => Value): Value {
  return render as unknown as Value
}

function relativeTime(timestamp: number, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

function requestResponseMessage(completedResponse: RequestResponse) {
  if (completedResponse.response?.ok === false) {
    return completedResponse.response.status === "expired"
      ? `${completedResponse.action?.replaceAll("-", " ") ?? "Request"} expired without a server response. Retry creates a new request ID after re-reading current server nonce authority.`
      : `Server rejected ${completedResponse.action?.replaceAll("-", " ") ?? "the request"}: ${completedResponse.response.reason}`
  }
  return completedResponse.action === "purge-all" && completedResponse.response?.status === "accepted-terminal"
    ? "Purge all accepted; Self-evolve authority stopped. Restart OpenCode to reinitialize durable state."
    : `${completedResponse.action?.replaceAll("-", " ") ?? "Request"} accepted by the server.`
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
        on:focused={() => setFocused(true)}
        on:blurred={() => setFocused(false)}
        onMouseDown={() => cardNode?.focus()}
        onMouseUp={props.open}
        onKeyDown={(event: KeyEvent) => {
          if (!isActivationKey(event)) return
          event.preventDefault()
          props.open()
        }}
      >
        <text fg={props.api.theme.current.text}><b>{focused() ? "› " : "  "}{props.card()?.title}</b></text>
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
  prior: () => { name: string; params?: Record<string, unknown> }
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
  const [consentIntent, setConsentIntent] = createSignal<string | null>(null)
  const [folderInput, setFolderInput] = createSignal("")
  const [folderError, setFolderError] = createSignal<string | null>(null)
  const [folderDraft, setFolderDraft] = createSignal<string[] | null>(null)
  const [folderConfirmation, setFolderConfirmation] = createSignal("")
  const [yoloTarget, setYoloTarget] = createSignal<YoloTarget | null>(null)
  const [yoloConfirmation, setYoloConfirmation] = createSignal("")
  const [maintenanceScope, setMaintenanceScope] = createSignal<MaintenanceScope>("observations")
  const [maintenanceIntent, setMaintenanceIntent] = createSignal<"export" | "delete" | null>(null)
  const [maintenanceConfirmation, setMaintenanceConfirmation] = createSignal("")
  const [focusedControl, setFocusedControl] = createSignal<string | null>(null)
  const [activityIndex, setActivityIndex] = createSignal(0)
  const recommendationNodes = new Map<number, Renderable>()
  const activityNodes = new Map<number, Renderable>()
  const terminalDimensions = useTerminalDimensions()
  const compactShell = () => terminalDimensions().width <= 64 || terminalDimensions().height <= 20
  const focusId = (key: string) => `self-evolve-focus-${key.replaceAll(/[^A-Za-z0-9_.-]/gu, "-")}`
  const focusMark = (key: string) => focusedControl() === key ? "› " : "  "
  const focusHandlers = (key: string) => ({
    focused: () => setFocusedControl(key),
    blurred: () => setFocusedControl((current) => current === key ? null : current),
  })
  let controlCenterNode: FocusableRenderable | undefined
  let contentScrollbox: ScrollableRenderable | undefined
  let cancelDestinationFocus = () => {}
  let refreshDestinationFocus = () => {}
  const focusableDescendants = () => {
    const result: FocusableRenderable[] = []
    const visit = (node: FocusableRenderable) => {
      for (const child of node.getChildren()) {
        if (child.focusable && child.visible) result.push(child)
        visit(child)
      }
    }
    if (controlCenterNode) visit(controlCenterNode)
    return result
  }
  useKeyboard((event) => {
    if (event.name !== "tab") return
    const navigationEvent = event as NavigationKeyEvent
    const nodes = focusableDescendants()
    if (!nodes.length) return
    navigationEvent.preventDefault()
    navigationEvent.stopPropagation()
    const current = nodes.findIndex((node) => node.focused)
    const offset = navigationEvent.shift ? -1 : 1
    const next = current < 0
      ? (navigationEvent.shift ? nodes.length - 1 : 0)
      : (current + offset + nodes.length) % nodes.length
    nodes[next].focus()
  })
  const model = createMemo(() => buildControlCenterModel(props.snapshot(), {
    selectedIndex: selectedIndex(),
    recommendationFilter: recommendationFilter(),
    activityFilter: activityFilter(),
  }))
  let popMode = () => {}
  let unsubscribeIdentity = () => {}
  let mountedIdentity = snapshotIdentity(props.snapshot())
  let mountedPhase = props.snapshot().phase
  const clearPreparedAuthority = () => {
    setRejectionReason(null)
    setRejectionText("")
    setFeedback(null)
    setConfirmation(null)
    setConsentIntent(null)
    setFolderInput("")
    setFolderError(null)
    setFolderDraft(null)
    setFolderConfirmation("")
    setYoloTarget(null)
    setYoloConfirmation("")
    setMaintenanceIntent(null)
    setMaintenanceConfirmation("")
  }
  const resetForProjectIdentity = () => {
    setSection("home")
    setSelectedIndex(0)
    setRecommendationFilter("needs-review")
    setActivityFilter("all")
    setSettingsAnchor(undefined)
    setTechnicalExpanded(false)
    setActivityExpanded(null)
    setDiagnosticsExpanded(false)
    setMaintenanceScope("observations")
    clearPreparedAuthority()
    void props.store.selectDetails([])
  }
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE)
    selectRecommendation(selectedIndex())
    unsubscribeIdentity = props.store.subscribe((next) => {
      const nextIdentity = snapshotIdentity(next)
      if (mountedIdentity !== nextIdentity) {
        resetForProjectIdentity()
      } else if (mountedPhase !== "error" && next.phase === "error") {
        clearPreparedAuthority()
      }
      mountedIdentity = nextIdentity
      mountedPhase = next.phase
    })
  })
  onCleanup(() => {
    cancelDestinationFocus()
    unsubscribeIdentity()
    popMode()
  })
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
    scheduleDestinationFocus(next)
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
    const next = queue[(current + offset + queue.length) % queue.length].sourceIndex
    selectRecommendation(next)
    recommendationNodes.get(next)?.focus()
  }
  const moveActivity = (offset: number) => {
    const entries = activity().activity
    if (!entries.length) return
    const next = (activityIndex() + offset + entries.length) % entries.length
    setActivityIndex(next)
    activityNodes.get(next)?.focus()
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
  const requestPending = (action: string, subject: string) => props.snapshot().pending.some((entry) =>
    entry.action === action && entry.subject === subject)
  const actionButton = (
    key: string,
    label: string,
    operation: () => Promise<unknown> | unknown,
    requiresConfirmation = false,
    pendingRequest?: { action: string, subject: string },
  ) => {
    const disabled = () => pendingRequest ? requestPending(pendingRequest.action, pendingRequest.subject) : false
    const focus = focusHandlers(`action:${key}`)
    return (
    <box
      id={focusId(`action:${key}`)}
      focusable={!disabled()}
      border
      paddingLeft={1}
      paddingRight={1}
      borderColor={confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
      on:focused={focus.focused}
      on:blurred={focus.blurred}
      onMouseUp={() => { if (!disabled()) void invoke(key, operation, requiresConfirmation) }}
      onKeyDown={(event: KeyEvent) => {
        if (!isActivationKey(event) || disabled()) return
        event.preventDefault()
        void invoke(key, operation, requiresConfirmation)
      }}
    >
      <text fg={disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
        {focusMark(`action:${key}`)}{disabled() ? `${label} · Pending` : confirmation() === key ? `Confirm ${label}` : label}
      </text>
    </box>
    )
  }
  const localActionButton = (
    label: string,
    operation: () => void,
    warning = false,
    confirmationKey?: string,
    pendingRequest?: { action: string, subject: string },
    focusKey?: string,
  ) => {
    const disabled = () => pendingRequest ? requestPending(pendingRequest.action, pendingRequest.subject) : false
    const key = `local:${focusKey ?? confirmationKey ?? label}`
    const focus = focusHandlers(key)
    return (
    <box
      id={focusId(key)}
      focusable={!disabled()}
      border
      paddingLeft={1}
      paddingRight={1}
      borderColor={warning || confirmation() === confirmationKey ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
      on:focused={focus.focused}
      on:blurred={focus.blurred}
      onMouseUp={() => { if (!disabled()) operation() }}
      onKeyDown={(event: KeyEvent) => {
        if (!isActivationKey(event) || disabled()) return
        event.preventDefault()
        operation()
      }}
    >
      <text fg={disabled() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
        {focusMark(key)}{disabled() ? `${label} · Pending` : confirmation() === confirmationKey ? `Confirm ${label}` : label}
      </text>
    </box>
    )
  }
  const paused = () => props.snapshot().dashboard?.settings?.paused === true
  const emergencyStop = () => props.snapshot().dashboard?.settings?.killSwitchActive === true
  const home = () => model().sections.home
  const recommendations = () => model().sections.recommendations
  const activity = () => model().sections.activity
  const settings = () => model().sections.settings
  const settingsAnchorControl = (anchor: string) => {
    if (anchor === "modes" || anchor === "setup") {
      // Modes is a multi-control group. Focus its exact group anchor so the
      // effective/global/project summary stays in view instead of implying
      // that the current global-mode button is the only destination.
      return `anchor:${anchor}`
    }
    if (anchor === "emergency-stop") {
      return `action:${emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop"}`
    }
    if (anchor === "project-scope") {
      return `action:${settings().projectExcluded ? "include-project" : "exclude-project"}`
    }
    const consentKey = anchor === "passive-consent"
      ? "passiveCalls"
      : anchor === "observation-consent"
        ? "durableObservations"
        : null
    if (consentKey) {
      const consent = settings().consent.find((entry) => entry.key === consentKey)
      return consent?.enabled ? `action:consent-${consentKey}-off` : `local:consent:${consentKey}`
    }
    if (anchor === "approved-skill-folders") return "local:Add folder"
    if (anchor === "maintenance") return "local:Export selected scope"
    return `anchor:${anchor}`
  }
  const scheduleDestinationFocus = (next: {
    section: (typeof names)[number]
    selectedIndex?: number
    filter?: string
    anchor?: string
  }) => {
    cancelDestinationFocus()
    const destinationCurrent = () => (
      props.api.route.current.name === CONTROL_CENTER_ROUTE && section() === next.section
    )
    let targetId = focusId(`section:${next.section}`)
    if (next.section === "activity" && typeof next.filter === "string") {
      targetId = focusId(`activity-filter:${next.filter}`)
    } else if (next.section === "settings" && next.anchor) {
      targetId = focusId(settingsAnchorControl(next.anchor))
    } else if (next.section === "home" && home().firstRun) {
      targetId = focusId("action:automatic-recommendations")
    }
    const liveFocusable = (candidate: FocusableRenderable | undefined) => Boolean(
      candidate
      && candidate.visible
      && candidate.focusable
      && controlCenterNode?.findDescendantById(candidate.id) === candidate
    ) ? candidate : undefined
    const destinationTarget = () => {
      if (!destinationCurrent()) return undefined
      if (next.section === "recommendations" && Number.isSafeInteger(next.selectedIndex)) {
        return liveFocusable(recommendationNodes.get(next.selectedIndex!) as FocusableRenderable | undefined)
      }
      return liveFocusable(controlCenterNode?.findDescendantById(targetId))
    }
    const fallbackTarget = () => {
      if (!destinationCurrent()) return undefined
      return liveFocusable(controlCenterNode?.findDescendantById(focusId(`anchor:${next.anchor ?? "setup"}`)))
        ?? liveFocusable(controlCenterNode?.findDescendantById(focusId(`section:${next.section}`)))
    }
    let active = true
    let watchedTarget: BlurAwareRenderable | undefined
    let mountGeneration = 0
    let scrollGeneration = 0
    const stop = () => {
      if (!active) return
      active = false
      mountGeneration += 1
      scrollGeneration += 1
      watchedTarget?.off("blurred", handleTargetBlurred)
      if (cancelDestinationFocus === stop) {
        cancelDestinationFocus = () => {}
        refreshDestinationFocus = () => {}
      }
    }
    const targetInView = (target: FocusableRenderable) => Boolean(
      contentScrollbox && (() => {
        const viewport = contentScrollbox.viewport ?? contentScrollbox
        const viewportBottom = viewport.screenY + viewport.height
        if (target.height > viewport.height) {
          // A target taller than the viewport is settled when its top is visible.
          return target.screenY >= viewport.screenY && target.screenY < viewportBottom
        }
        return target.screenY >= viewport.screenY
          && target.screenY + target.height <= viewportBottom
      })()
    )
    const settleTargetScroll = (target: BlurAwareRenderable, generation: number, attempt = 0) => {
      requestAnimationFrame(() => {
        if (!active
          || generation !== scrollGeneration
          || watchedTarget !== target
          || destinationTarget() !== target
          || attempt >= MAX_DESTINATION_SCROLL_FRAMES) return
        if (contentScrollbox?.findDescendantById(target.id)) {
          contentScrollbox.scrollChildIntoView(target.id)
        }
        requestAnimationFrame(() => {
          if (active
            && generation === scrollGeneration
            && watchedTarget === target
            && destinationTarget() === target
            && !targetInView(target)) {
            settleTargetScroll(target, generation, attempt + 1)
          }
        })
      })
    }
    const watchAndFocus = (target: BlurAwareRenderable) => {
      if (watchedTarget !== target) {
        watchedTarget?.off("blurred", handleTargetBlurred)
        watchedTarget = target
        watchedTarget.on("blurred", handleTargetBlurred)
      }
      target.focus()
    }
    const focusExactTarget = (target: BlurAwareRenderable) => {
      watchAndFocus(target)
      if (contentScrollbox?.findDescendantById(target.id)) {
        contentScrollbox.scrollChildIntoView(target.id)
      }
      settleTargetScroll(target, ++scrollGeneration)
    }
    const focusDestination = () => {
      if (!active || !destinationCurrent()) {
        stop()
        return
      }
      const target = destinationTarget() as BlurAwareRenderable | undefined
      if (target) {
        focusExactTarget(target)
        return
      }
      const fallback = fallbackTarget() as BlurAwareRenderable | undefined
      if (fallback) {
        watchAndFocus(fallback)
        if (contentScrollbox?.findDescendantById(fallback.id)) {
          contentScrollbox.scrollChildIntoView(fallback.id)
        }
      }
    }
    const handleTargetBlurred = () => {
      if (!destinationCurrent()) {
        stop()
        return
      }
      const current = watchedTarget?.ctx.currentFocusedRenderable
      if (current == null || current === controlCenterNode || current.id === watchedTarget?.id) {
        // The host clears focus or focuses the route root after mounting.
        // Reclaim mount transitions and same-ID renderable replacement;
        // explicit scrolling and different-child focus cancel.
        focusDestination()
        return
      }
      stop()
    }
    const refresh = () => {
      focusDestination()
      const generation = ++mountGeneration
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (active && generation === mountGeneration) focusDestination()
      }))
    }
    refreshDestinationFocus = refresh
    cancelDestinationFocus = stop
    refresh()
  }
  onMount(() => scheduleDestinationFocus(props.initial))
  createEffect(() => {
    props.snapshot()
    refreshDestinationFocus()
  })
  const retryProjection = async () => {
    const refreshed = await props.store.refresh()
    setFeedback(refreshed.phase === "error"
      ? "Retry did not restore a fresh projection. Read-only stale context remains available."
      : "Projection refreshed. Only newly negotiated actions are available.")
  }
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
  const enableAutomaticRecommendations = () => props.store.submitControl("set-mode", { mode: "auto" })
  const openConsentDisclosure = (key: string) => {
    setConsentIntent(key)
    setFeedback("Review the privacy disclosure, then confirm or cancel the consent change.")
  }
  const confirmConsent = async (key: string) => {
    await props.store.submitControl("set-consent", { key, enabled: true })
    await delay(0)
    setConsentIntent(null)
  }
  const consentDisclosure = (key: string) => (
    <Show when={consentIntent() === key && settings().consent.find((entry) => entry.key === key)}>
      {(entry) => (
        <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
          <text><b>Consent disclosure</b></text>
          <text wrapMode="word">{entry().description}</text>
          <text fg={props.api.theme.current.textMuted} wrapMode="word">{entry().dependency}</text>
          <box flexDirection="row" flexWrap="wrap" gap={1}>
            {actionButton(
              `confirm-consent-${key}`,
              `Confirm allow ${entry().label}`,
              () => confirmConsent(key),
              false,
              { action: "set-consent", subject: `consent:${key}` },
            )}
            {localActionButton("Cancel consent change", () => setConsentIntent(null), false, undefined, undefined, `cancel-consent:${key}`)}
          </box>
        </box>
      )}
    </Show>
  )
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
  const pendingRecommendation = () => props.snapshot().pending.some((entry) => entry.subject === selectedProposalId())
  const activateRecommendation = async (action: string, snoozeMs?: number) => {
    const proposalId = selectedProposalId()
    if (!proposalId || requestPending(action, proposalId)) return
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
      ref={(value: Renderable) => (controlCenterNode = value as FocusableRenderable)}
      focusable
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={compactShell() ? 1 : 2}
      paddingRight={compactShell() ? 1 : 2}
    >
      <box
        flexDirection="row"
        gap={1}
        flexWrap="wrap"
        flexShrink={0}
        height={compactShell() ? 3 : "auto"}
        overflow="hidden"
      >
        <box flexDirection="column" flexGrow={1}>
          <text fg={props.api.theme.current.text}><b>Self-evolve</b></text>
          <text fg={props.api.theme.current.textMuted} wrapMode="word">
            {model().operational.label} · {home().mode.effective.label}
          </text>
        </box>
        <Show when={settings().controls.pause}>
          {actionButton(
            paused() ? "resume" : "pause",
            paused() ? "Resume" : "Pause",
            () => props.store.submitOperation("set-paused", { paused: !paused() }),
            false,
            { action: "set-paused", subject: "project" },
          )}
        </Show>
        <Show when={settings().controls.emergencyStop}>
          {actionButton(
            emergencyStop() ? "disable-emergency-stop" : "enable-emergency-stop",
            emergencyStop() ? "Turn off Emergency stop" : "Emergency stop",
            () => props.store.submitOperation("set-kill-switch", { enabled: !emergencyStop() }),
            emergencyStop(),
            { action: "set-kill-switch", subject: "project" },
          )}
        </Show>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap" flexShrink={0} height={3} overflow="hidden">
        {names.map((name) => (
          <box
            id={focusId(`section:${name}`)}
            focusable
            border
            paddingLeft={1}
            paddingRight={1}
            borderColor={section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
            on:focused={() => setFocusedControl(`section:${name}`)}
            on:blurred={() => setFocusedControl((current) => current === `section:${name}` ? null : current)}
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
              {focusMark(`section:${name}`)}{name.charAt(0).toUpperCase() + name.slice(1)}
              {name === "recommendations" && model().operational.count > 0 ? ` (${model().operational.count})` : ""}
            </text>
          </box>
        ))}
      </box>
      <scrollbox
        ref={(value: Renderable) => (contentScrollbox = value as ScrollableRenderable)}
        flexGrow={1}
        minHeight={1}
        width="100%"
        onMouseScroll={() => cancelDestinationFocus()}
      >
        <Show when={model().recovery}>
          {(recovery) => (
            <box border borderColor={props.api.theme.current.error} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
              <text><b>{recovery().stale ? "Read-only stale snapshot" : "Projection unavailable"}</b></text>
              <text wrapMode="word">Latest refresh failed: {recovery().diagnostic}</text>
              <text fg={props.api.theme.current.textMuted} wrapMode="word">
                Decision, control, and operation actions are unavailable until a fresh projection is negotiated.
              </text>
              <Show when={recovery().canRetry}>
                {localActionButton("Retry", () => void retryProjection())}
              </Show>
            </box>
          )}
        </Show>
        <Show when={section() === "home"}>
          <box flexDirection="column" gap={1}>
            <text><b>Home</b></text>
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
                <text wrapMode="word">Choose proactive review without granting automatic writes or privacy consent. Background AI analysis and saved structured patterns remain separate consent gates in Settings.</text>
                <Show when={settings().controls.globalMode}>
                  {actionButton(
                    "automatic-recommendations",
                    "Turn on automatic recommendations",
                    enableAutomaticRecommendations,
                    true,
                    { action: "set-mode", subject: "global-mode" },
                  )}
                </Show>
                <Show when={!settings().controls.globalMode}>
                  <text fg={props.api.theme.current.textMuted}>Controls are unavailable until the aligned server publishes fresh authority.</text>
                </Show>
                <text><b>Optional evidence excerpts</b></text>
                <text wrapMode="word">Sanitized excerpts can make evidence richer, but redaction is not a secrecy guarantee. This choice is independent of automatic recommendations.</text>
                <Show when={settings().controls.consent}>
                  {localActionButton(
                    "Review consent for Sanitized evidence excerpts",
                    () => openConsentDisclosure("sanitizedExcerpts"),
                  )}
                </Show>
                <Show when={!settings().controls.consent}>
                  <text fg={props.api.theme.current.textMuted}>Excerpt consent can be changed later in Settings.</text>
                </Show>
                {consentDisclosure("sanitizedExcerpts")}
              </box>
            </Show>
            <Show when={home().blockers.length}>
              <box flexDirection="column">
                <text><b>Setup</b></text>
                {reactiveChild(() => home().blockers.map((blocker) => (
                  <box
                    focusable
                    border
                    borderColor={props.api.theme.current.warning}
                    paddingLeft={1}
                    paddingRight={1}
                    on:focused={() => setFocusedControl(`blocker:${blocker.code}`)}
                    on:blurred={() => setFocusedControl((current) => current === `blocker:${blocker.code}` ? null : current)}
                    onMouseUp={() => navigate(blocker.destination)}
                    onKeyDown={(event: KeyEvent) => {
                      if (!isActivationKey(event)) return
                      event.preventDefault()
                      navigate(blocker.destination)
                    }}
                  >
                    <text wrapMode="word">
                      {focusMark(`blocker:${blocker.code}`)}{blocker.summary} · Open {blocker.destination.section === "activity"
                        ? "Activity errors"
                        : blocker.destination.section.charAt(0).toUpperCase() + blocker.destination.section.slice(1)}
                    </text>
                  </box>
                )))}
              </box>
            </Show>
            <Show when={home().lastCycle}>
              {(lastCycle) => (
                <box flexDirection="column">
                  <text><b>Last cycle</b></text>
                  <text wrapMode="word">{lastCycle().outcome.replaceAll("-", " ")} · {lastCycle().observationCount} observations · {lastCycle().eligibilityCount} eligible</text>
                </box>
              )}
            </Show>
            <Show when={home().attention}>
              {(attention) => (
                <box
                  id={focusId("home:attention")}
                  focusable
                  border
                  borderColor={props.api.theme.current.warning}
                  paddingLeft={1}
                  paddingRight={1}
                  on:focused={() => setFocusedControl("home:attention")}
                  on:blurred={() => setFocusedControl((current) => current === "home:attention" ? null : current)}
                  onMouseUp={() => navigate(attention().destination)}
                  onKeyDown={(event: KeyEvent) => {
                    if (!isActivationKey(event)) return
                    event.preventDefault()
                    navigate(attention().destination)
                  }}
                >
                  <text>{focusMark("home:attention")}{attention().count} {attention().kind === "applied" ? "applied change" : "recommendation"} needs attention</text>
                </box>
              )}
            </Show>
            <Show when={home().usage}>
              {(usage) => (
                <box flexDirection="column">
                  <text><b>Actual usage</b></text>
                  <text>Background analysis: {usage().passive.used} / {usage().passive.limit}</text>
                  <text>Recommendation synthesis: {usage().synthesis.used} / {usage().synthesis.limit}</text>
                  <text>Storage: {usage().storage.usedBytes} / {usage().storage.limitBytes} bytes</text>
                </box>
              )}
            </Show>
            <Show when={home().recentActivity.length}>
              <box flexDirection="column">
                <text><b>Recent activity</b></text>
                {reactiveChild(() => home().recentActivity.map((entry) => <text wrapMode="word">[{entry.marker}] {entry.summary}</text>))}
              </box>
            </Show>
            <Show when={home().emptyState}>
              {(emptyState) => (
                <box flexDirection="column">
                  <text><b>{emptyState().heading}</b></text>
                  <text wrapMode="word">{emptyState().explanation}</text>
                </box>
              )}
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
                  id={focusId(`recommendation-filter:${value}`)}
                  focusable
                  border
                  borderColor={recommendationFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  on:focused={() => setFocusedControl(`recommendation-filter:${value}`)}
                  on:blurred={() => setFocusedControl((current) => current === `recommendation-filter:${value}` ? null : current)}
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
                  <text>{focusMark(`recommendation-filter:${value}`)}{label}</text>
                </box>
              ))}
            </box>
            <Show when={recommendations().emptyState}><text>{recommendations().emptyState}</text></Show>
            {reactiveChild(() => recommendations().queue.map((item, index) => (
              <box
                id={focusId(`recommendation-row:${item.sourceIndex}`)}
                ref={(value: Renderable) => recommendationNodes.set(item.sourceIndex, value)}
                focusable
                border
                borderColor={recommendations().selectedIndex === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                paddingLeft={1}
                paddingRight={1}
                flexDirection="column"
                on:focused={() => {
                  setFocusedControl(`recommendation-row:${item.sourceIndex}`)
                  selectRecommendation(item.sourceIndex)
                }}
                on:blurred={() => setFocusedControl((current) => current === `recommendation-row:${item.sourceIndex}` ? null : current)}
                onMouseUp={() => {
                  selectRecommendation(item.sourceIndex)
                  recommendationNodes.get(item.sourceIndex)?.focus()
                }}
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
                  {focusMark(`recommendation-row:${item.sourceIndex}`)}
                  {item.attention === "critical" ? "[Urgent] " : item.attention === "warning" ? "[Attention] " : ""}
                  {item.target} · {item.state.replaceAll("-", " ")} · {relativeTime(item.updatedAt)}
                </text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{item.rationale}</text>
                <text fg={props.api.theme.current.textMuted}>
                  Risk: {item.risk ?? "Loading"} · Evidence: {item.evidenceCount ?? "Loading"}
                </text>
              </box>
            )))}
            <Show when={recommendations().selected}>
              {(selected) => (
                <box border borderColor={props.api.theme.current.borderActive} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
                <text><b>{selected().target}</b></text>
                <Show when={selected().loading}>
                  <text>Loading authoritative recommendation detail…</text>
                </Show>
                <Show when={selected().summary}>
                  {(summary) => (
                    <>
                      <box flexDirection="column">
                        <text><b>Why this was suggested</b></text>
                        <text wrapMode="word">{summary().rationale}</text>
                      </box>
                      <box flexDirection="column">
                        <text><b>Proposed change</b></text>
                        {reactiveChild(() => selected().diff?.lines.map((line) => <text wrapMode="word">{line}</text>) ?? [])}
                        <Show when={selected().diff?.overflow?.truncated}>
                          <text fg={props.api.theme.current.warning}>The proposed change was truncated by the bounded projection.</text>
                        </Show>
                      </box>
                      <box flexDirection="column">
                        <text><b>Evidence</b></text>
                        {reactiveChild(() => selected().evidence.map((entry) =>
                          <text wrapMode="word">{entry.kind}: {entry.summary}{entry.redacted ? " [redacted]" : ""}</text>))}
                        <Show when={!selected().evidence.length}><text>No bounded evidence detail is loaded.</text></Show>
                      </box>
                      <box flexDirection="column">
                        <text><b>Safety checks</b></text>
                        <text>Critic: {summary().criticPassed ? "Passed" : "Not passed"}</text>
                        <text>Deterministic checks: {summary().validDeterministic ? "Passed" : "Not passed"}</text>
                        <text>Injection scan: {summary().injectionFlagged ? "Flagged" : "Clear"}</text>
                        {reactiveChild(() => summary().eligibility.checks.map((check) =>
                          <text wrapMode="word">[{check.met ? "Passed" : "Blocked"}] {check.name}: {check.actual} / {check.required}</text>))}
                      </box>
                      <box flexDirection="column">
                        <text><b>Token impact</b></text>
                        <text>{summary().tokenImpact.estimatedTokens} estimated / {summary().tokenImpact.budgetTokens} budgeted tokens</text>
                      </box>
                      <box flexDirection="column">
                        <text><b>Rollback</b></text>
                        <text>{summary().rollback.eligible ? "Undo is currently eligible." : `Unavailable: ${summary().rollback.reason ?? "not offered"}`}</text>
                      </box>
                      <box
                        focusable
                        border
                        borderColor={technicalExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                        paddingLeft={1}
                        paddingRight={1}
                        on:focused={() => setFocusedControl("recommendation:technical")}
                        on:blurred={() => setFocusedControl((current) => current === "recommendation:technical" ? null : current)}
                        onMouseUp={() => setTechnicalExpanded((value) => !value)}
                        onKeyDown={(event: KeyEvent) => {
                          if (!isActivationKey(event)) return
                          event.preventDefault()
                          setTechnicalExpanded((value) => !value)
                        }}
                      >
                        <text>{focusMark("recommendation:technical")}Technical details {technicalExpanded() ? "▲" : "▼"}</text>
                      </box>
                      <Show when={technicalExpanded()}>
                        <text>State: {summary().state}</text>
                        <text>Effective mode: {summary().effectiveMode}</text>
                        <text>Operation: {summary().operation.status}</text>
                        {reactiveChild(() => selected().audit.map((entry) =>
                          <text wrapMode="word">{entry.kind}: {entry.summary}</text>))}
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={selected().actions.some((action) =>
                  action.action === "reject-proposal" && action.feedbackSupported)}>
                  <box flexDirection="column">
                    <text fg={props.api.theme.current.textMuted}>Optional rejection feedback (audit-only)</text>
                    <box flexDirection="row" gap={1} flexWrap="wrap">
                      {reactiveChild(() => recommendations().rejectionFeedbackOptions.map((option) => (
                        <box
                          focusable
                          border
                          borderColor={rejectionReason() === option.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                          paddingLeft={1}
                          paddingRight={1}
                          on:focused={() => setFocusedControl(`rejection:${option.value}`)}
                          on:blurred={() => setFocusedControl((current) => current === `rejection:${option.value}` ? null : current)}
                          onMouseUp={() => setRejectionReason(rejectionReason() === option.value ? null : option.value)}
                          onKeyDown={(event: KeyEvent) => {
                            if (!isActivationKey(event)) return
                            event.preventDefault()
                            setRejectionReason(rejectionReason() === option.value ? null : option.value)
                          }}
                        >
                          <text>{focusMark(`rejection:${option.value}`)}{option.label}</text>
                        </box>
                      )))}
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
                  {reactiveChild(() => selected().actions.flatMap((action) => {
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
                          focusable={!action.pending}
                          border
                          borderColor={confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
                          paddingLeft={1}
                          paddingRight={1}
                          on:focused={() => setFocusedControl(`recommendation-action:${key}`)}
                          on:blurred={() => setFocusedControl((current) => current === `recommendation-action:${key}` ? null : current)}
                          onMouseUp={() => { if (!action.pending) void activateRecommendation(action.action, choice.delay) }}
                          onKeyDown={(event: KeyEvent) => {
                            if (!isActivationKey(event) || action.pending) return
                            event.preventDefault()
                            void activateRecommendation(action.action, choice.delay)
                          }}
                        >
                          <text fg={action.pending ? props.api.theme.current.textMuted : props.api.theme.current.text}>
                            {focusMark(`recommendation-action:${key}`)}{action.pending ? `${choice.label} · Pending` : confirmation() === key ? `Confirm ${choice.label}` : choice.label}
                          </text>
                        </box>
                      )
                    })
                  }))}
                  <box
                    focusable
                    border
                    borderColor={props.api.theme.current.borderSubtle}
                    paddingLeft={1}
                    paddingRight={1}
                    on:focused={() => setFocusedControl("recommendation:open-activity")}
                    on:blurred={() => setFocusedControl((current) => current === "recommendation:open-activity" ? null : current)}
                    onMouseUp={() => void activateRecommendation("open-activity")}
                    onKeyDown={(event: KeyEvent) => {
                      if (!isActivationKey(event)) return
                      event.preventDefault()
                      void activateRecommendation("open-activity")
                    }}
                  >
                    <text>{focusMark("recommendation:open-activity")}Open in Activity</text>
                  </box>
                </box>
                <Show when={pendingRecommendation()}>
                  <text fg={props.api.theme.current.info}>Request pending server validation…</text>
                </Show>
                </box>
              )}
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
                  id={focusId(`activity-filter:${value}`)}
                  focusable
                  border
                  borderColor={activityFilter() === value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  on:focused={() => setFocusedControl(`activity-filter:${value}`)}
                  on:blurred={() => setFocusedControl((current) => current === `activity-filter:${value}` ? null : current)}
                  onMouseUp={() => {
                    setActivityFilter(value)
                    setActivityExpanded(null)
                    setActivityIndex(0)
                  }}
                  onKeyDown={(event: KeyEvent) => {
                    if (!isActivationKey(event)) return
                    event.preventDefault()
                    setActivityFilter(value)
                    setActivityExpanded(null)
                    setActivityIndex(0)
                  }}
                >
                  <text>{focusMark(`activity-filter:${value}`)}{label}</text>
                </box>
              ))}
            </box>
            <Show when={activity().emptyState}><text wrapMode="word">{activity().emptyState}</text></Show>
            {reactiveChild(() => activity().activity.map((entry, index) => (
              <box
                id={focusId(`activity-row:${index}`)}
                ref={(value: Renderable) => activityNodes.set(index, value)}
                focusable
                border
                borderColor={activityExpanded() === index ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                paddingLeft={1}
                paddingRight={1}
                flexDirection="column"
                on:focused={() => {
                  setFocusedControl(`activity-row:${index}`)
                  setActivityIndex(index)
                }}
                on:blurred={() => setFocusedControl((current) => current === `activity-row:${index}` ? null : current)}
                onMouseUp={() => {
                  setActivityIndex(index)
                  activityNodes.get(index)?.focus()
                  setActivityExpanded(activityExpanded() === index ? null : index)
                }}
                onKeyDown={(event: KeyEvent) => {
                  if (isActivationKey(event)) {
                    event.preventDefault()
                    setActivityExpanded(activityExpanded() === index ? null : index)
                  } else if (event.name === "right" && entry.destination?.section === "recommendations") {
                    event.preventDefault()
                    openActivityDestination(entry)
                  } else if (event.name === "up") {
                    event.preventDefault()
                    moveActivity(-1)
                  } else if (event.name === "down") {
                    event.preventDefault()
                    moveActivity(1)
                  }
                }}
              >
                <text wrapMode="word">
                  {focusMark(`activity-row:${index}`)}[{entry.marker}] {entry.summary} · {relativeTime(entry.occurredAt)}
                </text>
                <Show when={entry.target}><text fg={props.api.theme.current.textMuted}>Skill: {entry.target}</text></Show>
                <Show when={activityExpanded() === index}>
                  <text fg={props.api.theme.current.textMuted}>Category: {entry.technical.category}</text>
                  <text fg={props.api.theme.current.textMuted}>Outcome: {entry.technical.outcome.replaceAll("-", " ")}</text>
                  <Show when={entry.technical.reason}>
                    {(reason) => <text fg={props.api.theme.current.textMuted}>Reason: {reason().replaceAll("-", " ")}</text>}
                  </Show>
                  <Show when={entry.destination?.section === "recommendations"}>
                    <box
                      focusable
                      border
                      borderColor={props.api.theme.current.borderSubtle}
                      paddingLeft={1}
                      paddingRight={1}
                      on:focused={() => setFocusedControl(`activity-open:${index}`)}
                      on:blurred={() => setFocusedControl((current) => current === `activity-open:${index}` ? null : current)}
                      onMouseUp={() => openActivityDestination(entry)}
                      onKeyDown={(event: KeyEvent) => {
                        if (!isActivationKey(event)) return
                        event.preventDefault()
                        openActivityDestination(entry)
                      }}
                    >
                      <text>{focusMark(`activity-open:${index}`)}Open recommendation</text>
                    </box>
                  </Show>
                </Show>
              </box>
            )))}
            <Show when={activity().overflowMessage}>
              <text fg={props.api.theme.current.warning} wrapMode="word">{activity().overflowMessage}</text>
            </Show>
            <box
              focusable
              border
              borderColor={diagnosticsExpanded() ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
              paddingLeft={1}
              paddingRight={1}
              on:focused={() => setFocusedControl("activity:diagnostics")}
              on:blurred={() => setFocusedControl((current) => current === "activity:diagnostics" ? null : current)}
              onMouseUp={() => setDiagnosticsExpanded((value) => !value)}
              onKeyDown={(event: KeyEvent) => {
                if (!isActivationKey(event)) return
                event.preventDefault()
                setDiagnosticsExpanded((value) => !value)
              }}
            >
              <text>{focusMark("activity:diagnostics")}Diagnostics {diagnosticsExpanded() ? "▲" : "▼"}</text>
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
                  {(automation) => <text wrapMode="word">Scheduler: {automation().state.replaceAll("-", " ")}</text>}
                </Show>
                <Show when={activity().diagnostics.backoffUntil}>
                  {(backoffUntil) => <text wrapMode="word">Backoff ends: {new Date(backoffUntil()).toISOString()}</text>}
                </Show>
                <Show when={activity().diagnostics.nextEligibleAt}>
                  {(nextEligibleAt) => <text wrapMode="word">Next eligible: {new Date(nextEligibleAt()).toISOString()}</text>}
                </Show>
                <Show when={activity().diagnostics.usage}>
                  {(usage) => (
                    <>
                      <text wrapMode="word">Background analysis used/remaining: {usage().passive.used} / {usage().passive.remaining}</text>
                      <text wrapMode="word">Recommendation synthesis used/remaining: {usage().synthesis.used} / {usage().synthesis.remaining}</text>
                      <text wrapMode="word">Storage used/quota: {usage().storage.usedBytes} / {usage().storage.limitBytes} bytes</text>
                      <Show when={activity().diagnostics.budgetResetAt}>
                        {(budgetResetAt) => (
                          <>
                            <text wrapMode="word">Background analysis resets: {new Date(budgetResetAt().passive).toISOString()}</text>
                            <text wrapMode="word">Recommendation synthesis resets: {new Date(budgetResetAt().synthesis).toISOString()}</text>
                          </>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
                <Show when={activity().diagnostics.lastError}>
                  {(lastError) => <text wrapMode="word">Last bounded error: {lastError().summary}</text>}
                </Show>
              </box>
            </Show>
          </box>
        </Show>
        <Show when={section() === "settings"}>
          <box flexDirection="column" gap={1}>
            <text><b>Settings</b></text>
            <Show when={settingsAnchor()}>
              {(anchor) => (
                <box
                  id={focusId(`anchor:${anchor()}`)}
                  focusable
                  border
                  borderColor={focusedControl() === `anchor:${anchor()}` ? props.api.theme.current.borderActive : props.api.theme.current.info}
                  paddingLeft={1}
                  paddingRight={1}
                  on:focused={() => setFocusedControl(`anchor:${anchor()}`)}
                  on:blurred={() => setFocusedControl((current) => current === `anchor:${anchor()}` ? null : current)}
                >
                  <text fg={props.api.theme.current.info} wrapMode="word">
                    {focusMark(`anchor:${anchor()}`)}Opened at {anchor().replaceAll("-", " ")} settings.
                  </text>
                </box>
              )}
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
            <Show when={settings().controls.globalMode && modeRank(settings().mode.global.value) < modeRank("auto")}>
              <box border borderColor={props.api.theme.current.info} paddingLeft={1} paddingRight={1} flexDirection="column" gap={1}>
                <text><b>Automatic recommendations setup</b></text>
                <text wrapMode="word">
                  This confirmation changes only the global mode. Background AI analysis, saved structured patterns, and sanitized excerpts remain separate consent choices below.
                </text>
                {actionButton(
                  "automatic-recommendations",
                  "Turn on automatic recommendations",
                  enableAutomaticRecommendations,
                  true,
                  { action: "set-mode", subject: "global-mode" },
                )}
              </box>
            </Show>
            {reactiveChild(() => settings().modes.map((mode) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{mode.label}</b>{settings().mode.effective.value === mode.value ? " · Effective now" : ""}</text>
                <text wrapMode="word">{mode.description}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Provider use: {mode.providerUse}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Saved data: {mode.savedData}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Write authority: {mode.writeAuthority}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">Prerequisites: {mode.prerequisites}</text>
                <Show when={mode.blockers.length}>
                  {reactiveChild(() => mode.blockers.map((blocker) => <text fg={props.api.theme.current.warning} wrapMode="word">• {blocker}</text>))}
                </Show>
                <Show when={mode.available}>
                  <box flexDirection="row" flexWrap="wrap" gap={1}>
                    <Show when={settings().controls.globalMode}>
                      {localActionButton(
                        settings().mode.global.value === mode.value ? "Global default ✓" : "Set global default",
                        () => submitMode("global", mode.value as "manual" | "auto" | "yolo"),
                        mode.value === "yolo",
                        `global-mode-${mode.value}`,
                        { action: "set-mode", subject: "global-mode" },
                      )}
                    </Show>
                    <Show when={settings().controls.repositoryMode}>
                      {localActionButton(
                        settings().mode.repository.value === mode.value ? "This project ✓" : "Use for this project",
                        () => submitMode("project", mode.value as "manual" | "auto" | "yolo"),
                        mode.value === "yolo",
                        `project-mode-${mode.value}`,
                        { action: "set-repo-mode", subject: "repository-mode" },
                      )}
                    </Show>
                  </box>
                </Show>
              </box>
            )))}
            <Show when={settings().controls.repositoryMode}>
              {localActionButton(
                settings().mode.repository.value === "inherit" ? "Inherit global default ✓" : "Make this project inherit global default",
                () => submitMode("project", "inherit"),
                false,
                "project-mode-inherit",
                { action: "set-repo-mode", subject: "repository-mode" },
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
                  {localActionButton(
                    "Submit Apply automatically",
                    () => void confirmYolo(),
                    true,
                    undefined,
                    { action: yoloTarget() === "global" ? "set-mode" : "set-repo-mode", subject: yoloTarget() === "global" ? "global-mode" : "repository-mode" },
                  )}
                  {localActionButton("Cancel", () => {
                    setYoloTarget(null)
                    setYoloConfirmation("")
                  }, false, undefined, undefined, "cancel-yolo")}
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
                  { action: "set-repo-excluded", subject: "project-inclusion" },
                )}
              </Show>
            </box>
            {reactiveChild(() => settings().consent.map((entry) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{entry.label}</b>: {entry.enabled ? "Allowed" : "Not allowed"} · {entry.scope}</text>
                <text wrapMode="word">{entry.description}</text>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{entry.dependency}</text>
                <Show when={settings().controls.consent && (entry.enabled || entry.canEnable)}>
                  {entry.enabled
                    ? actionButton(
                      `consent-${entry.key}-off`,
                      `Stop allowing ${entry.label}`,
                      () => props.store.submitControl("set-consent", { key: entry.key, enabled: false }),
                      false,
                      { action: "set-consent", subject: `consent:${entry.key}` },
                    )
                    : localActionButton(
                      `Review consent for ${entry.label}`,
                      () => openConsentDisclosure(entry.key),
                      false,
                      undefined,
                      undefined,
                      `consent:${entry.key}`,
                    )}
                </Show>
                {consentDisclosure(entry.key)}
                <Show when={!entry.enabled && !entry.canEnable}>
                  <text fg={props.api.theme.current.warning} wrapMode="word">Resolve the dependency above before enabling this setting.</text>
                </Show>
              </box>
            )))}
            <text wrapMode="word">Pause automatic work: {settings().paused ? "Paused" : "Running when eligible"}. Pause preserves modes and consent.</text>
            <text wrapMode="word">Emergency stop: {settings().emergencyStop ? "On" : "Off"}. It overrides every automatic provider and write path.</text>

            <text><b>Approved skill folders</b></text>
            <text wrapMode="word">{settings().approvedSkillFolderWarning}</text>
            <Show when={!settings().approvedSkillFolders.length}>
              <text fg={props.api.theme.current.warning} wrapMode="word">No folder is approved; Apply automatically cannot be enabled.</text>
            </Show>
            {reactiveChild(() => settings().approvedSkillFolders.map((folder) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="row" flexWrap="wrap" gap={1}>
                <text wrapMode="word">{folder}</text>
                <Show when={settings().controls.approvedSkillFolders}>
                  {localActionButton("Remove", () => stageFolderList(
                    settings().approvedSkillFolders.filter((candidate) => candidate !== folder),
                  ), false, undefined, undefined, `remove-folder:${folder}`)}
                </Show>
              </box>
            )))}
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
              {(draft) => (
                <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                  <text><b>Exact replacement</b></text>
                  <Show when={draft().length}>
                    {reactiveChild(() => draft().map((folder) => <text wrapMode="word">• {folder}</text>))}
                  </Show>
                  <Show when={draft().length === 0}><text>(empty)</text></Show>
                  <text>Type exactly: UPDATE ALLOWLIST</text>
                  <input
                    value={folderConfirmation()}
                    placeholder="UPDATE ALLOWLIST"
                    onInput={(value: string) => setFolderConfirmation(value.slice(0, 64))}
                  />
                  <box flexDirection="row" flexWrap="wrap" gap={1}>
                    {localActionButton(
                      "Replace approved folders",
                      () => void submitFolderList(),
                      true,
                      undefined,
                      { action: "update-allowlist", subject: "approved-skill-folders" },
                    )}
                    {localActionButton("Cancel", () => {
                      setFolderDraft(null)
                      setFolderConfirmation("")
                    }, false, undefined, undefined, "cancel-folder-update")}
                  </box>
                </box>
              )}
            </Show>

            <text><b>Limits and retention</b></text>
            <text wrapMode="word">These values are read-only here. Change configured numeric limits through startup configuration.</text>
            {reactiveChild(() => settings().limits.map((limit) => (
              <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                <text><b>{limit.label}</b></text>
                <text wrapMode="word">Actual: {limit.actual}</text>
                <text wrapMode="word">Configured limit: {limit.configured}</text>
                <Show when={limit.resetAt}>
                  {(resetAt) => <text wrapMode="word">Resets: {new Date(resetAt()).toISOString()}</text>}
                </Show>
                <text fg={props.api.theme.current.textMuted} wrapMode="word">{limit.explanation}</text>
              </box>
            )))}
            <Show when={settings().rolloutProgress}>
              {(rolloutProgress) => (
                <box border borderColor={props.api.theme.current.borderSubtle} paddingLeft={1} paddingRight={1} flexDirection="column">
                  <text><b>Automatic-apply rollout evidence</b>: {rolloutProgress().ready ? "Ready" : "Not ready"}</text>
                  <text wrapMode="word">Actual: {rolloutProgress().actual}</text>
                  <text wrapMode="word">Configured requirement: {rolloutProgress().configured}</text>
                </box>
              )}
            </Show>

            <text><b>Maintenance</b></text>
            <text wrapMode="word">Sensitive exports are private and short-lived. Delete actions permanently remove the selected retained data.</text>
            <box flexDirection="row" flexWrap="wrap" gap={1}>
              {reactiveChild(() => settings().maintenance.scopes.map((scope) => (
                <box
                  focusable
                  border
                  borderColor={maintenanceScope() === scope.value ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
                  paddingLeft={1}
                  paddingRight={1}
                  on:focused={() => setFocusedControl(`maintenance-scope:${scope.value}`)}
                  on:blurred={() => setFocusedControl((current) => current === `maintenance-scope:${scope.value}` ? null : current)}
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
                  <text>{focusMark(`maintenance-scope:${scope.value}`)}{scope.label}</text>
                </box>
              )))}
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
                    undefined,
                    {
                      action: maintenanceIntent() === "export" ? "export-data" : maintenanceScope() === "all" ? "purge-all" : "purge-scope",
                      subject: maintenanceScope() === "all" && maintenanceIntent() === "delete" ? "project" : `scope:${maintenanceScope()}`,
                    },
                  )}
                  {localActionButton("Cancel", () => {
                    setMaintenanceIntent(null)
                    setMaintenanceConfirmation("")
                  }, false, undefined, undefined, "cancel-maintenance")}
                </box>
              </box>
            </Show>
            <Show when={settings().latestExport}>
              {(latestExport) => (
                <box border borderColor={props.api.theme.current.warning} paddingLeft={1} paddingRight={1} flexDirection="column">
                  <text><b>Latest private export</b></text>
                  <text wrapMode="word">Scope: {latestExport().scope}</text>
                  <text wrapMode="word">Private path: {latestExport().path}</text>
                  <text wrapMode="word">Size: {latestExport().bytes} bytes</text>
                  <text wrapMode="word">SHA-256: {latestExport().sha256}</text>
                  <text wrapMode="word">Expires: {new Date(latestExport().expiresAt).toISOString()}</text>
                </box>
              )}
            </Show>

            <text fg={props.api.theme.current.textMuted} wrapMode="word">
              OpenCode {settings().footer.hostVersion} · Self-evolve {settings().footer.pluginVersion} · Projection {settings().footer.projectionVersion ?? "Unavailable"} · Dashboard {settings().footer.dashboardVersion ?? "Unavailable"}
            </text>
            <text fg={props.api.theme.current.textMuted} wrapMode="word">{settings().footer.help}</text>
          </box>
        </Show>
      </scrollbox>
      <box
        flexDirection="column"
        flexShrink={0}
        height={compactShell() ? 2 : "auto"}
        overflow="hidden"
      >
        <text fg={props.api.theme.current.textMuted}>
          Esc returns to {props.prior().name}
        </text>
        {reactiveChild(() => props.snapshot().responses.map((completedResponse) => (
          <text fg={completedResponse.response?.ok === false ? props.api.theme.current.error : props.api.theme.current.info} wrapMode="word">
            {requestResponseMessage(completedResponse)}
          </text>
        )))}
        <Show when={feedback()}>
          <text fg={props.api.theme.current.info} wrapMode="word">{feedback()}</text>
        </Show>
      </box>
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
  const projectStoreFactory = (options as {
    __testTuiStoreFactory?: (input: Parameters<typeof acquireProjectTuiStore>[0]) => ProjectStore
  } | undefined)?.__testTuiStoreFactory ?? acquireProjectTuiStore
  const compatibilityOptions = {
    ...(options ?? {}),
    __nativeSidebar: true,
    __testTuiStoreFactory(input: Parameters<typeof acquireProjectTuiStore>[0]) {
      projectStore = projectStoreFactory(input)
      return projectStore
    },
  }
  await legacyModule.tui(api, compatibilityOptions, meta)
  if (!projectStore) return
  releaseWithNativeCleanup = true
  const [priorRoute, setPriorRoute] = createSignal<{ name: string; params?: Record<string, unknown> }>({ name: "home" })
  const initialSnapshot = projectStore.getSnapshot()
  const [snapshot, setSnapshot] = createSignal(initialSnapshot)
  let activeSnapshotIdentity = snapshotIdentity(initialSnapshot)
  const unsubscribe = projectStore.subscribe((next) => {
    const nextIdentity = snapshotIdentity(next)
    if (activeSnapshotIdentity !== nextIdentity) {
      setPriorRoute({ name: "home" })
      if (api.route.current.name === CONTROL_CENTER_ROUTE) {
        api.route.navigate(CONTROL_CENTER_ROUTE, { section: "home" })
      }
    }
    activeSnapshotIdentity = nextIdentity
    setSnapshot(next)
  })
  api.lifecycle.onDispose(unsubscribe)
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) return
    const prior = priorRoute()
    api.route.navigate(prior.name, prior.params)
  }
  const openControlCenter = (destination: ReturnType<typeof deriveSidebarCard>["destination"] = { section: "home" }) => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      setPriorRoute({
        name: api.route.current.name,
        ...("params" in api.route.current ? { params: api.route.current.params } : {}),
      })
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
      const prior = priorRoute()
      api.route.navigate(prior.name, prior.params)
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
