# Self-evolve Control Center UX Contract

This document is the normative native UX contract for Self-evolve Release B.
It defines presentation and navigation only. Server-authored projections and
fresh server-side validation remain the authority for every effect. The TUI
must never derive permission from what it renders.

## Product promise

At every point, the native UI answers five questions without requiring other
documentation:

1. What is Self-evolve doing?
2. Why is it waiting?
3. What needs attention?
4. What did it recommend or change?
5. What can I safely do next?

The primary navigation has exactly four sections, in this order:

1. **Home**
2. **Recommendations**
3. **Activity**
4. **Settings**

Overview, Reviews, Safety, Evidence, Health/Budgets, Maintenance, and Help are
not primary destinations. Their useful content moves into the four sections.

## Shared language

Primary copy uses these human labels. Stored keys and protocol values may
appear only as secondary technical detail.

| Concept | Primary label | Meaning |
|---|---|---|
| `manual` | On demand | Self-evolve analyzes only when the user runs the headless scan command. |
| `auto` | Recommend automatically | Self-evolve may analyze at safe idle points and prepare recommendations, but cannot apply them without approval. |
| `yolo` | Apply automatically (YOLO) | Self-evolve may apply an eligible allowlisted recommendation only after every consent, evidence, safety, budget, and rollout gate passes. |
| durable observations | Saved structured patterns | Bounded structured facts retained for evidence; never transcript text. |
| passive provider calls | Background AI analysis | Hidden analysis that may run at safe idle points when consent and budget allow it. |
| allowlist | Approved skill folders | The only canonical skill roots eligible for writes. |
| circuit breaker | Paused after repeated failures | Automatic work stopped after repeated failures and requires recovery or reset. |
| bootstrap/boot health | Startup checks | Host, state-root, schema, recovery, and compatibility checks that must finish before native authority is available. |
| repository exclusion | Disabled for this project | Global behavior remains configured, but this project cannot run autonomous work. |
| valid synthesis no-op | No useful change found | Analysis completed successfully and found no safe improvement worth proposing. |

Do not use "failed", "error", or warning styling for a valid no-change
analysis, no new observations, or evidence that is not eligible yet.

## One shared operational model

The sidebar, header, and Home use the same pure operational view model. The
first matching row wins. They may vary in detail but must not disagree about
state, explanation, or primary next action. The operational destination follows
the table below. The sidebar entry destination follows the Sidebar contract;
only on-demand entry differs, opening Home while its explicit mode-setting
action remains in Settings.

| Priority | State | Primary copy | Explanation | Destination | Primary next action |
|---:|---|---|---|---|---|
| 1 | Terminal shutdown or purge-all accepted | Restart required | Self-evolve stopped authority after accepting a full purge or terminal shutdown. | Home | Restart OpenCode. |
| 2 | Corrupt or unsupported state/protocol/host | Self-evolve needs recovery | Stored state, protocol, or host compatibility cannot be trusted, so autonomous work is off. | Activity, Errors | Inspect the bounded error and use the offered recovery action. |
| 3 | Emergency stop on | Emergency stop is on | All autonomous provider and write authority is disabled. | Settings | Turn off Emergency stop only after reviewing the reason. |
| 4 | Circuit breaker open | Paused after repeated failures | Repeated failures stopped automatic work. | Activity, Errors | Review failures, then reset when safe. |
| 5 | Paused | Self-evolve is paused | Scheduling is paused without changing configured mode or consent. | Home | Resume. |
| 6 | Repository excluded | Disabled for this project | Global settings remain intact, but this project is excluded. | Settings | Include this project if automatic work is wanted here. |
| 7 | Effective mode is manual | Runs on demand | Manual mode runs only explicit scans. Auto mode also needs Background analysis and Saved observations consent. | Settings / mode | Choose Auto and enable both required consents, or run `/self-evolve scan` on demand. |
| 8 | Required setup missing | Setup needed | The current mode lacks one or more consent, provider, approved-folder, rollout, or host prerequisites. | Settings | Complete the first missing prerequisite. |
| 9 | Work in flight | Analysis in progress / Applying safely | One admitted cycle or operation is active. | Home | Wait; the mounted view updates in place. |
| 10 | Backoff active | Waiting after a failure | Automatic work will retry after the bounded backoff. | Activity | Review the last failure or wait until the shown time. |
| 11 | Budget exhausted | Budget used for now | The relevant rolling or daily budget has no remaining capacity. | Home | Wait until the shown reset time. |
| 12 | Quiet period active | Quiet period | Automatic work is intentionally deferred until the shown time. | Home | Wait, or use an available on-demand path. |
| 13 | Recommendation needs review | Recommendation ready | A safe bounded recommendation is waiting for a decision. | Recommendations, selected item | Review the selected recommendation. |
| 14 | Applied result needs acknowledgement | Change applied | A verified Self-evolve change has not yet been acknowledged locally. | Recommendations, selected item | Review and acknowledge or undo while eligible. |
| 15 | Startup checks pending | Starting Self-evolve | Compatibility and state checks are still running; no authority is available yet. | Home | Wait for Startup checks. |
| 16 | Healthy auto/yolo | Ready | Self-evolve is ready and will act only within the displayed mode and safeguards. | Home | No action required. |

