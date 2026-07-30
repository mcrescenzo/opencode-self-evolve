/** @jsxImportSource @opentui/solid */

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, Renderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
// The legacy helper module is JSDoc-typed (allowJs) as a default-only module at
// typecheck time; its named package-owned exports are present at runtime because
// Bun transpiles this raw TUI target. Suppress the resolver limitation here.
// @ts-ignore
import legacyModule, { TUI_IDENTITIES, claimTuiSurfaceOwnership } from "./self-evolve-tui.js"
import {
  acquireProjectTuiStore,
  buildControlCenterModel,
  buildReviewDialogModel,
  createTuiDialogLease,
  deriveSidebarCard,
  nextReviewProposalId,
} from "./self-evolve-tui-store.js"

const CARD_ID = "self-evolve-sidebar-card"
const REVIEW_DIALOG_ID = "self-evolve-review-dialog"
const CONTROL_CENTER_COMMAND = TUI_IDENTITIES.command
const CONTROL_CENTER_ROUTE = TUI_IDENTITIES.route
const CONTROL_CENTER_MODE = TUI_IDENTITIES.mode
const CONTROL_CENTER_VIEW_ID = TUI_IDENTITIES.view
const activeApis = new WeakSet<object>()

type ProjectStore = ReturnType<typeof acquireProjectTuiStore>

