# Firebase SDK characterization suite (frozen MASTER PLAN #38)

Read-only characterization of the Firebase compat SDK surface production's
`script.js` actually calls, comparing the currently-loaded version
(`10.7.1`) against a candidate (`10.14.1`) across a real browser and real
local Firebase Emulators. Built for **variant C**: it does not vendor any
Firebase CDN bundle into this repository, does not touch production
runtime (`index.html`/`script.js`/`style.css`/`worker/`/production
Firebase Rules), and is designed to actually run in GitHub Actions later,
where Playwright Chromium/WebKit and the Firebase Emulator already work
(see `backend.yml`, `browser.yml`).

## Known environment limitation (as of this writing)

This suite cannot be executed end-to-end inside the interactive container
this suite was authored in. Two egress checks, run directly against that
container:

```
curl -sD - https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js
HTTP/2 403
x-deny-reason: host_not_allowed

curl -sD - https://storage.googleapis.com
HTTP/2 403
x-deny-reason: host_not_allowed
```

`gstatic.com` (needed to load the real SDK bundles) and
`storage.googleapis.com` (needed by `firebase-tools` to download the
Emulator JAR on first use) are both outside that container's egress
allowlist. `/root/.cache/firebase/emulators/` exists but is empty --
confirmed no cached JAR to fall back on. This is a property of that one
interactive container, not of this project's CI: `backend.yml` already
runs the Firebase Rules Emulator successfully today.

Confirmed a second way, more directly: `firebase-tools` was installed
for real via `npm ci` (an allowed registry) and an actual
`firebase emulators:start --only database --project demo-fbchar --config
tests/firebase-sdk-characterization/firebase.json` was run once. It
correctly read this suite's own `firebase.json`, correctly detected
`demo-fbchar` as a demo project, and got as far as attempting the JAR
download before failing with the CLI's own error, verbatim:

```
Error: download failed, status 403: Host not in allowlist: storage.googleapis.com.
Add this host to your network egress settings to allow access.
```

