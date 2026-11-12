# MedClip browser acceptance harness

These files are manual acceptance tooling and are not imported by Next.js, app
runtime code, or Edge Functions. The retained R11E runner is intentionally
separate from product modules.

## Teardown smoke

Run after `out/` exists:

```powershell
node scripts/acceptance/v24abc-r11e.mjs --teardown-smoke
```

The harness starts its own loopback-only static server with a free port, checks
`GET /editor` returns 200, then launches the installed Microsoft Edge through
Playwright `launchServer`. Playwright owns an isolated browser process, profile,
and context. Set `MEDCLIP_EDGE_EXECUTABLE` or `MEDCLIP_PLAYWRIGHT_MODULE` only if
automatic executable/module resolution is unavailable. Cleanup closes owned
pages, context, browser server, and child static server with bounded waits and
checks their exact process handles. It does not search for or kill other Edge
processes.

## G2-A setup smoke

After `out/` exists and `.env.local` contains `MEDCLIP_TEST_USER_A_EMAIL`,
`MEDCLIP_TEST_USER_A_PASSWORD`, and the existing Supabase URL configuration, run:

```powershell
pnpm acceptance:g2a-smoke
```

The driver loads `.env.local` without printing values, signs in through the real
browser auth form, opens `/editor`, expands the actual `details` section named
Advanced Settings, opens the requirement dialog, and fills a campus requirement.
It stops before submitting Creative Intent. A failure in browser setup,
authentication setup, or selector setup is reported as `HARNESS FAILURE`.

The provider-free route fixture allows only the exact Supabase password-token
POST (`/auth/v1/token?grant_type=password`) and authenticated user GET
(`/auth/v1/user`) needed for the smoke. It deliberately blocks and separately
reports these requests:

| Method | Exact path pattern | Fixture and reason |
| --- | --- | --- |
| `GET` | `/rest/v1/profiles?select=id,display_name,avatar_url,created_at&id=eq.<uuid>` | Auth profile isolation; avoid loading user profile data in provider-free acceptance. |
| `POST` | `/functions/v1/ai-tasks` | Provider-free AI task guard when no synthetic intent response is installed. |
| `POST` | `/functions/v1/ai-credentials` with action `save`, `update`, `delete`, or `test` | Read-only availability fixture; credential writes and validation calls are blocked. |

Credential `list` is fulfilled locally by the availability fixture and does not
reach Supabase. The availability fixture can expose only one supported provider
as connected. Every other Supabase or remote request is blocked and remains an
error. These expected blocks are listed as `EXPECTED FIXTURE BLOCKS`; they do
not hide unrelated console, page, rejection, HTTP, or network errors. Known
static-export `__next.__PAGE__.txt` 404 prefetch responses are reported as
`STATIC EXPORT PREFETCH NOISE`, separately from expected fixture blocks.
The same report category also includes only canceled (`net::ERR_ABORTED`)
loopback static-export HEAD prefetches and known generated `__next.*.txt` page
data prefetches; a failed remote request or unrelated local resource remains a
network error.

## R11E driver

The driver resumes at Gate 2 by default and runs gates G2-A through G2-R in
order. Full acceptance requires an acceptance-only scenario module supplied by
Session A:

```powershell
node scripts/acceptance/v24abc-r11e.mjs --resume-from=G2-A --scenario=<absolute-path-to-scenario.mjs>
```

The module may export `setup({ harness })`, `runGate({ id, label, completed,
harness, session })`, and `beforeTeardown({ harness, session })`. `runGate` must
perform only the named gate and should throw at the first freeze-gate defect;
the runner prints the last completed gate, first failed gate, user-visible
symptom, diagnostics, and worktree status, then closes all harness-owned
resources in `finally`. Gate G2-R is the final teardown gate. The runner makes
no product changes and does not auto-retry a failed gate. A scenario setup or
browser setup failure is `HARNESS FAILURE`; a gate failure without the
scenario's explicit `error.harnessFailure = true` marker is reported as a
product freeze-gate defect.

The reusable scenario evidence contract is exported by
`v24abc-r11e-scenario-contract.mjs` as `campusScenario`, `executionScenario`,
and `repairScenario`:

- `campusScenario` uses the existing
  `app/test-support/editor-constraint-negotiation-fixture.ts` campus project.
  Its only synthetic interception is the Creative Intent provider response;
  production constraint creation, feasibility, negotiation, and planning stay
  real. Confirm protected bindings and choose
  `OPTIMIZE_UNPROTECTED_ONLY` by semantic identity. The authoritative expected
  negotiation state is resolution `OPTIMIZE_UNPROTECTED_ONLY`, requested target
  `30000`, minimum feasible `38000`, target gap `8000`, planning state
  `READY_TO_PLAN`.
