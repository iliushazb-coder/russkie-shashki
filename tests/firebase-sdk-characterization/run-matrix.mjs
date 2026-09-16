#!/usr/bin/env node
// tests/firebase-sdk-characterization/run-matrix.mjs
//
// Frozen MASTER PLAN #38 -- runs characterization.test.js across the full
// baseline/candidate x browser-engine matrix and prints one normalized,
// diffable comparison. This file is NOT in the structure originally
// listed for this suite; it was added because nothing else in the
// original five-file list actually loops the four required combinations
// and produces the side-by-side comparison the plan asks for -- without
// it, someone would have to invoke characterization.test.js four times
// by hand and diff the JSON lines themselves.
//
// Each combination is run inside its own `firebase emulators:exec`
// invocation, so each gets fresh Auth + Database Emulator state.
//
// Usage (once runnable in an environment with working egress):
//   node tests/firebase-sdk-characterization/run-matrix.mjs \
//     --baseline 10.7.1 --candidate 10.14.1
//
// Requires `firebase-tools` to be installed (already a devDependency).
// The CLI is located by module resolution and run with the current Node
// binary, so it works regardless of PATH, npm-script context, or OS --
// a bare spawn('firebase', ...) only works when node_modules/.bin is on
// PATH, which is not the case for a plain `node run-matrix.mjs`.
// Does not modify package.json or any workflow file.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function resolveFirebaseCli() {
  try {
    return require.resolve('firebase-tools/lib/bin/firebase.js');
  } catch (e) {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    baseline: '10.7.1',
    candidate: '10.14.1',
    projectId: 'demo-fbchar',
    // Covers the whole combination including emulator startup.
    combinationTimeoutMs: Number(process.env.SDK_COMBINATION_TIMEOUT_MS || 600000),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline') out.baseline = argv[++i];
    else if (argv[i] === '--candidate') out.candidate = argv[++i];
    else if (argv[i] === '--project') out.projectId = argv[++i];
    else if (argv[i] === '--timeout-ms') out.combinationTimeoutMs = Number(argv[++i]);
  }
  return out;
}