Because of this, only fully-local checks (syntax, structural, and the
token-minting helper's actual behavior) were verified while writing this
suite. See the bottom of this file for the exact list of what was and
was not verified, and how.

## Layout

```
tests/firebase-sdk-characterization/
  fixture.html                 - loads the 4 compat bundles, in production order, for a version given via ?sdkVersion=
  characterization.test.js     - Playwright runner: network guard, Auth/RTDB/App Check checks, one version x one engine per invocation
  run-matrix.mjs                - loops the full baseline/candidate x chromium/webkit matrix, prints one normalized comparison
  firebase.json                 - test-only Emulator config (Auth + Database, UI disabled); NOT production firebase config
  database.rules.json           - test-only, fully permissive Rules; NOT production firebase/database.rules.json
  helpers/mint-test-custom-token.mjs - local-only RS256 custom token minting (node:crypto, no new dependency)
  README.md                     - this file
```

`run-matrix.mjs` is not part of the five files originally proposed for
this suite. It was added because nothing else loops the four required
combinations (`10.7.1`/`10.14.1` x `chromium`/`webkit`) and produces the
side-by-side comparison the plan calls for; without it, running the
matrix means invoking `characterization.test.js` four times by hand and
diffing the JSON lines manually.

## How to run (once egress allows it, e.g. in GitHub Actions)

```bash
node tests/firebase-sdk-characterization/run-matrix.mjs \
  --baseline 10.7.1 --candidate 10.14.1
```

Or one combination at a time:

```bash
node node_modules/firebase-tools/lib/bin/firebase.js emulators:exec \
  --config tests/firebase-sdk-characterization/firebase.json \
  --project demo-fbchar --only auth,database \
  "SDK_VERSION=10.14.1 SDK_BROWSER_ENGINE=chromium node tests/firebase-sdk-characterization/characterization.test.js"
```

A bare `firebase emulators:exec` only resolves where `node_modules/.bin`
is already on PATH (inside an npm script, or via `npx --no-install
firebase ...`); the form above resolves the CLI regardless of PATH, and
is what `run-matrix.mjs` does internally. Note the inline
`SDK_VERSION=... node ...` prefix is POSIX shell syntax and is not valid
in `cmd.exe`: on Windows either set the variables separately
(`set`/`$env:`) or just use `run-matrix.mjs`, which passes them through
the child environment rather than the command string and is the
cross-platform path.

Requires `firebase-tools` and `playwright` (both already devDependencies)
and, for `webkit`, the browser engines installed the same way `browser.yml`
already does (`npx playwright install --with-deps chromium webkit`). No
`package.json` or workflow changes were made as part of this suite.

`run-matrix.mjs` locates the Firebase CLI through module resolution and
runs it with the current Node binary, rather than spawning a bare
`firebase`: `node_modules/.bin` is only on PATH inside an npm script, so
`node run-matrix.mjs` would otherwise fail with ENOENT. Verified by
resolving and executing `firebase-tools/lib/bin/firebase.js` directly.

## Determinism and timeouts

No gating check sleeps for a fixed interval. The RTDB `on()`/`off()`
check resolves the instant the listener delivers the expected value and
falls back to `SDK_LISTENER_TIMEOUT_MS` (default 20s) only on genuine
failure, detaching the listener exactly once either way, so a slow CI
runner costs latency rather than a false FAIL. There are two independent
ceilings, because one is not enough: `SDK_SUITE_TIMEOUT_MS` (default
240s) lives inside `characterization.test.js` and can only cover work
after the inner command has started, so a hang during emulator startup
(JAR fetch, port contention) would escape it entirely. `run-matrix.mjs`
therefore also applies an external per-combination timeout,
`SDK_COMBINATION_TIMEOUT_MS` (default 600s, or `--timeout-ms`), covering
the whole `emulators:exec` invocation including startup: SIGTERM, then
SIGKILL 15s later, with the combination recorded as `timedOut` and the
matrix exiting non-zero.

A combination counts as passed only if the inner report says `passed`,
the process exited 0, it was not killed, and the spawn itself succeeded:
the inner report can say `passed` while `emulators:exec` still fails
afterwards (teardown, port release), so the exit code is authoritative
alongside the report. For any combination that does not pass,
`run-matrix.mjs` surfaces the child's raw stdout/stderr in the
comparison (capped by `SDK_RAW_OUTPUT_LIMIT`, default 20000 chars) --
otherwise that output would be discarded when the child exits, which
would defeat capturing it.

## What gates the result

A run passes only if all three hold: every check in `GATING_PATHS` is
`true`, no network violation was recorded, and no uncaught page error was
raised before the reconnect probe. That last one gates deliberately --
`fixture.html` runs almost no code of its own, so an uncaught exception
during the characterized work is a real signal, and letting it through
would be a false PASS. Page errors raised by the offline/online toggle
afterwards are recorded separately under `advisory.probePageErrors` and
do not gate, since tearing the socket out from under RTDB can
legitimately raise one.

## 10.13 global-scope check

Between the baseline and the candidate, one release touches the very
mechanism this project uses to load the SDK: **10.13** made the compat
package check whether `firebase` is defined in the global scope
(firebase-js-sdk issue #8409). Nothing else in the 10.9.0-10.14.1 range
touches the Auth, RTDB, or App Check surface this project calls, which is
why this one gets a section of its own.

Production loads four separate `<script>` tags, each extending the single
global `firebase` object the first one creates. `fixture.html` reproduces
that exactly -- same four bundles, same order (`app` -> `database` ->
`auth` -> `app-check`), same CDN path -- and loads them strictly
sequentially, each waiting for the previous one's `onload`, because
loading them out of order or in parallel is the failure mode at issue.
An npm import would not exercise this at all.

Two gating checks cover it directly: `sdk.versionMatches` (the loaded
`firebase.SDK_VERSION` is exactly the version requested) and
`sdk.namespacesPresent` (`initializeApp`, `database`, `auth`, and
`appCheck` are all present on one global object, proving all four bundles
attached to the same `firebase`).

## Network guard

Exactly four absolute URLs are allowed -- the pinned bundles for the
version under test -- plus `127.0.0.1`/`localhost` for the fixture server
and the emulators. Any other request, including a different path or a
different version on `gstatic.com`, is recorded and aborted, and any
recorded violation fails the suite. `SDK_VERSION` must be an exact
`x.y.z` string, checked before the browser starts.

## Custom token: no production credentials

`helpers/mint-test-custom-token.mjs` mints a production-shaped RS256
custom token using a one-off RSA keypair generated in-process via
`node:crypto` -- never a real service-account key, never written to
disk, never reused across processes.

This is safe against the Auth Emulator specifically, confirmed by
Google's own documentation, quoted verbatim:

> "The Authentication emulator does not validate the signature or expiry
> of custom tokens. This allows you to use hand-crafted tokens and
> re-use tokens indefinitely in prototyping and testing scenarios."
>
> -- https://firebase.google.com/docs/emulator-suite/connect_auth#custom_token_authentication

RS256 was chosen for fidelity to what `worker/index.mjs`'s
`createFirebaseCustomToken()` produces in production, not because the
emulator requires it -- a much simpler HS256 or even-unsigned token would
be accepted identically by the emulator, per the same documentation.

Compat connection methods used (confirmed by fetching the official docs
directly, not from memory):

```
firebase.auth().useEmulator("http://127.0.0.1:9099")   // single URL string
firebase.database().useEmulator("127.0.0.1", 9000)      // host, port separately
```

## App Check: what this suite characterizes and what it does not

Per plan: no production site key, no reCAPTCHA, no production debug
token, no Google App Check backend. Confirmed directly from the fetched
source of `firebase-app-check-compat.js` (both 10.7.1 and 10.14.1, since
the compat wrapper code itself was read, not just documentation):
`.activate(provider, autoRefresh)` wraps any plain
`{ getToken: fn }`-shaped object into an internal `CustomProvider`
automatically -- exactly the pattern this suite uses -- and neither
`.activate()` nor an explicit `.getToken()` call makes any network
request when a CustomProvider is used; only `ReCaptchaV3Provider` /
`ReCaptchaEnterpriseProvider` touch the network.

**This suite explicitly does NOT characterize the production
`ReCaptchaV3Provider` path** (`.activate(realSiteKey, true)`), because
exercising it for real would require either a live call to Google's
reCAPTCHA/App Check backend or deep mocking of `window.grecaptcha`
internals. It characterizes compat App Check initialization/provider
plumbing only -- whether `firebase.appCheck()` exists, `.activate()`
doesn't throw, the provider is actually invoked, the token round-trips,
and the public surface (`setTokenAutoRefreshEnabled`, `onTokenChanged`,
`getToken`) is present and identical between versions. Production
reCAPTCHA behavior remains the responsibility of the real Telegram
manual smoke test.

## What this suite does NOT cover

- **Production `ReCaptchaV3Provider` App Check path** -- see above.
- **Deterministic offline/reconnect lifecycle.** `characterization.test.js`
  attempts a best-effort probe via Playwright's `context.setOffline(true/false)`,
  but it is recorded under `advisory.reconnect` and never gates the
  suite's pass/fail result. RTDB's own reconnect backoff timing combined
  with a browser-level network toggle was not judged reliably
  deterministic run to run, and `setOffline` is not supported on every
  engine (hence the `supported` flag in the report rather than a bare
  failure); a flaky gating check is worse than an honestly-scoped
  advisory one, and any error the toggle itself provokes is recorded
  separately under `advisory.probePageErrors`.
- **Real Telegram Android WebView / iOS WKWebView behavior** -- Chromium
  and WebKit are the closest automatable approximation, not a
  replacement; see the same caveat `browser.yml` already documents for
  the existing layout suite.
- **Everything outside the eight API-surface points listed in the plan**
  (Auth sign-in/uid/getIdToken; RTDB ref/set/update/once/on-off/
  transaction/push/child/remove/ServerValue.TIMESTAMP/.info/serverTimeOffset/
  onDisconnect; App Check plumbing) -- Elo, matchmaking, presence,
  rooms, and the rest of the game-specific invariants remain covered by
  the existing test suites and the real Telegram smoke test, not by this
  one.

## What was actually verified locally (no network required)

- `node --check` on all three `.mjs`/`.js` files: syntax valid.
- `firebase.json` and `database.rules.json`: valid JSON.
- `fixture.html`: the four bundle URLs appear in the exact order
  `firebase-app-compat.js`, `firebase-database-compat.js`,
  `firebase-auth-compat.js`, `firebase-app-check-compat.js` -- verified
  programmatically, not just visually.
- `mint-test-custom-token.mjs`: actually executed (not just read). Two
  tokens minted with different `uid`s decode to the correct, different
  `uid` claims; `exp - iat` is exactly 3600 seconds; the RS256
  sign/verify round-trip was independently confirmed valid using
  `node:crypto`'s own `sign`/`verify`.
- Firebase CLI resolution: `firebase-tools/lib/bin/firebase.js` resolved
  via `createRequire` and then actually executed with the current Node
  binary, printing `15.29.0`. Confirmed in the same session that a bare
  `firebase` is NOT on PATH, which is why the bare-spawn form was
  replaced.
- One real attempt to run the actual Emulator via this project's own
  `firebase-tools` (not just a `curl` probe) was made to confirm the
  environment blocker first-hand -- see the session's tool output for
  the exact command and the exact failure it produced.

## What could not be verified in this session

- The actual browser run: Auth sign-in, RTDB read/write/transaction/
  onDisconnect, and App Check checks, on both `10.7.1` and `10.14.1`,
  on both `chromium` and `webkit` -- blocked by the environment
  limitation above. This is a suite that has never produced a real
  PASS/FAIL result yet; that is the explicit, acknowledged state until
  it runs somewhere with working egress.
