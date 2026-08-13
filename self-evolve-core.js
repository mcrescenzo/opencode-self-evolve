// Target-neutral runtime identities and compatibility parsing shared by the
// server entry, durable store, integration, and hidden provider sessions.

export const SELF_EVOLVE_MODULE_ID = "mcrescenzo.self-evolve";
export const SELF_EVOLVE_SOURCE = SELF_EVOLVE_MODULE_ID;
export const SELF_EVOLVE_SYNTHESIZER_AGENT = `${SELF_EVOLVE_MODULE_ID}.synthesizer`;
export const SELF_EVOLVE_CRITIC_AGENT = `${SELF_EVOLVE_MODULE_ID}.critic`;

// These values are cleanup-only compatibility identifiers. The v0.4 runtime
// never registers, creates, or prompts an analyzer session. They remain
// bounded here so boot recovery can delete provably owned orphaned sessions
// left by earlier releases and the store can validate their historical owner
// records without widening current provider authority.
export const HISTORICAL_SELF_EVOLVE_ANALYZER_AGENT = `${SELF_EVOLVE_MODULE_ID}.analyzer`;
export const HISTORICAL_SELF_EVOLVE_AGENTS = Object.freeze({
  analyzer: "self-evolve-analyzer",
  synthesizer: "self-evolve-synthesizer",
  critic: "self-evolve-critic",
});

const DURABLE_LIFECYCLE_EVENT_TYPES = new Set([
  "session.compacted",
  "session.idle",
  "session.status",
]);

export function durableEventBody(input) {
  return input?.event && typeof input.event === "object" ? input.event : input;
}

export function isDurableLifecycleEvent(input) {
  return DURABLE_LIFECYCLE_EVENT_TYPES.has(durableEventBody(input)?.type);
}

export function parseCommand(args = "") {
  const trimmed = String(args || "").trim();
  if (!trimmed) return { verb: "default" };
  const [verbRaw, ...rest] = trimmed.split(/\s+/u);
  const verb = verbRaw.toLowerCase();
  if (["status", "help", "health", "inbox", "budget"].includes(verb)) return { verb };
  if (["scan", "manual", "auto", "yolo", "repo", "pause", "resume", "disable"].includes(verb)) {
    return { verb: "removed", removedCommand: verb };
  }
  if (["on", "off"].includes(verb)) return { verb: "automatic-recommendations", enabled: verb === "on" };
  if (verb === "dismiss") return { verb, proposalID: rest.join(" ").trim() };
  return { verb: "error", message: `Unknown /self-evolve command: ${verbRaw}` };
}
