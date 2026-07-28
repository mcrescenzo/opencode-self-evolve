import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { makeAuditEvent, wrapRecord } from "../../self-evolve-schemas.js";
import { openStore } from "../../self-evolve-store.js";

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function auditRecord(index, projectFingerprint) {
  const sessionIDHash = BigInt(index).toString(16).padStart(64, "0");
  const details = { action: "session-status", sessionIDHash, status: "retry", epoch: 1 };
  const event = makeAuditEvent({
    id: hash(`cache-writer:${sessionIDHash}`),
    kind: "decision",
    actor: "self-evolve-scheduler",
    timestamp: 1_000,
    payloadHash: hash(JSON.stringify(details)),
    details,
  });
  return wrapRecord("audit-event", event, 1_000);
}

function sourceFor(index, projectFingerprint) {
  return `${JSON.stringify(auditRecord(index, projectFingerprint))}\n`;
}

function atomicReplace(filePath, source, fixedTime) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
    utimesSync(temporary, fixedTime, fixedTime);
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function result(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

const [operation, ...args] = process.argv.slice(2);

try {
  if (operation === "race") {
    const [filePath, projectFingerprint, readyPath, stopPath, resultPath, fixedTimeValue] = args;
    const fixedTime = new Date(Number(fixedTimeValue));
    let writes = 0;
    result(readyPath, { ready: true });
    while (!existsSync(stopPath)) {
      writes += 1;
      atomicReplace(filePath, sourceFor(writes, projectFingerprint), fixedTime);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    result(resultPath, { ok: true, writes });
  } else if (operation === "collide") {
    const [filePath, projectFingerprint, resultPath, devValue, inoValue, sizeValue, mtimeValue] = args;
    const target = {
      dev: BigInt(devValue),
      ino: BigInt(inoValue),
      size: BigInt(sizeValue),
      mtimeMs: Number(mtimeValue),
    };
    const fixedTime = new Date(target.mtimeMs);
    let matched = false;
    let writes = 0;
    for (let index = 1; index <= 20_000; index += 1) {
      writes = index;
      atomicReplace(filePath, sourceFor(index, projectFingerprint), fixedTime);
      const stat = statSync(filePath, { bigint: true });
      if (stat.dev === target.dev
        && stat.ino === target.ino
        && stat.size === target.size
        && Number(stat.mtimeMs) === target.mtimeMs) {
        matched = true;
        break;
      }
    }
    result(resultPath, { ok: true, matched, writes });
  } else if (operation === "append") {
    const [root, projectFingerprint, resultPath, indexValue] = args;
    const store = openStore(root, {
      projectName: "cache-writer",
      projectFingerprint,
      now: () => 2_000,
    });
    const appended = store.appendRecord(auditRecord(Number(indexValue), projectFingerprint));
    const closed = store.close();
    result(resultPath, { ok: appended.ok === true && closed.ok === true, appended, closed });
  } else {
    throw new Error("unknown-store-cache-writer-operation");
  }
} catch (error) {
  const resultPath = operation === "race" ? args[4] : operation === "collide" ? args[2] : args[2];
  if (resultPath) {
    try { result(resultPath, { ok: false, error: String(error?.stack ?? error) }); } catch {}
  }
  process.exitCode = 1;
}
