# Safari Extension — Build, Fix, Real E2E — Design

**Date:** 2026-08-10
**Repo:** `linkedin-affinity-extension` (this Mac)
**Status:** design approved (Bert 2026-08-10: "make sure the extension is working
properly, it needs updating and a good e2e test", "military-grade", "the Apple way")
**Related:** `sanctum-crm` headless auto-create — this is its Bert-in-the-loop twin.

## Problem

The Safari extension is built from code **identical** to the canonical Chrome
`Extension/` (verified: `content.js`, `background.js`, `manifest.json`, `popup.js`
byte-for-byte the same), but it has never been compiled or installed — no built app
in `/Applications`, not enabled in Safari. Its e2e test (`tests/e2e/full-workflow.test.js`)
exists and is well-structured but does not run under the current jest config. Bert
wants it working, updated, and covered by a real end-to-end test. This is the manual
"I'm reading this thread → send it to Affinity" path; it auto-creates the business
contact with Bert's explicit judgment as the work signal.

## What the extension already does (verified in `background.js` / `content.js`)

- `content.js` enriches the counterparty via **Voyager in-page**
  (`/voyager/api/identity/dash/profiles?q=memberIdentity…FullProfileWithEntities-93`)
  — same real-session technique as the Mini harvest — yielding all-companies, titles,
  industry.
- `background.js`: `findPerson` → `createPerson` (Affinity **v1** `POST /persons`,
  Basic auth, key in `storage.sync.affinityApiKey`) → `findOrganization`/
  `createOrganization` for every company in work history → attach the conversation as
  a note. `createPersonAndSend` is the full flow. Daily-cap + duplicate detection present.

## Scope — three workstreams

### 1. Build & load (Xcode / Safari)
- Compile `LinkedIn Affinity.xcodeproj` with `xcodebuild` (scheme "LinkedIn Affinity",
  Release), resolve any signing to the ASC identity in the signing runbook.
- Load in Safari (Developer → Allow Unsigned / enable extension), verify the content
  script injects on `https://www.linkedin.com/messaging/*` and the popup reads/writes
  `affinityApiKey`.
- Confirm the `SafariWebExtensionHandler` (`Script.js`, 22 lines) passes messages.

### 2. Fix & update
- **Voyager decoration staleness:** `FullProfileWithEntities-93` may be retired.
  Verify it still returns work history against a live profile; if not, capture the
  current decorationId and update (self-heal note in code).
- **Safari `storage.sync`:** Safari's `storage.sync` differs from Chrome's; confirm
  the API key persists across restarts; fall back to `storage.local` if needed
  (`background.js` already reads both).
- **Manifest/version:** bump `version`; confirm MV3 background service worker runs
  under Safari's model.

### 3. Real E2E test (the core ask)
- Promote `tests/e2e/full-workflow.test.js` to its **own jest project** (node env,
  `testMatch: ['**/tests/e2e/**/*.test.js']`) so it doesn't run under jsdom and isn't
  swept into the default unit run.
- **Credentials from Keychain**, never pasted: a small `tests/e2e/creds.js` reads
  `affinity-api-key`, `linkedin-li-at`, `linkedin-jsessionid` via `security
  find-generic-password` (the same services `sanctum-crm` uses), with env-var
  fallback for CI.
- **Skips, never fails, when creds absent** (`test.skip` guard) — CI-safe, no red
  herring.
- **Test-prefixed data + guaranteed cleanup:** all created entities carry `[E2E-TEST]`;
  `afterAll` deletes tracked `createdPersonIds`/`createdOrgIds`/`createdNoteIds` even
  on failure.
- **Coverage:** Voyager enrich → createPerson → link orgs → add note → duplicate
  detection (second send is a no-op) → cleanup verifies deletion.
- Optional **Safari load smoke** via the existing `LinkedIn AffinityUITests` XCUITest
  target: launch Safari, assert the extension injects the Affinity affordance on a
  messaging page (best-effort; gated behind a `RUN_UI=1` flag).

## Military-grade properties

| Property | Mechanism |
|---|---|
| No secrets in code | Keychain-sourced creds; `.env`/pasting forbidden; nothing committed. |
| No test pollution | `[E2E-TEST]` prefix + guaranteed teardown; runs against a throwaway/marked set. |
| Deterministic CI | Unit/logic tests (jsdom) stay hermetic; e2e skips without creds. |
| Signed artifact | Release build signed + (if distributing) notarized per the ASC runbook. |
| Parity with headless | Same Voyager technique + same Affinity v1 create logic as `sanctum-crm` push — one behavior, two surfaces. |
| Reproducible build | `build-and-distribute.sh` documented; xcodebuild invocation pinned in the plan. |

## Testing layers

- **Unit (jsdom, existing):** `tests/*.test.js` — pure logic, mocked `browserAPI`.
- **Integration (node, existing):** `tests/integration/affinity-api.test.js` —
  Affinity client shape.
- **E2E (node, new project):** `tests/e2e/full-workflow.test.js` — live round-trip,
  Keychain creds, self-cleaning.
- **UI smoke (XCUITest, optional):** extension actually injects in Safari.

## Out of scope

- Rewriting the extension logic (it's the reference implementation — harden, don't
  replace).
- Chrome Web Store / App Store submission (build + local load + e2e now; distribution
  is a separate pass via `PUBLISH-GUIDE.md`).

## Open risk (acknowledged)

Safari's MV3 support lags Chrome's; if the background service worker misbehaves under
Safari, the fallback is an event page or the persistent-background shim — the plan
carries a decision point after the first Safari load, with the observed behavior
logged rather than assumed.
