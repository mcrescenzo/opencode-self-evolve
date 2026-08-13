# Self-Evolve v0.4 Control Center UX

**Status:** Normative native-UX contract for Self-Evolve v0.4.

The persistent sidebar is the normal entry point. It opens one full-screen control center with exactly four mounted sections: Home, Recommendations, Activity, and Settings. Slash commands remain headless recovery and compatibility tools; no normal workflow depends on them.

## Product language

Use these terms exactly on current surfaces:

| Domain value | Product label | Meaning |
|---|---|---|
| `automaticRecommendationsEnabled: true` | Automatic recommendations On | Future eligible activity may be observed and used to prepare recommendations. No write authority is granted. |
| `automaticRecommendationsEnabled: false` | Automatic recommendations Off | New automatic work is stopped across processes. Existing recommendations and explicit actions remain available. |
| `repo.excluded: false` | Project Included | This project may participate when all global and operational gates pass. |
| `repo.excluded: true` | Project Excluded | This project is suppressed without changing the global preference. |
| `killSwitchActive: true` | Emergency Stop On | Automatic work and new Apply are suppressed without changing the preference. |
| breaker open | Paused after repeated failures | The circuit breaker suppressed work; this is not a user-configurable pause. |

Current UI must not present Manual, Auto, Yolo, on-demand, scan, installation/project/repository modes, inheritance, ordinary Pause/Resume/Disable, or passive-call consent. Read-only legacy data may be parsed only to explain that a mixed-version pairing is limited.

## Shared operational model

The sidebar, header, and Home derive from the same server-authored dashboard. Higher-priority safety states always win over lower-priority attention or readiness:

1. accepted-terminal or corrupt state;
2. Emergency Stop;
3. circuit breaker;
4. project Excluded;
5. Automatic recommendations Off;
6. missing host, root, provider, or required permission setup;
7. active work, backoff, budget, or quiet period;
8. recommendation or applied-change attention;
9. ready.

Operational suppressors never rewrite the On/Off preference. The UI therefore shows both the stored preference and the active suppressor when they differ.

## Sidebar

The sidebar card shows one truthful status, the last checked time or bounded explanation, and one exact deep link:

- setup or Automatic recommendations Off → Settings at the relevant control;
- a recommendation → selected Recommendation detail;
- a failure or breaker → Activity filtered to Errors;
- healthy, startup, waiting, or in-flight → Home.

The compact On/Off control uses the same operation-v2 authority as Settings. Turning On requires confirmation because it enables the complete required data-permission bundle. Turning Off is immediate, preserves retained data, and grants no other authority. If the v0.4 server/TUI protocols are not aligned, the control is read-only and says why.

## Home

Home contains:

- the shared operational status and next action;
- Automatic recommendations On/Off and project Included/Excluded;
- global-recommendation protocol readiness;
- actionable blockers with exact deep links;
- last-cycle outcome without any retired mode field;
- recommendation/applied-change attention;
- actual provider, synthesis, and storage use;
- bounded recent semantic activity;
- honest empty, unavailable, stale, and limited states.

Home never invents healthy readiness from a missing or invalid dashboard. It never offers scan or a fallback manual path.

## Recommendations

Recommendations is the single normal review path. Queue, detail, and action outcomes remain mounted in the control center; no separate review dialog is opened by polling.

Apply, Reject, and Undo come only from fresh server grants. Each action is bound to the exact recommendation, version, support set, target binding, target hash, proposed content hash, nonce, projection generation, and current authority. Automatic recommendations On is never an Apply grant. Off does not hide or suppress an otherwise valid explicit action.

Apply reasons and Undo reasons are projected independently. Privacy revocation may block Apply while exact transaction-proven Undo stays available. Emergency Stop and breaker state follow the same action-specific server policy.

## Activity

Activity is bounded semantic history, not a raw-log viewer. Filters are All, Recommendations, System, and Errors. It may narrate:

- recommendation creation, decisions, Apply, Undo, and acknowledgement;
- Automatic recommendations On/Off;
- project Include/Exclude;
- Emergency Stop changes;
- quiet period, budgets, backoff, breaker trip/reset, startup, recovery, export, and purge;
- bounded failures with reason codes and destinations.

Raw audit objects, prompts, provider payloads, secrets, transcript text, and host session/message identifiers never render.

## Settings

Settings presents these groups in order:

1. **Automatic recommendations** — one truthful On/Off preference and automation generation.
2. **Privacy and project scope** — Project Include/Exclude plus exactly three retained data permissions: Saved structured patterns, Sanitized evidence excerpts, and Cross-project learning.
3. **Emergency Stop** — an operational safety suppressor, clearly distinct from Off.
4. **Approved global skill folders** — exact host-authoritative roots and the explicit creation-root policy.
5. **Limits and retention** — actual and configured provider/synthesis/storage/concurrency/quiet-period values.
6. **Maintenance** — export, scoped purge, purge-all, retry/recovery, breaker reset, and authenticated reinitialize where freshly granted.

Turning On atomically enables all three required permissions. Revoking any required permission atomically turns Automatic recommendations Off and performs the existing permission-specific cleanup or invalidation. Restoring a permission leaves the preference Off. Copy must explain those effects before confirmation.

Project Include/Exclude and Emergency Stop do not change the global preference. Root-policy suggestions are non-authoritative; changes replace the complete explicit policy only after fresh server-side host/catalog validation.

## Interaction and focus

- Mouse and keyboard activation are equivalent; focused Enter or Space activates.
- The full-screen control center owns a mode-scoped Escape binding so any focused descendant returns to the exact prior route.
- Deep links focus and scroll the exact destination control after mount.
- Outcomes remain mounted; background refresh updates state in place.
- No proposal/status/settings toasts, attention notifications, polling-triggered dialogs, or automatically opened routes are allowed.
- Pending actions disable duplicate submission and remain visible until a bounded response, expiry, or refresh reconciliation.

## Protocol compatibility

Dashboard v3 and operation v2 are the only writable settings/control plane. Dashboard v1/v2, operation v1, and legacy control mailboxes are read-only compatibility input. A new-TUI/old-server or old-TUI/new-server pairing must be visibly limited and must not submit writes.

The TUI publishes only strict create-exclusive decision, global-action, and operation envelopes. The server freshly revalidates root/project identity, projection and grant generation, settings version, automation generation, nonce, permissions, participation, and action-specific authority immediately before every effect.

Purge-all is accepted-terminal: publish the terminal response, stop authority, and only then delete the mailbox subtree. The UI displays the accepted terminal outcome and requires restart/reinitialize rather than pretending the project remains active.