Within priority 8, missing prerequisites use this stable order: supported host
and validated state root; usable provider; required consent; included project;
non-empty approved skill folders; YOLO rollout and confirmation gates. The UI
shows all blockers but offers only the first as the primary action.

A recommendation or applied acknowledgement may be shown as secondary
attention while a higher-priority operational blocker is active. It must not
hide terminal, corruption, emergency, breaker, pause, exclusion, or setup
state.

## Sidebar contract

The sidebar is a persistent entry point in startup, healthy, and attention
states. It is never removed merely because there is no recommendation.

The card contains, in order:

- the product label, **Self-evolve**;
- one bounded operational summary from the shared model;
- one bounded explanation or relevant count/time;
- one explicit action hint, such as `Open Home` or `Review recommendation`.

Click and focused Enter open the exact sidebar entry destination:

- setup opens **Settings** at the first unmet prerequisite;
- recommendation or applied attention opens **Recommendations** with the item
  selected;
- corruption, breaker, backoff, and failure open **Activity** filtered to
  **Errors**;
- healthy, startup, in-flight, paused, budget, quiet-period, and on-demand
  states open **Home**.

For on-demand state, this Home deep link applies equally to pointer click and
focused Enter or Space. Explicit actions that change global or repository mode
continue to open **Settings** at the mode controls.

The normal path never opens a separate state-dependent review dialog. The
Release A dialog was retained only until Recommendations reached equivalent
queue, detail, actions, focus, and outcome behavior; Release B removes it from
normal routing. Background refresh never opens a route, dialog, or
notification.

## Route and shell contract

The route accepts only bounded validated parameters:

- `section`: `home`, `recommendations`, `activity`, or `settings`;
- `recommendation`: an opaque projected selection token, used only if present
  in the current project projection;
- `activityFilter`: `all`, `recommendations`, `system`, or `errors`;
- an optional settings anchor from a closed renderer-owned list.

Missing, malformed, stale, or cross-project parameters fall back to Home
without causing an effect. Opening the palette command without parameters
opens Home. Replacing a deep link does not add nested history entries.

The header is always visible and contains:

- **Self-evolve**;
- current operational state and human mode label;
- Pause or Resume only when currently granted;
- Emergency stop state and control only when currently granted.

Pause/Resume is an immediate reversible operation. Enabling Emergency stop is
immediate; disabling it uses a simple confirmation. Pending, accepted,
completed, stale, and failed outcomes remain inline in the mounted shell.

## Section contracts

### Home

Home is the default landing section. It shows, in this order:

1. current operational state, explanation, and one next action;
2. effective mode, global default, and this-project override;
3. on a fresh manual install, a Home setup card with separate confirmed actions
   for automatic recommendations and optional sanitized excerpts; otherwise,
   setup blockers with Settings deep links;
4. active operation or last cycle result;
5. recommendation/applied attention;
6. actual passive, synthesis, and storage usage beside configured limits and
   reset periods;
7. up to three recent non-diagnostic activity entries;
8. manual-mode guidance plus the separate source-session on-demand fallback.