function ReviewDialog(props: {
  api: Parameters<TuiPlugin>[0]
  store: ProjectStore
  snapshot: () => ReturnType<ProjectStore["getSnapshot"]>
  initialProposalId: string
  token: number
  isCurrent: (token: number) => boolean
  invalidate: (token: number) => void
}) {
  const [proposalId, setProposalId] = createSignal(props.initialProposalId)
  const [view, setView] = createSignal<"summary" | "diff" | "evidence">("summary")
  const [pendingRequestId, setPendingRequestId] = createSignal<string | null>(null)
  const [feedback, setFeedback] = createSignal<string | null>(null)
  const [confirmation, setConfirmation] = createSignal<string | null>(null)
  const model = () => buildReviewDialogModel(props.snapshot(), proposalId())
  const completedResponse = () => props.snapshot().responses.find((entry: { requestId: string }) => entry.requestId === pendingRequestId())
  const statusText = () => {
    const completed = completedResponse()
    if (!completed) return feedback()
    return completed.response.ok
      ? `${completed.action?.replaceAll("-", " ") ?? "Action"} accepted by the server.`
      : `Server rejected ${completed.action?.replaceAll("-", " ") ?? "action"}: ${completed.response.reason}`
  }
  const requestDetails = (nextId: string) => {
    const reviews = props.snapshot().projection?.index?.reviews ?? []
    const index = reviews.findIndex((review: { proposalId: string }) => review.proposalId === nextId)
    const ids = [nextId, reviews[index + 1]?.proposalId].filter(Boolean).slice(0, 2)
    void props.store.selectDetails(ids).then(() => {
      if (!props.isCurrent(props.token)) return
    })
  }
  const move = (offset: number) => {
    const current = model()
    const reviews = props.snapshot().projection?.index?.reviews ?? []
    if (!current || reviews.length < 2) return
    const next = nextReviewProposalId(reviews, current.selectedProposalId, offset)
    if (!next) return
    setProposalId(next)
    requestDetails(next)
  }
  const close = () => {
    if (!props.isCurrent(props.token)) return
    props.invalidate(props.token)
    props.api.ui.dialog.clear()
  }
  const acknowledge = () => {
    const current = proposalId()
    props.api.kv.set("self-evolve:native-audit-acknowledged", current)
    setFeedback("Audit acknowledged locally. The durable proposal record was not changed.")
    setConfirmation(null)
  }
  const submit = async (action: string, snoozeMs?: number) => {
    const current = model()
    if (!current || pendingRequestId()) return
    try {
      let request
      if (action === "acknowledge-audit") {
        acknowledge()
        return
      }
      if (action === "apply-proposal") {
        request = await props.store.submitDecision({ proposalId: current.selectedProposalId, newState: "approved" })
      } else if (action === "reject-proposal") {
        request = await props.store.submitDecision({ proposalId: current.selectedProposalId, newState: "rejected" })
      } else if (action === "snooze-proposal") {
        request = await props.store.submitOperation("snooze-proposal", {
          snoozedUntil: Date.now() + (snoozeMs ?? 86_400_000),
        }, { proposalId: current.selectedProposalId })
      } else if (action === "rollback-proposal") {
        request = await props.store.submitOperation("rollback-proposal", {}, {
          proposalId: current.selectedProposalId,
        })
      } else {
        throw new Error("unsupported-native-review-action")
      }
      setPendingRequestId(request.requestId)
      setFeedback("Request submitted. This dialog remains open while the server revalidates it.")
      setConfirmation(null)
    } catch (error) {
      setFeedback(`Request was not submitted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  onCleanup(() => props.invalidate(props.token))
  requestDetails(props.initialProposalId)
  return (
    <box
      id={REVIEW_DIALOG_ID}
      focusable
      width="100%"
      height="100%"
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      onKeyDown={(event: KeyEvent) => {
        if (event.name === "escape") {
          event.preventDefault()
          close()
        } else if (event.name === "left") {
          event.preventDefault()
          move(-1)
        } else if (event.name === "right") {
          event.preventDefault()
          move(1)
        }
      }}
    >
      <text fg={props.api.theme.current.text}>
        <b>Self-evolve review {() => model() ? `${model()!.selectedIndex + 1}/${model()!.queueCount}` : ""}</b>
      </text>
      <text fg={props.api.theme.current.textMuted} wrapMode="word">
        {() => model()?.target ?? "No review available"}
      </text>
      <box flexDirection="row" gap={1}>
        {(["summary", "diff", "evidence"] as const).map((name) => (
          <box
            focusable
            border
            paddingLeft={1}
            paddingRight={1}
            borderColor={view() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
            onMouseUp={() => setView(name)}
            onKeyDown={(event: KeyEvent) => {
              if (event.name !== "return" && event.name !== "linefeed") return
              event.preventDefault()
              setView(name)
            }}
          >
            <text fg={view() === name ? props.api.theme.current.text : props.api.theme.current.textMuted}>
              {name.charAt(0).toUpperCase() + name.slice(1)}
            </text>
          </box>
        ))}
      </box>
      <scrollbox flexGrow={1} width="100%">
        {() => (model()?.[view()] ?? ["No authoritative detail is available."]).map((line: string) => (
          <text wrapMode="word">{line}</text>
        ))}
      </scrollbox>
      <Show when={(model()?.actions.length ?? 0) > 0}>
        <box flexDirection="column">
          <text fg={props.api.theme.current.textMuted}>Server-authorized actions</text>
          <box flexDirection="row" gap={1} flexWrap="wrap">
            {() => model()?.actions.flatMap((action) => {
              const choices = action.action === "snooze-proposal"
                ? [
                  { label: "Snooze 1 hour", delay: 3_600_000 },
                  { label: "Snooze 1 day", delay: 86_400_000 },
                  { label: "Snooze 7 days", delay: 604_800_000 },
                ]
                : [{ label: action.label, delay: undefined }]
              return choices.map((choice) => (
                <box
                  focusable={!pendingRequestId()}
                  border
                  paddingLeft={1}
                  paddingRight={1}
                  borderColor={confirmation() === `${action.action}:${choice.delay ?? ""}`
                    ? props.api.theme.current.warning
                    : props.api.theme.current.borderSubtle}
                  onMouseUp={() => {
                    const key = `${action.action}:${choice.delay ?? ""}`
                    if (confirmation() === key || action.action === "acknowledge-audit") void submit(action.action, choice.delay)
                    else setConfirmation(key)
                  }}
                  onKeyDown={(event: KeyEvent) => {
                    if (event.name !== "return" && event.name !== "linefeed") return
                    event.preventDefault()
                    const key = `${action.action}:${choice.delay ?? ""}`
                    if (confirmation() === key || action.action === "acknowledge-audit") void submit(action.action, choice.delay)
                    else setConfirmation(key)
                  }}
                >
                  <text fg={props.api.theme.current.text}>
                    {confirmation() === `${action.action}:${choice.delay ?? ""}` ? `Confirm ${choice.label}` : choice.label}
                  </text>
                </box>
              ))
            })}
          </box>
        </box>
      </Show>
      <Show when={statusText()}>
        <text fg={completedResponse()?.response.ok === false ? props.api.theme.current.error : props.api.theme.current.info} wrapMode="word">
          {statusText()}
        </text>
      </Show>
      <text fg={props.api.theme.current.textMuted}>←/→ review queue · Esc close</text>
    </box>
  )
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
          if (event.name !== "return" && event.name !== "linefeed") return
          event.preventDefault()
          props.open()
        }}
      >
        <text fg={props.api.theme.current.text}><b>{props.card()?.title}</b></text>
        <text fg={props.api.theme.current.textMuted} wrapMode="word">{props.card()?.summary}</text>
      </box>
    </Show>
  )
}

function ControlCenter(props: {
  api: Parameters<TuiPlugin>[0]
  store: ProjectStore
  snapshot: () => ReturnType<ProjectStore["getSnapshot"]>
  prior: { name: string; params?: Record<string, unknown> }
}) {
  const names = ["overview", "reviews", "settings", "safety", "evidence", "health", "maintenance", "help"] as const
  const [section, setSection] = createSignal<(typeof names)[number]>("overview")
  const [feedback, setFeedback] = createSignal<string | null>(null)
  const [confirmation, setConfirmation] = createSignal<string | null>(null)
  const [allowlistText, setAllowlistText] = createSignal(
    props.snapshot().controlState?.allowedSkillRoots?.join(", ") ?? "",
  )
  const model = () => buildControlCenterModel(props.snapshot())
  let popMode = () => {}
  onMount(() => {
    popMode = props.api.mode.push(CONTROL_CENTER_MODE)
    const ids = (props.snapshot().projection?.index?.reviews ?? []).slice(0, 2).map((review) => review.proposalId)
    void props.store.selectDetails(ids)
  })
  onCleanup(() => popMode())
  const invoke = async (key: string, operation: () => Promise<unknown>, requiresConfirmation = true) => {
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
  const actionButton = (key: string, label: string, operation: () => Promise<unknown>, requiresConfirmation = true) => (
    <box
      focusable
      border
      paddingLeft={1}
      paddingRight={1}
      borderColor={confirmation() === key ? props.api.theme.current.warning : props.api.theme.current.borderSubtle}
      onMouseUp={() => void invoke(key, operation, requiresConfirmation)}
      onKeyDown={(event: KeyEvent) => {
        if (event.name !== "return" && event.name !== "linefeed") return
        event.preventDefault()
        void invoke(key, operation, requiresConfirmation)
      }}
    >
      <text fg={props.api.theme.current.text}>{confirmation() === key ? `Confirm ${label}` : label}</text>
    </box>
  )
  const control = () => props.snapshot().controlState
  const setMode = (mode: "manual" | "auto" | "yolo") => {
    const roots = allowlistText().split(",").map((value) => value.trim()).filter(Boolean)
    return props.store.submitControl("set-mode", mode === "yolo"
      ? { mode, allowlist: roots, confirmation: "ENABLE YOLO" }
      : { mode })
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
      <text fg={props.api.theme.current.text}><b>Self-evolve control center</b></text>
      <box flexDirection="row" gap={1}>
        {names.map((name) => (
          <box
            focusable
            border
            paddingLeft={1}
            paddingRight={1}
            borderColor={section() === name ? props.api.theme.current.borderActive : props.api.theme.current.borderSubtle}
            onMouseUp={() => setSection(name)}
            onKeyDown={(event: KeyEvent) => {
              if (event.name !== "return" && event.name !== "linefeed") return
              event.preventDefault()
              setSection(name)
            }}
          >
            <text fg={section() === name ? props.api.theme.current.text : props.api.theme.current.textMuted}>
              {name === "health" ? "Health / Budgets" : name.charAt(0).toUpperCase() + name.slice(1)}
            </text>
          </box>
        ))}
      </box>
      <scrollbox flexGrow={1} width="100%">
        {() => model().sections[section()].map((line: string) => <text wrapMode="word">{line}</text>)}
        <Show when={section() === "settings" && control()}>
          <box flexDirection="column" gap={1}>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {actionButton("mode-manual", "Set manual", () => setMode("manual"))}
              {actionButton("mode-auto", "Set auto", () => setMode("auto"))}
              {actionButton("mode-yolo", "Enable yolo", () => setMode("yolo"))}
              {actionButton(
                "repo-excluded",
                control()!.repoExcluded ? "Include repository" : "Exclude repository",
                () => props.store.submitControl("set-repo-excluded", { excluded: !control()!.repoExcluded }),
              )}
            </box>
            <text fg={props.api.theme.current.textMuted}>Canonical allowlist, comma separated (shown again in yolo confirmation)</text>
            <input
              value={allowlistText()}
              placeholder="/canonical/root, /another/root"
              onInput={(value: string) => setAllowlistText(value)}
            />
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {actionButton("allowlist", "Replace allowlist", () => props.store.submitControl("update-allowlist", {
                allowlist: allowlistText().split(",").map((value) => value.trim()).filter(Boolean),
                confirmation: "UPDATE ALLOWLIST",
              }))}
              {() => Object.entries(control()!.consent).map(([key, enabled]) =>
                actionButton(
                  `consent-${key}`,
                  `${enabled ? "Disable" : "Enable"} ${key}`,
                  () => props.store.submitControl("set-consent", { key, enabled: !enabled }),
                ))}
            </box>
          </box>
        </Show>
        <Show when={section() === "safety"}>
          <box flexDirection="row" gap={1} flexWrap="wrap">
            {actionButton(
              "kill-switch",
              props.snapshot().projection?.index?.status.killSwitchActive ? "Disable kill switch" : "Enable kill switch",
              () => props.store.submitOperation("set-kill-switch", {
                enabled: !props.snapshot().projection?.index?.status.killSwitchActive,
              }),
            )}
            {actionButton(
              "paused",
              props.snapshot().projection?.index?.status.paused ? "Resume scheduling" : "Pause scheduling",
              () => props.store.submitOperation("set-paused", {
                paused: !props.snapshot().projection?.index?.status.paused,
              }),
            )}
          </box>
        </Show>
        <Show when={section() === "overview" && props.snapshot().projection?.index?.allowedActions.some((action) => action.action === "retry-bootstrap")}>
          <box flexDirection="row">
            {actionButton("retry-bootstrap", "Retry bootstrap", () => props.store.submitOperation("retry-bootstrap", {}))}
          </box>
        </Show>
        <Show when={section() === "maintenance"}>
          <box flexDirection="column" gap={1}>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {(["observations", "proposals", "project"] as const).map((scope) =>
                actionButton(`purge-${scope}`, `Purge ${scope}`, () => props.store.submitOperation("purge-scope", {
                  scope,
                  confirmation: `PURGE ${scope.toUpperCase()}`,
                })))}
              {actionButton("purge-all", "Purge all", () => props.store.submitOperation("purge-all", {
                confirmation: "PURGE ALL SELF-EVOLVE DATA",
              }))}
            </box>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              {(["observations", "proposals", "project", "all"] as const).map((scope) =>
                actionButton(`export-${scope}`, `Export ${scope}`, () => props.store.submitOperation("export-data", {
                  scope,
                  confirmation: "EXPORT SENSITIVE SELF-EVOLVE DATA",
                })))}
            </box>
          </box>
        </Show>
      </scrollbox>
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
  const dialogLease = createTuiDialogLease()
  const isCurrent = (token: number) => dialogLease.current(token) && !api.lifecycle.signal.aborted
  const invalidate = (token: number) => dialogLease.invalidate(token)
  api.lifecycle.onDispose(() => dialogLease.dispose())
  const openReview = () => {
    const reviews = snapshot().projection?.index?.reviews ?? []
    if (!reviews.length) return
    const token = dialogLease.open()
    api.ui.dialog.setSize("xlarge")
    api.ui.dialog.replace(
      () => (
        <ReviewDialog
          api={api}
          store={projectStore!}
          snapshot={snapshot}
          initialProposalId={reviews[0].proposalId}
          token={token}
          isCurrent={isCurrent}
          invalidate={invalidate}
        />
      ),
      () => invalidate(token),
    )
  }
  let priorRoute: { name: string; params?: Record<string, unknown> } = { name: "home" }
  const closeControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) return
    api.route.navigate(priorRoute.name, priorRoute.params)
  }
  const openControlCenter = () => {
    if (api.route.current.name !== CONTROL_CENTER_ROUTE) {
      priorRoute = {
        name: api.route.current.name,
        ...("params" in api.route.current ? { params: api.route.current.params } : {}),
      }
    }
    api.route.navigate(CONTROL_CENTER_ROUTE)
  }
  const unregisterRoute = api.route.register([{
    name: CONTROL_CENTER_ROUTE,
    render: () => <ControlCenter api={api} store={projectStore!} snapshot={snapshot} prior={priorRoute} />,
  }])
  const unregisterPaletteKeymap = api.keymap.registerLayer({
    id: TUI_IDENTITIES.paletteLayer,
    commands: [{
      name: CONTROL_CENTER_COMMAND,
      title: "Self-evolve control center",
      category: "Self-evolve",
      namespace: "palette",
      run: openControlCenter,
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
            if (card?.kind === "review" || card?.kind === "audit" || card?.kind === "failure") openReview()
            else openControlCenter()
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
