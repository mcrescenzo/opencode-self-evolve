import { createHash } from "node:crypto";
import path from "node:path";

const DEFAULT_PATH_TIMEOUT_MS = 2_000;

export function canonicalStateRoot(value, label = "state-root") {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !path.isAbsolute(value)) {
    throw new TypeError(`invalid-${label}`);
  }
  return path.resolve(value);
}

export function environmentStateRoot(environment = process.env) {
  if (typeof environment?.XDG_STATE_HOME === "string" && environment.XDG_STATE_HOME.trim()) {
    return canonicalStateRoot(path.join(environment.XDG_STATE_HOME, "opencode"), "environment-state-root");
  }
  if (typeof environment?.HOME === "string" && environment.HOME.trim()) {
    return canonicalStateRoot(path.join(environment.HOME, ".local", "state", "opencode"), "environment-state-root");
  }
  return null;
}

export function stateRootIdentity(stateRoot) {
  return createHash("sha256").update(JSON.stringify(["self-evolve-state-root-v1", canonicalStateRoot(stateRoot)])).digest("hex");
}

export function initialStateRootSelection({ explicitStateRoot, hostStateRoot, environment = process.env, hasOfficialPathApi = false } = {}) {
  if (explicitStateRoot !== undefined && explicitStateRoot !== null && explicitStateRoot !== "") {
    return Object.freeze({ stateRoot: canonicalStateRoot(explicitStateRoot), source: "explicit", provisional: false });
  }
  if (hostStateRoot !== undefined && hostStateRoot !== null && hostStateRoot !== "") {
    return Object.freeze({ stateRoot: canonicalStateRoot(hostStateRoot, "host-state-root"), source: "host", provisional: false });
  }
  const fallback = environmentStateRoot(environment);
  if (hasOfficialPathApi) {
    return fallback
      ? Object.freeze({ stateRoot: fallback, source: "environment-provisional", provisional: true })
      : Object.freeze({ stateRoot: null, source: "official-path-pending", provisional: true });
  }
  return Object.freeze({ stateRoot: fallback, source: fallback ? "environment" : "unavailable", provisional: false });
}

function bounded(task, timeoutMs, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}-timeout`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export async function officialClientStateRoot(ctx, { timeoutMs = DEFAULT_PATH_TIMEOUT_MS } = {}) {
  const getPath = ctx?.client?.path?.get;
  if (typeof getPath !== "function") throw new Error("official-state-path-unavailable");
  const boundedTimeout = Math.min(10_000, Math.max(10, timeoutMs));
  const result = await bounded(
    () => getPath.call(ctx.client.path, { query: { directory: ctx.directory } }),
    boundedTimeout,
    "official-state-path",
  );
  const value = result?.data?.state;
  if (typeof value !== "string" || !value.trim()) throw new Error("official-state-path-unavailable");
  return canonicalStateRoot(value, "official-state-root");
}

export async function resolveStateRoot(ctx, options = {}) {
  const initial = initialStateRootSelection({
    explicitStateRoot: options.stateRoot,
    hostStateRoot: options.hostStateRoot ?? ctx?.path?.state ?? ctx?.state?.path?.state,
    environment: options.env ?? process.env,
    hasOfficialPathApi: typeof ctx?.client?.path?.get === "function",
  });
  if (!initial.provisional) return initial.stateRoot;
  try {
    return await officialClientStateRoot(ctx, { timeoutMs: options.stateRootTimeoutMs });
  } catch {
    return null;
  }
}

export function validateProjectedStateRoot(stateRoot, projectedIdentity) {
  if (typeof projectedIdentity !== "string" || projectedIdentity !== stateRootIdentity(stateRoot)) {
    throw new Error("state-root-projection-mismatch");
  }
  return true;
}