The fallback copy is: **Run `/self-evolve scan` in the source session. This
OpenCode host cannot safely bind a native scan to the selected session.**

Distinct Home empty states are:

| Condition | Heading | Explanation |
|---|---|---|
| no activity retained | No activity yet | Self-evolve has not completed a retained cycle for this project. |
| evidence below threshold | Still learning | Saved structured patterns are not yet strong or independent enough for a recommendation. |
| background analysis disabled | Background analysis is off | Current mode or consent prevents passive provider calls. |
| paused | Self-evolve is paused | Existing records remain available; no automatic cycle will start. |
| excluded | Disabled for this project | Global settings are unchanged; this project is excluded. |
| valid no-change | No useful change found | The last analysis completed successfully and found no safe improvement worth proposing. |
| old server | Limited view | Review data is available, but activity, actual usage, and enhanced readiness require an aligned server. |

### Recommendations

Recommendations is a complete queue and detail workspace.

Queue filters are **Needs review**, **Applied**, **Dismissed**, and **All**.
Each row shows bounded human rationale, safe target label, state, risk, relative
time, evidence count, and attention marker. Raw proposal IDs, hashes, canonical
paths, and state-root identity are not row copy.

Selecting a row loads that detail and at most the adjacent details permitted by
the existing two-resident-detail cap. The detail order is:

1. Why this was suggested
2. Proposed change
3. Evidence
4. Safety checks
5. Token impact
6. Rollback
7. Technical details, collapsed by default

Only freshly server-projected actions render. The lifecycle may include Apply,
Reject, Snooze, Acknowledge, Undo, and Open in Activity. Pending, accepted,
completed, stale, and failed states replace or disable the affected action
inline without dismissing the detail.

If the selected dashboard sidecar advertises `decision-feedback-v1`, Reject may add one reason:
**Incorrect evidence**, **Already covered**, **Wrong scope**, **Too specific**,
**Not worth the token cost**, or **Other** with bounded optional text. Feedback
is audit-only and never becomes evidence. Without the capability, Reject uses
the legacy exact decision request.

Empty states are **No recommendations yet**, **Nothing needs review**,
**Nothing applied**, and **Nothing dismissed**. A degraded projection keeps
valid core review data usable and labels unavailable enhanced fields.

### Activity

Activity is a bounded semantic history, not a raw log viewer.

Filters are **All**, **Recommendations**, **System**, and **Errors**.
Diagnostic-audience entries are excluded from All. Every row has a text marker
in addition to color, relative time, plain-language outcome, safe target label
when applicable, and a deep link when the current projection supports one.

Allowlisted activity categories are:

- cycle outcome: no new cursor, no observations, not eligible, valid no-change,
  recommendation created, applied, deferred, failed closed, or failed;
- recommendation decision: approved/applied, rejected, snoozed, acknowledged,
  superseded, rolled back, or rollback unavailable;
- scheduling: quiet period, passive or synthesis budget, backoff, breaker trip,
  breaker recovery, pause, resume, exclusion, or inclusion;
- lifecycle: startup, bootstrap, recovery, provider readiness, projection
  degradation, or terminal shutdown;
- maintenance: export completed/expired/failed, scoped purge completed, or
  purge-all accepted-terminal.

Technical expansion may show only allowlisted bounded reason, status, protocol,
host, and plugin-version fields. It never shows generic audit details.

When activity was truncated, the section states that older entries were
omitted by the bounded projection and points to the existing sensitive export
for complete classified records. Empty states distinguish no retained activity,
no match for the selected filter, old-server limited view, malformed enhanced
projection, and temporarily unavailable refresh.

The diagnostics panel shows:

- projection refresh time and core/enhanced protocol status;
- host and plugin version plus bounded source label;
- scheduler, watcher, backoff, breaker, and in-flight state;
- actual used and remaining passive/synthesis budgets;
- actual storage usage and configured quota;
- one last bounded allowlisted error.

### Settings

Settings is ordered as Modes, Privacy and scope, Approved skill folders, Limits
and retention, Maintenance, then a compact version/help footer.

#### Mode cards

