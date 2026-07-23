const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

function errorMessage(error, fallback) {
  const detail = error?.data?.message ?? error?.message ?? error?._tag ?? error?.name;
  return typeof detail === "string" && detail.trim() ? detail : String(error ?? fallback);
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms (${label}-timeout).`);
  error.code = "SELF_EVOLVE_HOST_TIMEOUT";
  return error;
}

function cancelledError(label) {
  const error = new Error(`${label} cancelled.`);
  error.code = "SELF_EVOLVE_HOST_CANCELLED";
  return error;
}

export function boundedHostCall(invoke, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label = "OpenCode host call",
  signal,
  onLateResolve,
} = {}) {
  const bounded = Number.isFinite(timeoutMs) ? Math.max(1, Math.trunc(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError(label));
      return;
    }
    let settled = false;
    let endedEarly = false;
    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
      return true;
    };
    const abort = () => {
      endedEarly = true;
      finish(() => reject(cancelledError(label)));
    };
    const timer = setTimeout(() => {
      endedEarly = true;
      finish(() => reject(timeoutError(label, bounded)));
    }, bounded);
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(invoke).then(
      (value) => {
        if (!finish(() => resolve(value)) && endedEarly && typeof onLateResolve === "function") {
          try { Promise.resolve(onLateResolve(value)).catch(() => {}); } catch {}
        }
      },
      (error) => {
        // Always attach a rejection handler so a late host rejection cannot
        // become an unhandled rejection after the caller's deadline expired.
        finish(() => reject(error));
      },
    );
  });
}

async function invokeCompatible(attempts, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  label,
  signal,
  onLateResolve,
} = {}) {
  const bounded = Number.isFinite(timeoutMs) ? Math.max(1, Math.trunc(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + bounded;
  let lastError;
  for (const invoke of attempts) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError(label, bounded);
    try {
      const result = await boundedHostCall(invoke, {
        timeoutMs: remaining,
        label,
        signal,
        onLateResolve,
      });
      if (!result?.error) return result;
      lastError = result.error;
    } catch (error) {
      if (error?.code === "SELF_EVOLVE_HOST_TIMEOUT" || error?.code === "SELF_EVOLVE_HOST_CANCELLED") throw error;
      lastError = error;
    }
  }
  throw new Error(errorMessage(lastError, `${label} failed.`));
}

function omitKeys(value, keys) {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => !omitted.has(key)));
}

export function createdSessionID(result) {
  return result?.data?.id
    ?? result?.data?.sessionID
    ?? result?.data?.session?.id
    ?? result?.id
    ?? result?.sessionID
    ?? result?.session?.id;
}

export function sessionMessages(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.data?.messages)) return result.data.messages;
  if (Array.isArray(result?.messages)) return result.messages;
  return [];
}

export function listedSessions(result) {
  const value = result?.data ?? result;
  if (Array.isArray(value)) return value;
  return value?.sessions ?? value?.items ?? [];
}

export function sessionOutput(result) {
  const structured = result?.data?.info?.structured_output
    ?? result?.data?.structured_output
    ?? result?.info?.structured_output
    ?? result?.structured_output
    ?? result?.data?.info?.structured
    ?? result?.data?.structured
    ?? result?.info?.structured
    ?? result?.structured;
  if (structured !== undefined) return structured;
  const candidates = [
    result?.data?.parts,
    result?.data?.message?.parts,
    result?.message?.parts,
    result?.parts,
  ];
  for (const parts of candidates) {
    if (!Array.isArray(parts)) continue;
    const text = parts.map((part) => part?.text ?? part?.content ?? "").filter(Boolean).join("\n");
    if (text.trim()) return text;
  }
  return String(result?.data?.text ?? result?.text ?? result?.message?.text ?? "");
}

export async function createSession(ctx, body, options = {}) {
  const session = ctx?.client?.session;
  const method = session?.create;
  if (typeof method !== "function") throw new Error("OpenCode session.create is unavailable.");
  const bodies = [
    body,
    omitKeys(body, ["permission"]),
    omitKeys(body, ["permission", "parentID"]),
  ];
  const attempts = [];
  const seen = new Set();
  for (const candidate of bodies) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    attempts.push(
      () => method.call(session, { body: candidate, query: { directory: ctx.directory } }),
      () => method.call(session, { directory: ctx.directory, ...candidate }),
    );
  }
  return invokeCompatible(attempts, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label ?? "OpenCode session.create",
    onLateResolve: options.onLateResolve,
  });
}

export async function promptSession(ctx, sessionID, body, options = {}) {
  const session = ctx?.client?.session;
  const method = session?.prompt;
  if (typeof method !== "function") throw new Error("OpenCode session.prompt is unavailable.");
  return invokeCompatible([
    () => method.call(session, { path: { id: sessionID }, query: { directory: ctx.directory }, body }),
    () => method.call(session, { path: { sessionID }, query: { directory: ctx.directory }, body }),
    () => method.call(session, { sessionID, directory: ctx.directory, ...body }),
  ], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label ?? "OpenCode session.prompt",
  });
}

export async function readSessionMessages(ctx, sessionID, limit, options = {}) {
  const session = ctx?.client?.session;
  const method = session?.messages;
  if (typeof method !== "function") throw new Error("OpenCode session.messages is unavailable.");
  const result = await invokeCompatible([
    () => method.call(session, { path: { id: sessionID }, query: { directory: ctx.directory, limit } }),
    () => method.call(session, { path: { sessionID }, query: { directory: ctx.directory, limit } }),
    () => method.call(session, { sessionID, directory: ctx.directory, limit }),
  ], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label ?? "OpenCode session.messages",
  });
  return sessionMessages(result).slice(-limit);
}

export async function cleanupSession(ctx, sessionID, options = {}) {
  const session = ctx?.client?.session;
  const methodName = typeof session?.abort === "function"
    ? "abort"
    : typeof session?.interrupt === "function" ? "interrupt" : null;
  if (!methodName) {
    if (options.optional) return { data: {} };
    throw new Error("OpenCode session cleanup is unavailable.");
  }
  const method = session[methodName];
  return invokeCompatible([
    () => method.call(session, { path: { id: sessionID }, query: { directory: ctx.directory } }),
    () => method.call(session, { path: { sessionID }, query: { directory: ctx.directory } }),
    () => method.call(session, { sessionID, directory: ctx.directory }),
    () => method.call(session, { id: sessionID }),
    () => method.call(session, sessionID),
  ], {
    timeoutMs: options.timeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
    signal: options.signal,
    label: options.label ?? `OpenCode session.${methodName} cleanup`,
  });
}

export async function listSessions(ctx, options = {}) {
  const session = ctx?.client?.session;
  const method = session?.list;
  if (typeof method !== "function") return [];
  const result = await invokeCompatible([
    () => method.call(session, { query: { directory: ctx.directory } }),
    () => method.call(session, { directory: ctx.directory }),
  ], {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    label: options.label ?? "OpenCode session.list",
  });
  return listedSessions(result);
}
