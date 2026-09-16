// tests/firebase-sdk-characterization/helpers/mint-test-custom-token.mjs
//
// Mints a production-shaped Firebase Auth custom token entirely locally,
// signed with a one-off RSA keypair generated in-process via node:crypto.
// No npm dependency, no network call, no production service-account key.
//
// Why this is safe against the Auth Emulator specifically (not against
// production): the emulator's own documentation states plainly that it
// "does not validate the signature or expiry of custom tokens. This
// allows you to use hand-crafted tokens and re-use tokens indefinitely
// in prototyping and testing scenarios."
//   https://firebase.google.com/docs/emulator-suite/connect_auth#custom_token_authentication
//
// RS256 + production-shaped claims are used anyway (not because the
// emulator requires it -- it doesn't) but to keep the artifact
// structurally close to a real Admin SDK custom token, matching what
// worker/index.mjs's createFirebaseCustomToken() produces in production.
// A simpler HS256 or even-unsigned token would be accepted identically
// by the emulator; RS256 was chosen for fidelity, not necessity.

import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

let cachedKeyPair = null;

/**
 * Returns a process-local RSA keypair, generated once and cached for the
 * lifetime of the process. Never written to disk, never derived from any
 * production secret.
 */
function getTestKeyPair() {
  if (!cachedKeyPair) {
    cachedKeyPair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
  return cachedKeyPair;
}

/**
 * Mints a one-off, production-shaped Firebase custom token (RS256 JWT,
 * three segments) for use with the Auth Emulator only.
 *
 * @param {object} opts
 * @param {string} opts.uid - the uid the emulator will sign in as
 * @param {string} [opts.projectId] - demo- project id; used only to build
 *   a plausible iss/sub value, never verified by the emulator
 * @param {object} [opts.additionalClaims] - extra claims under `claims`
 * @returns {string} an RS256-signed JWT string
 */
export function mintTestCustomToken({ uid, projectId = 'demo-fbchar', additionalClaims = {} }) {
  if (!uid) throw new Error('mintTestCustomToken: uid is required');
  const { privateKey } = getTestKeyPair();

  const fakeServiceAccountEmail = `firebase-sdk-characterization@${projectId}.iam.gserviceaccount.com`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: fakeServiceAccountEmail,
    sub: fakeServiceAccountEmail,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    uid,
    claims: additionalClaims,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const encodedSignature = base64url(signature);

  return `${signingInput}.${encodedSignature}`;
}

/**
 * Decodes a JWT's header/payload without verifying the signature.
 * For local self-checks only -- never use this as a verification method.
 */
export function decodeTestToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('decodeTestToken: not a 3-segment JWT');
  const [h, p] = parts;
  const pad = (s) => s + '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s) => Buffer.from(pad(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return { header: JSON.parse(b64(h)), payload: JSON.parse(b64(p)) };
}