| Label | What happens | Provider use and saved data | Write authority | Why change it |
|---|---|---|---|---|
| On demand | Runs only from a source-session scan command. | No passive calls or passive writes; an invoked scan may save bounded structured observations. | Requires an explicit decision for each apply. | Choose maximum control or hosts without passive setup. |
| Recommend automatically | Analyzes at safe idle points and prepares recommendations. | Requires Background AI analysis and the relevant Saved structured patterns consent. | Cannot apply without explicit approval. | Choose proactive review without automatic writes. |
| Apply automatically (YOLO) | May analyze, recommend, and apply only after every gate passes. | Same provider/data requirements as automatic recommendations. | Restricted to Approved skill folders, deterministic validation, critic approval, budgets, rollout history, and fresh server authority. | Choose hands-off application only after accepting the expanded risk. |

The UI shows **Global default**, **This project**, and **Effective mode**
together. This-project choices are Inherit global default, On demand, Recommend
automatically, or Apply automatically (YOLO). YOLO is unavailable with its
blockers listed until all prerequisites pass.

#### Privacy and scope settings

| Primary label | Stored key | Scope | Dependency/effect | Why change it |
|---|---|---|---|---|
| Include this project | `repo.excluded` (inverse) | This project | Exclusion overrides any automatic global mode. | Stop or permit autonomous work in only this checkout. |
| Background AI analysis | `passiveCalls` | Global | Required for automatic hidden provider calls; does not itself allow durable evidence or writes. | Control passive provider use. |
| Saved structured patterns | `durableObservations` | Global | Required for passive structured observations; never stores transcripts. | Control whether learning persists across sessions. |
| Sanitized evidence excerpts | `sanitizedExcerpts` | Global | Optional bounded evidence text; redaction is not a secrecy guarantee. Required by cross-project learning. | Allow richer evidence with an explicit privacy tradeoff. |
| Cross-project learning (not active yet) | `crossRepoAggregation` | Global | No production path currently consumes cross-project claims. An already-enabled stored value may be turned off, but the UI does not offer activation until the capability is active. | Avoid implying an inert privacy control provides working cross-project learning. |
| Emergency stop | `killSwitch` | Global | Overrides every automatic mode and provider/write path. | Immediately stop autonomous authority. |
| Pause automatic work | `paused` | Global | Temporarily stops scheduling without changing mode or consent. | Temporarily stop automatic work while preserving configuration. |

Consent is never enabled as a side effect of choosing a mode. Dependencies and
the resulting effective mode are visible before confirmation.

The fresh-install Home card follows the same rule: **Turn on automatic
recommendations** changes only the global mode, while **Allow sanitized
excerpts** is an adjacent, separately armed and confirmed privacy choice.

#### Approved skill folders

Display one canonical folder per row with Add and Remove. Validate containment,
canonical form, symlinks, duplicates, supported roots, and the resulting
non-empty requirement inline. Raw paths appear only in this editor and in its
exact confirmation. Replacing the list requires the exact phrase displayed by
the server-projected operation.

#### Limits and retention

Limits are read-only in Release B. Show actual and configured values together:
passive calls per rolling hour and reset, synthesis per day and reset, storage
bytes and quota, observation retention, proposal/audit retention, concurrency,
quiet periods, and YOLO rollout progress. Explain what each limit bounds and
whether changing it requires startup configuration. Do not introduce a general
numeric settings API.

#### Maintenance

One scope selector offers **Observations**, **Recommendations**,
**This project**, or **Everything**. Available actions are Export or Delete as
granted. Sensitive export shows private path metadata, size, hash, and expiry
without opening the file. Purge-all reports **Accepted; restart required** and
the TUI stops authority before the mailbox subtree is deleted.

## Interaction and layout

- Tab and Shift+Tab move through visible controls in a stable order.
- Left/Right changes primary section with wrap; Up/Down moves within queues and
  lists when that child owns focus.
- Enter/Space activates the focused control. Pointer click selects and
  activates the same semantics; hover alone has no effect.
- Every focused control has a non-color focus marker.
- Escape is owned by the active control-center mode, not a root renderable.
  Child dialogs close first; otherwise Escape restores the exact route that was
  active before the control center opened. It must work from inputs, buttons,
  queues, scroll views, and confirmation dialogs.
- Route replacement and project switching clear stale selection, pending local
  presentation state, and incompatible deep-link parameters before render.
