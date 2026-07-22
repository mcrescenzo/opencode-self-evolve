# Configuration Reference

`self-evolve` has two configuration layers: 13 legacy manual-analyzer options resolved from `DEFAULT_OPTIONS`, and durable v0.2 autonomy settings stored under the OpenCode state root. Manual is the fail-closed default.

## Plugin Options

```json
{
  "plugin": [
    [
      "@mcrescenzo/opencode-self-evolve",
      {
        "durableAutonomy": true,
        "mode": "manual",
        "minConfidence": 0.8,
        "maxProposals": 2
      }
    ]
  ]
}
```

`durableAutonomy` enables the v0.2 durable integration at startup. The package retains the legacy manual path when this rollout switch is absent or false. `mode` controls passive entrypoint registration for that process; durable mode preference and repository overrides are managed by `/self-evolve manual|auto|yolo` and `/self-evolve repo ...`. Restart OpenCode after changing startup options or mode.

The 13 `DEFAULT_OPTIONS` entries are:

| Option | Default | Meaning |
|---|---|---|
| `minIntervalMs` | `600000` | Display-only cooldown timestamp after a legacy scan result. `reserveAnalysis` does not enforce this value, so it must not be relied on as a rate limit. |
| `maxAnalyzerRuns` | `8` | Maximum legacy analyzer runs per session. |
| `maxProposals` | `3` | Maximum accepted legacy proposals per session. |
| `maxAnalyzerFailures` | `3` | Disables the legacy session after repeated counted failures. |
| `messageLimit` | `120` | Recent messages considered for bounded transcript construction. |
| `transcriptMaxChars` | `30000` | Maximum transcript characters sent to the legacy analyzer. |
| `messageMaxChars` | `2000` | Maximum characters retained from each message. |
| `minConfidence` | `0.72` | Minimum confidence accepted by legacy proposal validation. |
| `analyzerTimeoutMs` | `120000` | Analyzer prompt timeout. |
| `sdkTimeoutMs` | `15000` | SDK read and analyzer-session creation timeout. |
| `cleanupTimeoutMs` | `5000` | Best-effort analyzer-session cleanup timeout. |
| `deliveryTimeoutMs` | `5000` | TUI toast delivery timeout. |
| `maxRegistrySessions` | `200` | Lazy cap for inactive in-memory legacy session states. |

The cooldown behavior above is intentionally documented rather than changed in v0.2: enforcing it would alter the shipped v0.1.2 manual behavior. Durable autonomy has separate scheduler budgets and debounce controls.

## Modes And Scope

| Setting | Default | Meaning |
|---|---|---|
| Global mode | `manual` | `manual`, `auto`, or `yolo`; unknown/corrupt values fail closed to manual. |
| Repository mode | `inherit` | `inherit`, `manual`, `auto`, or `yolo`. |
| Repository exclusion | `false` | Excluded repositories cannot run autonomous work. |
| `allowedSkillRoots` | `[]` | Canonical absolute skill roots. Required for yolo application; no globbing and no symlink expansion. |
| `SELF_EVOLVE_KILL` | unset | `1` or `true` forces a process-local manual downgrade without rewriting stored mode. |

Yolo activation requires explicit confirmation and an allowlist:

```text
/self-evolve yolo confirm --allowlist /absolute/path/to/skills
```

## Consent

All consent keys default to `false` and are independently controlled with `/self-evolve consent ... on|off`.

| Stored key | Command key | Meaning |
|---|---|---|
| `passiveCalls` | `passive` | Permit provider calls at stable idle boundaries. |
| `durableObservations` | `observations` | Permit automatic durable structured observations. |
| `sanitizedExcerpts` | `excerpts` | Permit bounded sanitized evidence excerpts; redaction is not a secrecy guarantee. |
| `crossRepoAggregation` | `cross-repo` | Permit separately sanitized cross-repository aggregation; requires excerpt consent. |

Manual invocation can record bounded observations for that invocation without enabling passive work. Complete transcripts and raw message bodies are never persisted.

## Budgets

| Budget | Default |
|---|---:|
| `passiveCallsPerHour` | `6` |
| `synthesisPerDay` | `24` |
| `tokensPerSynthesis` | `8000` |
| `concurrentObservationsPerProject` | `1` |
| `concurrentSynthesesGlobal` | `1` |
| `idleDebounceMs` | `1500` |
| `storageQuotaMiB` | `8` |
| `notificationsPerHour` | `3` |

Budget exhaustion fails closed. The scheduler also accepts `quietHours` as process startup periods shaped like `{ "start": 22, "end": 7 }` in local hours; quiet periods suppress autonomous scheduling. `quietHours` is currently a scheduler-only rollout option, not part of the persisted `Budgets` schema.

## Retention

`retentionDays` defaults to `30` for observations. Proposal, decision, and audit records use three times that window, giving the normative 90-day default. Retention runs on startup and daily. Use `/self-evolve export ...` before `/self-evolve purge ...` when an archive is required.

## Rollout Gates

The integration accepts a `rolloutGates` startup object. These are deployment controls, not user-visible modes:

| Gate | Default | Meaning |
|---|---:|---|
| `offlineCorpus` | `false` | Records whether the offline corpus gate has been completed. |
| `passiveShadowObservation` | `false` | Stops passive work after correlation; no synthesis or apply. |
| `automaticSynthesisApplicationDisabled` | `false` | Forces synthesis/application paths to advisory behavior. |
| `autoReviewRollout` | `true` | Enables automatic proposal review flow in auto mode. |
| `yoloEnablementThreshold.minSynthesesObserved` | `10` | Minimum observed synthesis count before yolo release. |
| `yoloEnablementThreshold.minSuccessRate` | `0.8` | Minimum synthesis success rate before yolo release. |

These gates cannot override privacy consent, canonical allowlists, deterministic validation, critic approval, budgets, exclusions, circuit breakers, or kill switches.
