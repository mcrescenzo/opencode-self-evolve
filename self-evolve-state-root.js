import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

const DEFAULT_PATH_TIMEOUT_MS = 2_000;
const STATE_DIRECTORY_MODE = 0o700;
const boundaryRecords = new WeakMap();

function missing(error) {
  return error?.code === "ENOENT";
}

function lstatOptional(filePath) {
  try { return lstatSync(filePath); } catch (error) { if (missing(error)) return null; throw error; }
}

function sameDirectory(left, right) {
  return left?.isDirectory?.() === true
    && right?.isDirectory?.() === true
    && left.dev === right.dev
    && left.ino === right.ino;
}

function absoluteDirectoryPaths(directory) {
  const parsed = path.parse(directory);
  const relative = directory.slice(parsed.root.length);
  const components = relative ? relative.split(path.sep).filter(Boolean) : [];
  const paths = [parsed.root];
  for (const component of components) paths.push(path.join(paths.at(-1), component));
  return paths;
}

function validateDirectoryPath(directory, label) {
  const entry = lstatOptional(directory);
  if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label}-rejected`);
  const canonical = realpathSync.native(directory);
  if (path.resolve(canonical) !== directory) throw new Error(`${label}-rejected`);
  return entry;
}

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
  const canonical = boundaryRecords.get(stateRoot)?.path ?? canonicalStateRoot(stateRoot);
  return createHash("sha256").update(JSON.stringify(["self-evolve-state-root-v1", canonical])).digest("hex");
}

export function validateStateRootBoundary(stateRoot, { create = false, beforeCreate } = {}) {
  const requested = canonicalStateRoot(stateRoot);
  const lineage = [];
  for (const directory of absoluteDirectoryPaths(requested)) {
    let entry = lstatOptional(directory);
    if (!entry && create) {
      beforeCreate?.({ directory, stateRoot: requested });
      for (const ancestor of lineage) {
        const current = validateDirectoryPath(ancestor.path, "state-root-boundary");
        if (!sameDirectory(ancestor.stat, current)) throw new Error("state-root-boundary-replaced");
      }
      try { mkdirSync(directory, { mode: STATE_DIRECTORY_MODE }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      entry = lstatOptional(directory);
    }
    if (!entry || !entry.isDirectory() || entry.isSymbolicLink()) throw new Error("state-root-boundary-rejected");
    const canonical = realpathSync.native(directory);
    if (path.resolve(canonical) !== directory) throw new Error("state-root-boundary-rejected");
    lineage.push(Object.freeze({ path: directory, stat: entry }));
  }
  const boundary = Object.freeze({ path: requested, identity: stateRootIdentity(requested) });
  boundaryRecords.set(boundary, Object.freeze({ path: requested, lineage: Object.freeze(lineage) }));
  return boundary;
}

export function revalidateStateRootBoundary(boundary) {
  const record = boundaryRecords.get(boundary);
  if (!record) throw new TypeError("invalid-state-root-boundary");
  for (const ancestor of record.lineage) {
    const current = validateDirectoryPath(ancestor.path, "state-root-boundary");
    if (!sameDirectory(ancestor.stat, current)) throw new Error("state-root-boundary-replaced");
  }
  return boundary.path;
}

export function walkStateRootDirectories(boundary, components, { create = false, beforeCreate } = {}) {
  const root = revalidateStateRootBoundary(boundary);
  if (!Array.isArray(components)) throw new TypeError("state-root-components-required");
  let current = root;
  const lineage = [];
  for (const component of components) {
    if (typeof component !== "string" || !component || component === "." || component === ".."
        || component.includes(path.sep) || (path.sep !== "/" && component.includes("/"))) {
      throw new Error("state-root-component-rejected");
    }
    const next = path.join(current, component);
    const relative = path.relative(root, next);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("state-root-path-escape-rejected");
    }
    let entry = lstatOptional(next);
    if (!entry && create) {
      beforeCreate?.({ directory: next, stateRoot: root });
      revalidateStateRootBoundary(boundary);
      for (const ancestor of lineage) {
        const checked = validateDirectoryPath(ancestor.path, "state-root-ancestor");
        if (!sameDirectory(ancestor.stat, checked)) throw new Error("state-root-ancestor-replaced");
      }
      try { mkdirSync(next, { mode: STATE_DIRECTORY_MODE }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      entry = lstatOptional(next);
    }
    if (!entry) return null;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("state-root-ancestor-rejected");
    const canonical = realpathSync.native(next);
    if (path.resolve(canonical) !== next) throw new Error("state-root-ancestor-rejected");
    lineage.push(Object.freeze({ path: next, stat: entry }));
    current = next;
  }
  revalidateStateRootBoundary(boundary);
  return current;
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
