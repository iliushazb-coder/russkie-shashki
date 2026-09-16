#!/usr/bin/env node
// tests/firebase-sdk-characterization/characterization.test.js
//
// Frozen MASTER PLAN #38 -- Firebase compat SDK characterization suite.
//
// Loads a real Firebase compat SDK (exact CDN version given by
// SDK_VERSION) into a real browser (SDK_BROWSER_ENGINE: chromium|webkit),
// against real local Auth + Database Emulators, and exercises the
// compat-API surface production's script.js actually calls. Does NOT
// touch production runtime, production Firebase project, or any Google
// backend. See README.md for full scope, what this suite covers and what
// it explicitly does not cover, and how to run it once GitHub Actions
// egress makes that possible (it is not possible inside the authoring
// container -- see README.md "Known environment limitation").
//
// Usage: normally via run-matrix.mjs, which handles the emulator
// lifecycle and is cross-platform. To run one combination by hand
// (POSIX shell; note the inline VAR=value prefix is not cmd.exe syntax):
//   node node_modules/firebase-tools/lib/bin/firebase.js emulators:exec \
//     --config tests/firebase-sdk-characterization/firebase.json \
//     --project demo-fbchar --only auth,database \
//     "SDK_VERSION=10.14.1 SDK_BROWSER_ENGINE=chromium node tests/firebase-sdk-characterization/characterization.test.js"
//
// A bare `firebase emulators:exec` only resolves where node_modules/.bin
// is already on PATH (inside an npm script, or via npx --no-install).
//
// Prints one line of structured JSON to stdout and exits 0 only if every
// gating check passed AND no network violation was observed. Advisory
// (non-gating) results never affect the exit code -- see "ADVISORY vs
// GATING" below.

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mintTestCustomToken } from './helpers/mint-test-custom-token.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SDK_VERSION = process.env.SDK_VERSION;
const BROWSER_ENGINE = process.env.SDK_BROWSER_ENGINE || 'chromium';
const PROJECT_ID = process.env.SDK_PROJECT_ID || 'demo-fbchar';
const AUTH_EMULATOR_PORT = Number(process.env.SDK_AUTH_EMULATOR_PORT || 9099);
const DATABASE_EMULATOR_PORT = Number(process.env.SDK_DATABASE_EMULATOR_PORT || 9000);
// Ceilings, not fixed sleeps: every wait below resolves as soon as the
// condition is met and only falls back to these on genuine failure, so a
// slow CI runner costs latency rather than a false FAIL.
const LISTENER_TIMEOUT_MS = Number(process.env.SDK_LISTENER_TIMEOUT_MS || 20000);
const SUITE_TIMEOUT_MS = Number(process.env.SDK_SUITE_TIMEOUT_MS || 240000);
const EXPECTED_UID = 'tg_characterization_test_uid';
const APP_CHECK_FAKE_TOKEN = 'characterization-local-app-check-token';

// The exact four bundles, in production's load order. Shared with
// fixture.html (which builds the same list) and with the network guard,
// which allows these four absolute URLs and nothing else on gstatic.
const SDK_BUNDLES = [
  'firebase-app-compat.js',
  'firebase-database-compat.js',
  'firebase-auth-compat.js',
  'firebase-app-check-compat.js',
];

// ---------------------------------------------------------------------
// Known-blocked, not a violation
//
// On WebKit, firebase-auth-compat's popup/redirect resolver eagerly
// bootstraps the GAPI iframe loader during sign-in, even though this
// suite only ever calls signInWithCustomToken and never opens a popup.
// That fires exactly one request to the GAPI loader. The request is
// still physically blocked -- nothing reaches Google -- but treating it
// as an unexpected violation produced a FAIL that said nothing about the
// SDK.
//
// The exception is scoped as narrowly as the observation that justifies
// it, on three axes:
//
//   engine -- only webkit. The behaviour was observed on WebKit only;
//             Chromium made no such request in either version, so the
//             same URL on Chromium stays a violation. A new resolver
//             behaviour appearing on Chromium is a finding, not a
//             footnote.
//   count  -- only the first match per run. Exactly one such request was
//             observed per WebKit run; a second would be new behaviour,
//             so it falls through to networkViolations.
//   shape  -- exact, as a raw string. The full request URL must equal
//             https://apis.google.com/js/api.js?onload=__iframefcb<n>
//             character for character, where <n> is 0 or a 1-6 digit
//             number with no leading zero -- exactly what
//             String(Math.floor(Math.random() * 1000000)) can produce in
//             both versions.
//
//             Deliberately NOT parsed with new URL(): parsing normalises
//             away differences that were never observed. ":443",
//             "/js/../js/api.js", "/./js/api.js" and an upper-case host
//             all collapse into the canonical form, so a parsed matcher
//             would accept request shapes this suite has no evidence
//             for. Comparing the raw string accepts the one observed
//             form and nothing else; percent-encoding, credentials,
//             extra or re-ordered parameters, a fragment, and leading
//             zeros are all excluded by construction rather than by
//             separate checks.
//
// A host-level allowlist would wave through any apis.google.com URL --
// an OAuth token endpoint, a userinfo call -- which is precisely what
// this suite exists to prove does not happen.
// ---------------------------------------------------------------------
const GAPI_IFRAME_LOADER_URL =
  /^https:\/\/apis\.google\.com\/js\/api\.js\?onload=__iframefcb(?:0|[1-9]\d{0,5})$/;