function runOneCombination({ sdkVersion, browserEngine, projectId, firebaseCliPath, combinationTimeoutMs }) {
  return new Promise((resolve) => {
    const firebaseJsonPath = path.join(__dirname, 'firebase.json');
    const testFilePath = path.join(__dirname, 'characterization.test.js');
    // Run the inner test with the same Node binary too, so the child
    // command does not depend on PATH either.
    const innerCommand = `"${process.execPath}" "${testFilePath}"`;

    const child = spawn(
      process.execPath,
      [
        firebaseCliPath,
        'emulators:exec',
        '--config',
        firebaseJsonPath,
        '--project',
        projectId,
        '--only',
        'auth,database',
        innerCommand,
      ],
      {
        env: Object.assign({}, process.env, {
          SDK_VERSION: sdkVersion,
          SDK_BROWSER_ENGINE: browserEngine,
          SDK_PROJECT_ID: projectId,
        }),
        cwd: __dirname,
      }
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    // External ceiling covering the WHOLE combination, including emulator
    // startup. The inner test's own watchdog only starts once the inner
    // command runs, so it cannot cover a hang before that (emulator boot,
    // JAR download, port contention). SIGTERM first, SIGKILL if the child
    // ignores it.
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch (e) {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          /* already gone */
        }
      }, 15000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }, combinationTimeoutMs);

    function cleanupTimers() {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
    }

    // Without this, a spawn failure (ENOENT, EACCES) would leave the
    // promise pending forever and hang the whole matrix.
    child.on('error', (err) => {
      cleanupTimers();
      resolve({
        sdkVersion,
        browserEngine,
        exitCode: null,
        parsed: null,
        spawnError: String((err && err.message) || err),
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });

    child.on('close', (code) => {
      cleanupTimers();
      // characterization.test.js prints exactly one JSON line; find it
      // among whatever firebase emulators:exec itself also printed.
      const jsonLine = stdout
        .split('\n')
        .reverse()
        .find((line) => {
          const trimmed = line.trim();
          return trimmed.startsWith('{') && trimmed.endsWith('}');
        });
      let parsed = null;
      if (jsonLine) {
        try {
          parsed = JSON.parse(jsonLine);
        } catch (e) {
          /* leave parsed as null; report raw output below */
        }
      }
      resolve({
        sdkVersion,
        browserEngine,
        exitCode: code,
        timedOut,
        parsed,
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
  });
}

const RAW_OUTPUT_LIMIT = Number(process.env.SDK_RAW_OUTPUT_LIMIT || 20000);

function truncate(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (text.length <= RAW_OUTPUT_LIMIT) return text;
  return text.slice(0, RAW_OUTPUT_LIMIT) + '\n...[truncated ' + (text.length - RAW_OUTPUT_LIMIT) + ' chars]';
}

function combinationPassed(r) {
  return (
    !!r.parsed &&
    r.parsed.passed === true &&
    r.timedOut !== true &&
    !r.spawnError &&
    r.exitCode === 0
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const firebaseCliPath = resolveFirebaseCli();
  if (!firebaseCliPath) {
    console.error(
      'Could not resolve firebase-tools. Run `npm ci` in the repository root first.'
    );
    process.exitCode = 2;
    return;
  }

  const engines = ['chromium', 'webkit'];
  const versions = [args.baseline, args.candidate];

  const results = [];
  for (const sdkVersion of versions) {
    for (const browserEngine of engines) {
      console.error(`Running SDK_VERSION=${sdkVersion} SDK_BROWSER_ENGINE=${browserEngine} ...`);
      const result = await runOneCombination({
        sdkVersion,
        browserEngine,
        projectId: args.projectId,
        firebaseCliPath,
        combinationTimeoutMs: args.combinationTimeoutMs,
      });
      results.push(result);
    }
  }

  // Normalized comparison: for every gating check key that appears in any
  // result, show baseline vs candidate per engine side by side.
  const allCheckKeys = new Set();
  for (const r of results) {
    if (r.parsed && r.parsed.checks) {
      for (const group of Object.keys(r.parsed.checks)) {
        for (const key of Object.keys(r.parsed.checks[group] || {})) {
          allCheckKeys.add(`${group}.${key}`);
        }
      }
    }
  }

  const comparison = {
    baseline: args.baseline,
    candidate: args.candidate,
    generatedAt: new Date().toISOString(),
    perCombination: results.map((r) => ({
      sdkVersion: r.sdkVersion,
      browserEngine: r.browserEngine,
      exitCode: r.exitCode,
      timedOut: r.timedOut === true,
      spawnError: r.spawnError,
      // A combination counts as passed only if the inner report says so
      // AND the process actually exited 0 AND it was not killed. The
      // inner report can say passed while `emulators:exec` itself still
      // fails afterwards (emulator teardown, port release, export), so
      // the exit code is authoritative alongside the report.
      passed: combinationPassed(r),
      gatingFailures: r.parsed ? r.parsed.gatingFailures : null,
      networkViolations: r.parsed ? r.parsed.networkViolations : null,
      expectedBlocked: r.parsed ? r.parsed.expectedBlocked : null,
      pageErrors: r.parsed ? r.parsed.pageErrors : null,
      fatalError: r.parsed ? r.parsed.fatalError : undefined,
      // Raw output is captured for exactly the cases that need
      // diagnosing; without surfacing it here it would be discarded when
      // the child process ends, which defeats capturing it at all.
      rawStdout: combinationPassed(r) ? undefined : truncate(r.rawStdout),
      rawStderr: combinationPassed(r) ? undefined : truncate(r.rawStderr),
    })),
    checkByCheckDiff: Array.from(allCheckKeys)
      .sort()
      .map((key) => {
        const [group, prop] = key.split('.');
        const row = { check: key };
        for (const r of results) {
          const id = `${r.sdkVersion}/${r.browserEngine}`;
          row[id] = r.parsed && r.parsed.checks && r.parsed.checks[group] ? r.parsed.checks[group][prop] : undefined;
        }
        return row;
      }),
  };

  console.log(JSON.stringify(comparison, null, 2));

  const anyFailed = results.some((r) => !combinationPassed(r));
  process.exitCode = anyFailed ? 1 : 0;
}

main();
