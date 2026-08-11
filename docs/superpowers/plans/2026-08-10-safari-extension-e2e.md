# Safari Extension — Build/Fix/E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and load the Safari extension, verify/refresh its Voyager enrichment, and make `tests/e2e/full-workflow.test.js` a real, self-cleaning, Keychain-authenticated end-to-end test.

**Architecture:** The extension code is identical to the canonical Chrome `Extension/`. Work is (1) a runnable node jest e2e project with Keychain creds and guaranteed cleanup, (2) an `xcodebuild` + Safari load, (3) a Voyager decoration verify. No extension logic rewrite — harden, don't replace.

**Tech Stack:** Jest (jsdom + node projects), Node 18+ (global `fetch`), macOS `security` Keychain, Xcode `xcodebuild`, Safari Web Extensions (MV3).

## Global Constraints

- Base branch: `feat/safari-e2e`.
- No secrets in code or committed files; e2e creds via Keychain (`affinity-api-key`, `linkedin-li-at`, `linkedin-jsessionid`) with env fallback.
- E2e **skips** (not fails) when creds absent — CI-safe.
- All e2e-created Affinity entities carry `[E2E-TEST]` and are deleted in `afterAll`, even on failure.
- Unit/logic tests stay hermetic (jsdom, mocked `browserAPI`).
- Affinity v1 Basic auth (`":"+apiKey`), same as the extension.

---

### Task 1: Node e2e jest project (isolation)

**Files:**
- Modify: `jest.config.js`
- Modify: `package.json` (add `"test:e2e"` script)

**Interfaces:**
- Produces: `npm run test:e2e` runs only `tests/e2e/**`, in node env; `npm test` unchanged (excludes e2e).

- [ ] **Step 1: Failing check** — `npx jest --selectProjects e2e --listTests` → error (no e2e project).
- [ ] **Step 2: Implement** — add a third project to `jest.config.js`:

```js
{ displayName: 'e2e', testEnvironment: 'node', testMatch: ['**/tests/e2e/**/*.test.js'] }
```

and exclude `tests/e2e/` from the default jsdom project's `testMatch`. Add `"test:e2e": "jest --selectProjects e2e"` to `package.json`.
- [ ] **Step 3: Verify** — `npx jest --selectProjects e2e --listTests` lists `full-workflow.test.js`; `npm test` no longer runs it.
- [ ] **Step 4: Commit** (`test: isolate e2e into a node jest project`)

---

### Task 2: Keychain creds loader with skip guard

**Files:**
- Create: `tests/e2e/creds.js`
- Test: `tests/e2e/creds.test.js`

**Interfaces:**
- Produces: `loadCreds() -> {affinityApiKey, liAt, jsessionid}` (Keychain via `security find-generic-password -w -s <svc> -a sanctum`, env fallback `AFFINITY_API_KEY`/`LINKEDIN_LI_AT`/`LINKEDIN_JSESSIONID`); `haveCreds() -> boolean`.

- [ ] **Step 1: Failing test**

```js
const { haveCreds } = require('./creds');
test('haveCreds is a boolean', () => { expect(typeof haveCreds()).toBe('boolean'); });
```

- [ ] **Step 2: Run — FAIL** (module missing).
- [ ] **Step 3: Implement** `creds.js` — read each secret via `child_process.execFileSync('security', [...])` in try/catch, fall back to env; `haveCreds()` true iff `affinityApiKey` present. Never log values.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit**

---

### Task 3: Wire e2e to creds + guaranteed cleanup

**Files:**
- Modify: `tests/e2e/full-workflow.test.js`

- [ ] **Step 1:** Replace `process.env.*` credential reads with `loadCreds()`; wrap the suite in `(haveCreds() ? describe : describe.skip)`.
- [ ] **Step 2:** Ensure `afterAll` deletes every tracked `createdPersonIds`/`createdOrgIds`/`createdNoteIds` (DELETE `/persons/:id` etc.), tolerant of already-deleted (404 ok).
- [ ] **Step 3: Verify skip path** — with no creds/env, `npm run test:e2e` reports the suite **skipped**, exit 0.
- [ ] **Step 4: Commit** (`test(e2e): keychain creds + guaranteed cleanup + skip-without-creds`)

---

### Task 4: Green live round-trip

**Files:** (none — execution + evidence)

- [ ] **Step 1:** Confirm creds present (`security find-generic-password -s affinity-api-key -a sanctum` exists; `linkedin-cookie-refresh.py` has populated li_at/jsessionid).
- [ ] **Step 2:** Run `npm run test:e2e`. Expected: Voyager enrich → createPerson → link orgs → note → duplicate-detection (2nd send no-ops) → cleanup, all green.
- [ ] **Step 3:** If Voyager enrich fails, jump to Task 6 (decoration refresh), then re-run.
- [ ] **Step 4:** Capture the passing output into the PR description. No commit (or commit a `tests/e2e/README.md` run-guide).

---

### Task 5: Build & load the Safari app

**Files:**
- Verify/Modify: `LinkedIn Affinity/LinkedIn Affinity.xcodeproj`, `build-and-distribute.sh`

- [ ] **Step 1:** List schemes — `xcodebuild -list -project "LinkedIn Affinity/LinkedIn Affinity.xcodeproj"`.
- [ ] **Step 2:** Build — `xcodebuild -project "LinkedIn Affinity/LinkedIn Affinity.xcodeproj" -scheme "LinkedIn Affinity" -configuration Debug build` (resolve signing to the ASC identity; `CODE_SIGNING_ALLOWED=NO` for a local dev build if needed). Expected: BUILD SUCCEEDED.
- [ ] **Step 3:** Enable in Safari (Develop → Allow Unsigned Extensions; enable "LinkedIn Affinity"); on `linkedin.com/messaging` confirm the content script injects and the popup reads/writes `affinityApiKey`. Record observed MV3 background behavior (service worker vs event page) per the spec's open-risk note.
- [ ] **Step 4: Commit** any signing/config fix (`build: Safari extension builds + loads locally`).

---

### Task 6: Verify/refresh Voyager decoration

**Files:**
- Modify: `Extension/content.js` (+ mirror to `LinkedIn Affinity/.../Resources/content.js`)

- [ ] **Step 1:** With li_at/jsessionid, curl the decoration used by `content.js` (`identity/dash/profiles?...FullProfileWithEntities-93`) for a known profile; check it returns positions/work history (HTTP 200, non-empty `included`).
- [ ] **Step 2:** If stale (4xx/empty), capture the current decorationId from a logged-in `/in/<profile>` network trace and update the constant in both `content.js` copies (keep them byte-identical — a drift check exists).
- [ ] **Step 3:** Re-run `npm run test:e2e` → green.
- [ ] **Step 4: Commit** (`fix(content): refresh Voyager profile decoration` — only if changed).

---

### Task 7: PR

- [ ] **Step 1:** `npm test` (unit+integration) green; `npm run test:e2e` green with creds (or cleanly skipped without).
- [ ] **Step 2:** Open PR on the extension submodule branch `feat/safari-e2e`; body: what was built, the passing e2e output, and the observed Safari MV3 behavior.

## Self-Review

- Spec coverage: build+load(T5), decoration fix(T6), e2e node project(T1), keychain creds(T2), cleanup+skip(T3), live green(T4), PR(T7). Parity with headless push noted (same Voyager + v1 create).
- Placeholders: none (exact jest project block, exact xcodebuild invocation, exact security calls).
- Types: `loadCreds()`/`haveCreds()` names stable across T2/T3; `[E2E-TEST]` prefix + tracked-ID cleanup consistent.