function matchesGapiIframeLoader(rawUrl, method) {
  return method === 'GET' && GAPI_IFRAME_LOADER_URL.test(rawUrl);
}

if (!SDK_VERSION) {
  console.error('SDK_VERSION env var is required, e.g. SDK_VERSION=10.7.1');
  process.exit(2);
}
if (!/^\d+\.\d+\.\d+$/.test(SDK_VERSION)) {
  console.error('SDK_VERSION must be an exact x.y.z version, got: ' + SDK_VERSION);
  process.exit(2);
}
if (BROWSER_ENGINE !== 'chromium' && BROWSER_ENGINE !== 'webkit') {
  console.error('SDK_BROWSER_ENGINE must be "chromium" or "webkit", got: ' + BROWSER_ENGINE);
  process.exit(2);
}

// ---------------------------------------------------------------------
// GATING vs ADVISORY
//
// GATING checks determine the process exit code: any non-true value
// under these keys is a suite failure. Two more things also gate,
// outside GATING_PATHS: any recorded network violation, and any uncaught
// page error raised before the reconnect probe (this fixture runs almost
// no code of its own, so an uncaught exception during the characterized
// work is a real signal rather than noise).
//
// ADVISORY results never affect the exit code: the best-effort
// offline/reconnect probe, because Playwright's context.setOffline()
// toggling combined with RTDB's own reconnect backoff timing is not
// reliably deterministic run to run (and setOffline is not supported on
// every engine), and any page error the toggle itself provokes, since
// tearing the socket out from under RTDB can legitimately raise one.
// See README.md "What this suite does NOT cover".
// ---------------------------------------------------------------------
const GATING_PATHS = [
  'sdk.versionMatches',
  'sdk.namespacesPresent',
  'auth.signInResolved',
  'auth.currentUserExists',
  'auth.uidMatches',
  'auth.idTokenIsString',
  'rtdb.set',
  'rtdb.update',
  'rtdb.onOff',
  'rtdb.push',
  'rtdb.child',
  'rtdb.remove',
  'rtdb.transaction',
  'rtdb.serverValueTimestamp',
  'rtdb.serverTimeOffset',
  'rtdb.onDisconnectSet',
  'rtdb.onDisconnectCancel',
  'appCheck.instanceCreated',
  'appCheck.activateDidNotThrow',
  'appCheck.providerCalled',
  'appCheck.tokenMatches',
  'appCheck.surfaceExists',
];

function getPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// ---------------------------------------------------------------------
// Minimal static file server for fixture.html. No new dependency: plain
// node:http. Binds to 127.0.0.1 on an OS-assigned free port.
// ---------------------------------------------------------------------
function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url && req.url.startsWith('/fixture.html')) {
          const body = await readFile(path.join(__dirname, 'fixture.html'), 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------
// The full in-browser check sequence. Runs as one page.evaluate() call
// against the real `firebase` global the fixture produced, so Auth,
// RTDB, and App Check share one initializeApp() call, exactly as
// production's script.js does.
//
// This function is serialized and executed in the browser: it may only
// reference its own parameters and browser globals, never module scope.
// ---------------------------------------------------------------------
async function runBrowserChecks({
  projectId,
  expectedSdkVersion,
  authEmulatorPort,
  databaseEmulatorPort,
  customToken,
  expectedUid,
  appCheckFakeToken,
  listenerTimeoutMs,
}) {
  const result = { sdk: {}, auth: {}, rtdb: {}, appCheck: {} };

  // --- SDK identity ---
  // Proves all four separately-loaded bundles attached to one global
  // `firebase` object at the version we asked for. This is the direct
  // check for the 10.13 "compat checks whether firebase is defined in
  // the global scope" change described in README.md.
  result.sdk.reportedVersion = typeof firebase !== 'undefined' ? firebase.SDK_VERSION : null;
  result.sdk.versionMatches = result.sdk.reportedVersion === expectedSdkVersion;
  result.sdk.namespacesPresent =
    typeof firebase !== 'undefined' &&
    typeof firebase.initializeApp === 'function' &&
    typeof firebase.database === 'function' &&
    typeof firebase.auth === 'function' &&
    typeof firebase.appCheck === 'function';

  firebase.initializeApp({ apiKey: 'fake-api-key', projectId: projectId });

  // --- Auth ---
  try {
    const auth = firebase.auth();
    auth.useEmulator('http://127.0.0.1:' + authEmulatorPort);
    await auth.signInWithCustomToken(customToken);
    result.auth.signInResolved = true;
    result.auth.currentUserExists = !!auth.currentUser;
    result.auth.uidMatches = !!(auth.currentUser && auth.currentUser.uid === expectedUid);
    if (auth.currentUser) {
      const idToken = await auth.currentUser.getIdToken();
      result.auth.idTokenIsString = typeof idToken === 'string' && idToken.length > 0;
    } else {
      result.auth.idTokenIsString = false;
    }
  } catch (e) {
    result.auth.error = String((e && e.message) || e);
  }

  // --- RTDB ---
  try {
    const db = firebase.database();
    db.useEmulator('127.0.0.1', databaseEmulatorPort);
    const base = db.ref('characterization/' + Date.now() + '_' + Math.floor(Math.random() * 1e6));

    await base.child('setTest').set({ a: 1 });
    const setSnap = await base.child('setTest').once('value');
    result.rtdb.set = !!(setSnap.val() && setSnap.val().a === 1);

    await base.child('setTest').update({ b: 2 });
    const updateSnap = await base.child('setTest').once('value');
    const updateVal = updateSnap.val();
    result.rtdb.update = !!(updateVal && updateVal.a === 1 && updateVal.b === 2);

    // on()/off(): resolve the moment the listener delivers the expected
    // value rather than sleeping a fixed interval, so a slow runner adds
    // latency instead of producing a false FAIL. The timeout is a
    // ceiling, and the listener is detached exactly once either way.
    result.rtdb.onOff = await new Promise(function (resolve) {
      const ref = base.child('onTest');
      let settled = false;
      let timer = null;
      function finish(value) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        try {
          ref.off('value', onValue);
        } catch (e) {
          /* detaching twice is harmless */
        }
        resolve(value);
      }
      function onValue(snap) {
        const v = snap.val();
        if (v && v.c === 3) finish(true);
      }
      ref.on('value', onValue, function () {
        finish(false);
      });
      timer = setTimeout(function () {
        finish(false);
      }, listenerTimeoutMs);
      ref.set({ c: 3 }).catch(function () {
        finish(false);
      });
    });

    const pushRef = base.child('pushTest').push({ d: 4 });
    await pushRef;
    result.rtdb.push = typeof pushRef.key === 'string' && pushRef.key.length > 0;

    const childSnap = await base.child('setTest/a').once('value');
    result.rtdb.child = childSnap.val() === 1;

    await base.child('removeTest').set({ x: 1 });
    await base.child('removeTest').remove();
    const removedSnap = await base.child('removeTest').once('value');
    result.rtdb.remove = removedSnap.val() === null;

    const txResult = await base.child('txTest').transaction(function (cur) {
      return (cur || 0) + 1;
    });
    result.rtdb.transaction = !!(txResult && txResult.committed === true && txResult.snapshot.val() === 1);

    await base.child('tsTest').set(firebase.database.ServerValue.TIMESTAMP);
    const tsSnap = await base.child('tsTest').once('value');
    result.rtdb.serverValueTimestamp = typeof tsSnap.val() === 'number' && tsSnap.val() > 0;

    const offsetSnap = await db.ref('.info/serverTimeOffset').once('value');
    result.rtdb.serverTimeOffset = typeof offsetSnap.val() === 'number';

    try {
      await base.child('onDisconnectTest').onDisconnect().set({ e: 5 });
      result.rtdb.onDisconnectSet = true;
      await base.child('onDisconnectTest').onDisconnect().cancel();
      result.rtdb.onDisconnectCancel = true;
    } catch (e) {
      result.rtdb.onDisconnectSet = result.rtdb.onDisconnectSet || false;
      result.rtdb.onDisconnectCancel = result.rtdb.onDisconnectCancel || false;
      result.rtdb.onDisconnectError = String((e && e.message) || e);
    }

    await base.remove();
  } catch (e) {
    result.rtdb.error = String((e && e.message) || e);
  }

  // --- App Check ---
  // Deliberately a CustomProvider with a local getToken(), not
  // ReCaptchaV3Provider. See README.md "What this suite does NOT cover" --
  // this exercises compat App Check plumbing/initialization, not the
  // production reCAPTCHA path.
  try {
    let providerCalled = false;
    const customProvider = {
      getToken: async function () {
        providerCalled = true;
        return { token: appCheckFakeToken, expireTimeMillis: Date.now() + 3600000 };
      },
    };
    const appCheck = firebase.appCheck();
    result.appCheck.instanceCreated = !!appCheck;
    appCheck.activate(customProvider, false);
    result.appCheck.activateDidNotThrow = true;
    const tokenResult = await appCheck.getToken();
    result.appCheck.providerCalled = providerCalled;
    result.appCheck.tokenMatches = !!(tokenResult && tokenResult.token === appCheckFakeToken);
    result.appCheck.surfaceExists =
      typeof appCheck.setTokenAutoRefreshEnabled === 'function' &&
      typeof appCheck.onTokenChanged === 'function' &&
      typeof appCheck.getToken === 'function';
  } catch (e) {
    result.appCheck.error = String((e && e.message) || e);
  }

  return result;
}

function emitReport(report) {
  console.log(JSON.stringify(report));
}

async function main() {
  const startedAt = new Date().toISOString();
  const networkViolations = [];
  const expectedBlocked = [];
  const pageErrors = [];
  let fixtureServer;
  let browser;
  let watchdog = null;

  try {
    // Hard ceiling on the inner run. Note this can only cover work after
    // the inner command starts -- a hang during emulator startup is
    // covered by the external per-combination timeout in run-matrix.mjs.
    watchdog = setTimeout(() => {
      emitReport({
        sdkVersion: SDK_VERSION,
        browserEngine: BROWSER_ENGINE,
        startedAt: startedAt,
        finishedAt: new Date().toISOString(),
        fatalError: 'suite timed out after ' + SUITE_TIMEOUT_MS + 'ms',
        networkViolations: networkViolations,
        expectedBlocked: expectedBlocked,
        pageErrors: pageErrors,
        passed: false,
      });
      // Close the browser before exiting, capped, so a timeout does not
      // leave an orphaned browser process holding the emulator session
      // open. process.exit() would skip the finally block entirely.
      const closed = browser
        ? browser.close().catch(() => {})
        : Promise.resolve();
      Promise.race([closed, new Promise((r) => setTimeout(r, 5000))]).then(() => {
        process.exit(1);
      });
    }, SUITE_TIMEOUT_MS);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    // Import Playwright lazily so a missing/unavailable install produces a
    // clear top-level error rather than a partial run.
    const playwright = await import('playwright');
    const launcher = BROWSER_ENGINE === 'webkit' ? playwright.webkit : playwright.chromium;

    fixtureServer = await startFixtureServer();
    const fixturePort = fixtureServer.address().port;

    browser = await launcher.launch();
    const context = await browser.newContext();

    // Network guard. Three outcomes, never two:
    //
    //   continue  -- the four pinned SDK bundle URLs for the version under
    //                test, plus local emulator/fixture traffic.
    //   block+expected -- the FIRST matching GAPI iframe-loader request,
    //                on webkit only (see matchesGapiIframeLoader above).
    //                Still physically blocked; recorded separately; does
    //                not fail the suite.
    //   block+violation -- everything else, including any other path or
    //                version on gstatic and any other Google URL. Fails
    //                the suite.
    const allowedSdkUrls = new Set(
      SDK_BUNDLES.map((b) => 'https://www.gstatic.com/firebasejs/' + SDK_VERSION + '/' + b)
    );
    const localPattern = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
    await context.route('**/*', function (route) {
      const request = route.request();
      const url = request.url();
      if (allowedSdkUrls.has(url) || localPattern.test(url)) {
        route.continue();
        return;
      }
      if (
        BROWSER_ENGINE === 'webkit' &&
        expectedBlocked.length === 0 &&
        matchesGapiIframeLoader(url, request.method())
      ) {
        expectedBlocked.push({ url: url, method: request.method() });
      } else {
        networkViolations.push({ url: url, method: request.method() });
      }
      route.abort('blockedbyclient');
    });

    const page = await context.newPage();
    page.on('pageerror', (err) => {
      pageErrors.push(String((err && err.message) || err));
    });

    await page.goto('http://127.0.0.1:' + fixturePort + '/fixture.html?sdkVersion=' + encodeURIComponent(SDK_VERSION));

    await page.waitForFunction(
      function () {
        return window.__fixtureReady === true || !!window.__fixtureLoadError;
      },
      { timeout: 60000 }
    );

    const fixtureLoadError = await page.evaluate(function () {
      return window.__fixtureLoadError || null;
    });
    if (fixtureLoadError) {
      throw new Error('fixture failed to load SDK bundles: ' + fixtureLoadError);
    }

    const customToken = mintTestCustomToken({ uid: EXPECTED_UID, projectId: PROJECT_ID });

    const checks = await page.evaluate(runBrowserChecks, {
      projectId: PROJECT_ID,
      expectedSdkVersion: SDK_VERSION,
      authEmulatorPort: AUTH_EMULATOR_PORT,
      databaseEmulatorPort: DATABASE_EMULATOR_PORT,
      customToken: customToken,
      expectedUid: EXPECTED_UID,
      appCheckFakeToken: APP_CHECK_FAKE_TOKEN,
      listenerTimeoutMs: LISTENER_TIMEOUT_MS,
    });

    // Snapshot page errors BEFORE the reconnect probe. Uncaught errors
    // raised during the characterized work are gating: this fixture runs
    // almost no code of its own, so an uncaught exception there is a real
    // signal and letting it pass would be a false PASS. Errors raised by
    // the deliberate offline/online toggle below are a different matter --
    // tearing the socket out from under RTDB can legitimately surface an
    // uncaught error -- so those are recorded separately and stay
    // advisory, matching the probe itself.
    const gatingPageErrors = pageErrors.slice();

    // --- Best-effort, ADVISORY-only offline/reconnect probe ---
    // Not included in GATING_PATHS: see README.md for why this specific
    // check is not treated as deterministic enough to gate the suite.
    // context.setOffline() is also not supported on every engine, hence
    // the explicit `supported` flag rather than a bare failure.
    const reconnect = { attempted: true, supported: true };
    try {
      await context.setOffline(true);
      await context.setOffline(false);
      reconnect.pageStillResponsiveAfterToggle = await page.evaluate(function () {
        return typeof firebase !== 'undefined' && typeof firebase.database === 'function';
      });
    } catch (e) {
      reconnect.supported = false;
      reconnect.error = String((e && e.message) || e);
    }

    const gatingFailures = GATING_PATHS.filter(function (p) {
      return getPath(checks, p) !== true;
    });
    const probePageErrors = pageErrors.slice(gatingPageErrors.length);

    const report = {
      sdkVersion: SDK_VERSION,
      browserEngine: BROWSER_ENGINE,
      projectId: PROJECT_ID,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      checks: checks,
      gatingFailures: gatingFailures,
      networkViolations: networkViolations,
      expectedBlocked: expectedBlocked,
      pageErrors: gatingPageErrors,
      advisory: { reconnect: reconnect, probePageErrors: probePageErrors },
      passed:
        gatingFailures.length === 0 &&
        networkViolations.length === 0 &&
        gatingPageErrors.length === 0,
    };

    emitReport(report);
    process.exitCode = report.passed ? 0 : 1;
  } catch (err) {
    emitReport({
      sdkVersion: SDK_VERSION,
      browserEngine: BROWSER_ENGINE,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      fatalError: String((err && err.stack) || err),
      networkViolations: networkViolations,
      expectedBlocked: expectedBlocked,
      pageErrors: pageErrors,
      passed: false,
    });
    process.exitCode = 1;
  } finally {
    if (watchdog !== null) clearTimeout(watchdog);
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        /* ignore */
      }
    }
    if (fixtureServer) {
      try {
        fixtureServer.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

main();