- A narrow terminal uses one column: navigation becomes a wrapped four-item
  strip, list precedes detail, tables become labeled rows, and actions wrap
  without horizontal scrolling. At approximately 64x20, the state, next action,
  section label, and focused control remain visible.
- Long rationale, evidence, errors, diffs, and folders are bounded before
  rendering, wrap without corrupting layout, and disclose deterministic
  truncation. Diffs may scroll inside their detail region.
- Loading retains the shell and announces the section being refreshed. A
  refresh error keeps the last validated immutable snapshot, labels it stale,
  disables expired actions, and offers Retry. Malformed enhanced data degrades
  only enhanced views; malformed core projection removes native authority.

No flow emits proposal/status/settings toasts, attention notifications,
polling-triggered dialogs, or automatically opened routes.

## Confirmation tiers

| Tier | Behavior | Actions |
|---|---|---|
| Immediate | Execute once through the current grant and show lifecycle inline. | Pause, Resume, enable Emergency stop, snooze, acknowledge, open/deep-link, risk-reducing mode or consent changes. |
| Simple confirm | Explain the additional authority or privacy exposure and require Confirm/Cancel. | Disable Emergency stop; enable a consent; change On demand to Recommend automatically; other risk-increasing non-destructive scope changes. |
| Exact typed confirm | Display the exact server-required phrase and affected scope. | Approved skill folder replacement, destructive purge, purge-all, sensitive export where already required, and any change that grants Apply automatically (YOLO) authority. |

Reject is immediate unless optional free-text feedback is present, in which
case submission remains one explicit action. Apply uses the existing explicit
review action and server grant; the proposed diff and safety facts must remain
visible. Undo is immediate only while the current projection says rollback is
safe and granted.

## Privacy and trust boundary

Home, sidebar, Recommendations, Activity, diagnostics, errors, and export
metadata must not display or project:

- transcript or message text;
- raw host session/message IDs;
- proposal IDs, request IDs, nonces, hashes, project fingerprints, or
  state-root identity as primary UI;
- raw state-root paths or canonical allowlist paths outside the high-risk
  Approved skill folders editor;
- arbitrary audit detail objects, provider errors, secrets, prompts, or model
  output;
- any field that grants authority.

Activity is built only from exact allowlisted semantic events. Summary strings
are bounded before publication. Technical details remain bounded and
allowlisted. The sensitive export is the explicit path for complete classified
records.

## Compatibility

- `dashboard-v2` and its `dashboard-v1` compatibility sidecar are optional and additive beside the unchanged v1 review index.
- The v1 offer and index retain the exact Release A capability vocabulary.
  Release B capabilities are exact fields inside the dashboard sidecar.
- A current TUI prefers v2 and falls back to an old server's v1 sidecar without
  rejecting independently bounded v1 retention values.
- An older dashboard TUI with a current server continues to read the v1
  compatibility sidecar; the existing review, grant, mailbox, headless, and
  recovery contracts remain unchanged.
- A missing dashboard is compatible. A malformed, newer, stale, wrong-project,
  wrong-root, wrong-generation, or wrong-index dashboard is rejected for
  enhanced presentation without invalidating an otherwise valid core review
  projection.
- Structured rejection feedback and repository mode override render only when
  their exact dashboard capabilities are advertised. Their absence uses legacy Reject
  and hides repository-mode editing respectively.
- Headless commands, including manual scan and recovery controls, remain
  compatibility paths. Normal native navigation does not depend on slash
  commands except the explicitly explained source-session manual scan.

## Acceptance checklist

Release B native UX is not complete until current evidence proves:

- exactly four primary sections and Home default routing;
- one shared operational model across sidebar, header, and Home;
- every precedence state, destination, and next action above;
- recommendation queue/detail/action parity and removal of the normal
  ReviewDialog path;
- bounded privacy-safe activity and truthful actual usage;
- settings labels, descriptions, scope, dependencies, and confirmation tiers;
- keyboard, pointer, narrow layout, long text, route replacement, project
  switch, and exact Escape restoration;
- missing/malformed/mixed-version degradation without added authority;
- deterministic checks and real operator evidence recorded as separate gates.