- `executionScenario` uses
  `app/test-support/editor-proposal-review-fixture.ts:createMedicalReviewInput`.
  It has existing `local-clip` segment concepts, confidence/usability,
  evidence-frame timestamps, caption concepts, and audio rhythm evidence. The
  scenario must invoke the production `generateEditorProposal` path and read
  its `planEvidence`; it must not inject proposals, actions, or evaluation
  results. `createMedicalReviewedExecution` documents five existing review
  rows supporting ACCEPT, REJECT, and MODIFY; MODIFY selects the trusted
  `asset-ecg-alt` alternative through `safeModificationCandidates`. For the
  constrained execution contract, build the established production
  `createProtectedClipConstraintSet` for `clip-0` with asset replacement as
  its explicit permission, resolve the existing campus duration conflict to
  `READY_TO_PLAN`, bind that returned provenance to the real constraint set,
  then call `generateEditorProposal`. This retains a protected clip and four
  unprotected editable clips while leaving real canonical asset-match actions
  available. The compatibility pattern is also covered by
  `app/editor-proposal-negotiation.test.ts`.
- `repairScenario` follows the repository's controlled
  `semanticDefectScenario` in `app/editor-repair.test.ts`: the existing medical
  repair fixture lowers confidence on the existing `asset-ecg` local semantic
  evidence, then runs the production evaluator and repair proposal builder.
  Its expected repairable defect is `LOW_SEMANTIC_SUPPORT` on `interval-ecg`.
  The fixture's established trusted alternatives include `asset-ecg-alt` and
  `asset-ecg-alt-2`. Do not inject a defect, evaluator result, repair result,
  or canonical action.

Retained scenario modules should expose `setup`, `runGate`, and
`beforeTeardown` as above. The setup should load campus, execution, and repair
evidence from these named contracts; `runGate` should drive only the gate's
visible UI and assert production diagnostics/project state. Evidence audit can
be checked without a browser with:

```powershell
node --experimental-strip-types -e "import('./scripts/acceptance/v24abc-r11e-scenario-contract.mjs').then(m => console.log(JSON.stringify(m.auditR11EScenarioContracts())))"
```

The durable retained freeze scenario is repository-tracked at
`scripts/acceptance/v24abc-r11e-r9y-scenario.mjs`. It resolves campus,
execution, repair, and owned-media contexts from the stable gate ID and can be
loaded directly by the retained driver without a temporary scenario file:

```powershell
node scripts/acceptance/v24abc-r11e.mjs --scenario=scripts/acceptance/v24abc-r11e-r9y-scenario.mjs
```

Use `--resume-from=<gate>` for a bounded later-gate run. The scenario rebuilds
the required fixture/current-document media state for the selected phase; it
does not use a global phase counter or retain a Blob URL across documents.

The runner loads repository `.env.local` without printing values. Do not put
credentials in scenario source. Provider-free routing blocks all remote
origins, blocks credential actions other than read-only `list`, and blocks AI
task requests unless the scenario explicitly installs the synthetic intent
fixture. The availability fixture accepts one supported provider in `connected`
state only. Synthetic intent responses are rejected if they include downstream
ConstraintSet, feasibility, proposal, safe-no-change, evaluator, or repair
fields. No actual credential mutation is performed.

## Harness contracts

- Diagnostics are enabled before navigation with
  `window.__MEDCLIP_ACCEPTANCE_DIAGNOSTICS__ = true`. Ordered
  `medclip:acceptance-diagnostic` events are sanitized and bounded in the
  harness-owned `window.__MEDCLIP_ACCEPTANCE_DIAGNOSTIC_BUFFER__`.
- Project comparison reads only `medclip-editor-draft-v1`, the persisted
  authoritative EditorProject. Canonical snapshots and SHA-256 fingerprints
  omit `updatedAt`, matching the R10C material-project identity contract.
- `selectNegotiationOption(page, 'OPTIMIZE_UNPROTECTED_ONLY')` resolves by
  accessible semantic text and requires one unique match; it does not use DOM
  position. `waitForNegotiationState` checks authoritative diagnostic fields.
- `console.error`, `pageerror`, and `unhandledrejection` are collected. Known
  static-export `__next.__PAGE__.txt` 404s are classified separately; other
  errors remain visible in the report. Reports separate expected fixture
  blocks, static export prefetch noise, unclassified console errors, page
  errors, unhandled rejections, network failures, HTTP failures, unexpected
  blocked requests, and critical runtime errors.

The teardown smoke and G2-A setup smoke are the only browser runs in this
harness correction phase. Neither executes the full R11E gates.
