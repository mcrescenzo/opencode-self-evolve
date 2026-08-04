/** @jsxImportSource @opentui/solid */
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, Renderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginModule, TuiRouteCurrent } from "@opencode-ai/plugin/tui"

const PLUGIN_ID = "mcrescenzo.self-evolve-host-spike"
const COMMAND_ID = "self-evolve.control-center"
const ROUTE_ID = "self-evolve.control-center.route"
const CARD_ID = "self-evolve-spike-card"
const DIALOG_ID = "self-evolve-spike-dialog"
const ROUTE_VIEW_ID = "self-evolve-spike-route"
const DELAYED_ID = "self-evolve-spike-delayed"

let activations = 0

function requiredEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const eventsPath = requiredEnv("SELF_EVOLVE_TUI_SPIKE_EVENTS")
const fixtureStatePath = requiredEnv("SELF_EVOLVE_TUI_SPIKE_FIXTURE_STATE")
const expectedVersion = requiredEnv("SELF_EVOLVE_TUI_SPIKE_PRODUCT_VERSION")
const packageVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version

function record(type: string, data: Record<string, unknown> = {}) {
  if (!existsSync(eventsPath)) return
  appendFileSync(eventsPath, `${JSON.stringify({ source: "product", type, ...data })}\n`, { encoding: "utf8", mode: 0o600 })
}

function fixtureVisible() {
  try {
    return JSON.parse(readFileSync(fixtureStatePath, "utf8")).cardVisible === true
  } catch {
    return false
  }
}

function sameRoute(left: TuiRouteCurrent, right: TuiRouteCurrent) {
  return left.name === right.name && JSON.stringify("params" in left ? left.params : undefined)
    === JSON.stringify("params" in right ? right.params : undefined)
}

function navigateExact(api: Parameters<TuiPlugin>[0], route: TuiRouteCurrent) {
  api.route.navigate(route.name, "params" in route ? route.params : undefined)
}

function ProductDialog() {
  onMount(() => record("dialog-mounted"))
  return (
    <box id={DIALOG_ID} flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text><b>Self-evolve host spike</b></text>
      <text>Dialog mounted through api.ui.dialog.replace</text>
    </box>
  )
}

function openDialog(api: Parameters<TuiPlugin>[0], source: string) {
  record("dialog-requested", { source })
  api.ui.dialog.replace(() => <ProductDialog />)
}

function Card(props: { api: Parameters<TuiPlugin>[0]; visible: () => boolean }) {
  let card: Renderable | undefined
  return (
    <Show when={props.visible()}>
      <box
        id={CARD_ID}
        ref={(value: Renderable) => (card = value)}
        focusable
        border
        paddingLeft={1}
        paddingRight={1}
        flexDirection="column"
        onMouseDown={() => card?.focus()}
        onMouseUp={() => openDialog(props.api, "pointer")}
        onKeyDown={(event: KeyEvent) => {
          if (event.name !== "return" && event.name !== "linefeed") return
          event.preventDefault()
          openDialog(props.api, "enter")
        }}
      >
        <text><b>Self-evolve</b></text>
        <text>Open control center</text>
      </box>
    </Show>
  )
}

function RouteView(props: {
  api: Parameters<TuiPlugin>[0]
  prior: TuiRouteCurrent
}) {
  let popMode = () => {}
  const close = () => navigateExact(props.api, props.prior)
  onMount(() => {
    popMode = props.api.mode.push("self-evolve-control-center")
    record("route-mounted", { prior: props.prior.name, mode: props.api.mode.current() })
  })
  onCleanup(() => {
    popMode()
    record("route-cleaned", {
      priorRestored: sameRoute(props.api.route.current, props.prior),
      mode: props.api.mode.current(),
    })
  })
  return (
    <box
      id={ROUTE_VIEW_ID}
      focusable
      width="100%"
      height="100%"
      border
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      onKeyDown={(event: KeyEvent) => {
        if (event.name !== "return" && event.name !== "escape") return
        event.preventDefault()
        close()
      }}
    >
      <text><b>Self-evolve control center</b></text>
      <text>Host-native namespaced route</text>
      <text>Enter or escape returns to the exact prior route</text>
    </box>
  )
}

function DelayedDialog(props: { api: Parameters<TuiPlugin>[0] }) {
  let alive = true
  onMount(() => {
    setTimeout(() => {
      if (!alive) {
        record("delayed-noop")
        return
      }
      record("delayed-overwrite")
      props.api.ui.dialog.replace(() => <ProductDialog />)
    }, 300)
  })
  onCleanup(() => {
    alive = false
    // Keep the callback scheduled so the live spike proves the lease check itself.
  })
  return (
    <box id={DELAYED_ID} paddingLeft={2} paddingRight={2}>
      <text>Self-evolve delayed component</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  activations += 1
  const activation = activations
  if (packageVersion !== expectedVersion || !import.meta.url.endsWith("/tui.generated.js") || api.app.version !== "1.18.3") {
    throw new Error("live spike loaded an unexpected product or host version")
  }
  const [visible, setVisible] = createSignal(fixtureVisible())
  const initialPath = api.state.path.directory
  let currentPath = initialPath
  let stopped = false
  let disposed = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = (operation: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (stopped) return
      operation()
      schedule(operation)
    }, 50)
    timers.add(timer)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopped = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    record("disposed", { activation })
  }
  api.lifecycle.onDispose(dispose)

  record("activated", {
    activation,
    productVersion: packageVersion,
    hostVersion: api.app.version,
    targetIsBuilt: import.meta.url.endsWith("/tui.generated.js"),
  })

  schedule(() => setVisible(fixtureVisible()))
  schedule(() => {
    const next = api.state.path.directory
    if (!next || next === currentPath) return
    currentPath = next
    record("path-rebound", {
      changed: next !== initialPath,
      activation,
    })
  })

  let priorRoute: TuiRouteCurrent = { name: "home" }
  const openRoute = () => {
    if (api.route.current.name !== ROUTE_ID) priorRoute = api.route.current
    api.route.navigate(ROUTE_ID)
  }
  api.route.register([
    {
      name: ROUTE_ID,
      render: () => <RouteView api={api} prior={priorRoute} />,
    },
  ])
  api.keymap.registerLayer({
    commands: [
      {
        name: COMMAND_ID,
        title: "Self-evolve control center",
        category: "Self-evolve",
        namespace: "palette",
        run: openRoute,
      },
      {
        name: "self-evolve.host-spike.delayed",
        title: "Self-evolve delayed lease spike",
        category: "Self-evolve",
        namespace: "host-spike-private",
        hidden: true,
        run: () => api.ui.dialog.replace(() => <DelayedDialog api={api} />),
      },
    ],
  })
  api.slots.register({
    order: 275,
    slots: {
      sidebar_content() {
        return <Card api={api} visible={visible} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
