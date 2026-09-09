// №29: application-level request body limit. Tests the REAL exported
// readJsonBodyLimited() directly against controllable fake streams -- the
// point of this feature is precisely the streaming/early-abort behavior,
// which a plain Request object would hide.

import test from "node:test";
import assert from "node:assert/strict";

import { readJsonBodyLimited, MAX_REQUEST_BODY_BYTES } from "../../worker/index.mjs";

// Fake Request exposing a ReadableStream-like body whose reads are COUNTED,
// so a test can prove the reader stopped early instead of draining the tail.
function makeFakeRequest(chunks, options = {}) {
  const state = { readCalls: 0, chunksDelivered: 0, cancelled: false, released: false };
  let i = 0;
  const reader = {
    read: async () => {
      state.readCalls++;
      if (i >= chunks.length) return { done: true, value: undefined };
      const value = chunks[i++];
      state.chunksDelivered++;
      return { done: false, value };
    },
    cancel: async () => { state.cancelled = true; },
    releaseLock: () => { state.released = true; }
  };
  return {
    _state: state,
    headers: { get: (name) => (options.headers && options.headers[name.toLowerCase()]) || null },
    body: options.nullBody ? null : { getReader: () => reader }
  };
}

const enc = new TextEncoder();
function bytesOfSize(n, fill = 0x61) { return new Uint8Array(n).fill(fill); }

test("MAX_REQUEST_BODY_BYTES is exactly 32768 (32 KiB)", () => {
  assert.equal(MAX_REQUEST_BODY_BYTES, 32768);
});

// ===== размерные границы =====

test("body of exactly 32768 bytes is NOT rejected for size (limit is >, not >=)", async () => {
  // Валидный JSON ровно в 32768 байт: {"a":"<padding>"}
  const overhead = '{"a":""}'.length;
  const payload = '{"a":"' + "b".repeat(MAX_REQUEST_BODY_BYTES - overhead) + '"}';
  const raw = enc.encode(payload);
  assert.equal(raw.byteLength, MAX_REQUEST_BODY_BYTES, "тестовый payload должен быть ровно на границе");
  const req = makeFakeRequest([raw]);
  const parsed = await readJsonBodyLimited(req);
  assert.equal(typeof parsed.a, "string");
});

test("body of 32769 bytes IS rejected with request_body_too_large", async () => {
  const req = makeFakeRequest([bytesOfSize(MAX_REQUEST_BODY_BYTES + 1)]);
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
});

// ===== 12: load-bearing early-abort =====

test("oversized stream stops reading BEFORE EOF -- tail chunks are never delivered, reader is cancelled", async () => {
  // 40 чанков по 1 KiB: лимит превышается на 33-м (33*1024 = 33792 > 32768).
  // Оставшиеся чанки не должны быть прочитаны вовсе.
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(bytesOfSize(1024));
  const req = makeFakeRequest(chunks);

  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);

  assert.equal(req._state.chunksDelivered, 33, "должно быть прочитано ровно 33 чанка (первый, на котором сумма превысила лимит), не все 40");
  assert.ok(req._state.chunksDelivered < chunks.length, "хвост потока НЕ должен быть прочитан целиком");
  assert.equal(req._state.cancelled, true, "reader.cancel() должен быть вызван");
  assert.equal(req._state.readCalls, 33, "не должно быть ни одного лишнего read() после превышения");
});

test("cumulative limit across MANY SMALL chunks (no single chunk exceeds the limit by itself)", async () => {
  // 400 чанков по 100 байт = 40000 > 32768, но каждый чанк крошечный --
  // предел обязан считаться по накопленной сумме, а не по размеру чанка.
  const chunks = [];
  for (let i = 0; i < 400; i++) chunks.push(bytesOfSize(100));
  const req = makeFakeRequest(chunks);
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
  assert.ok(req._state.chunksDelivered < 400, "чтение должно было прекратиться досрочно");
  assert.equal(req._state.chunksDelivered, 328, "328*100 = 32800 -- первый чанк, на котором сумма превысила 32768");
});

test("single huge chunk exceeding the limit is rejected on the very first read", async () => {
  const req = makeFakeRequest([bytesOfSize(MAX_REQUEST_BODY_BYTES * 4)]);
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
  assert.equal(req._state.chunksDelivered, 1);
  assert.equal(req._state.cancelled, true);
});

// ===== 6: Content-Length не влияет на correctness =====

test("fake SMALL Content-Length with an oversized real stream is still rejected (header is not trusted)", async () => {
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(bytesOfSize(1024));
  const req = makeFakeRequest(chunks, { headers: { "content-length": "10" } });
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
});

test("oversized body with NO Content-Length at all is still rejected", async () => {
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(bytesOfSize(1024));
  const req = makeFakeRequest(chunks, { headers: {} });
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
});

test("Content-Length larger than the limit does NOT reject a genuinely small body (correctness follows real bytes, not the header)", async () => {
  const req = makeFakeRequest([enc.encode('{"ok":true}')], { headers: { "content-length": String(MAX_REQUEST_BODY_BYTES * 10) } });
  const parsed = await readJsonBodyLimited(req);
  assert.deepEqual(parsed, { ok: true });
});

// ===== edge cases =====

test("null body -> invalid_json (not a crash)", async () => {
  const req = makeFakeRequest([], { nullBody: true });
  await assert.rejects(readJsonBodyLimited(req), /invalid_json/);
});

test("empty body (stream ends immediately) -> invalid_json, same as before", async () => {
  const req = makeFakeRequest([]);
  await assert.rejects(readJsonBodyLimited(req), /invalid_json/);
});

test("malformed JSON within the limit -> invalid_json (unchanged semantics)", async () => {
  const req = makeFakeRequest([enc.encode("{not valid json")]);
  await assert.rejects(readJsonBodyLimited(req), /invalid_json/);
});

test("invalid UTF-8 within the limit -> invalid_json (not silently replaced with U+FFFD)", async () => {
  const req = makeFakeRequest([new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])]); // {"a":"\xff\xfe"}
  await assert.rejects(readJsonBodyLimited(req), /invalid_json/);
});

test("valid JSON split across many chunks (chunked delivery) parses correctly", async () => {
  const payload = '{"roomCode":"ABC123","matchId":"elo_ABC123_1700000000000_0"}';
  const raw = enc.encode(payload);
  const chunks = [];
  for (let i = 0; i < raw.byteLength; i += 7) chunks.push(raw.slice(i, i + 7));
  const req = makeFakeRequest(chunks);
  const parsed = await readJsonBodyLimited(req);
  assert.equal(parsed.roomCode, "ABC123");
  assert.equal(parsed.matchId, "elo_ABC123_1700000000000_0");
});

test("multi-byte UTF-8 is measured in BYTES, not string length", async () => {
  // Кириллица -- 2 байта на символ в UTF-8. Строка из 20000 символов это
  // 40000+ байт (> лимита), хотя string.length всего 20000 (< лимита).
  // Если бы считался string.length, этот payload ошибочно прошёл бы.
  const payload = '{"a":"' + "я".repeat(20000) + '"}';
  const raw = enc.encode(payload);
  assert.ok(raw.byteLength > MAX_REQUEST_BODY_BYTES, "в байтах -- больше лимита");
  assert.ok(payload.length < MAX_REQUEST_BODY_BYTES, "в JS-символах -- меньше лимита (именно это и различает две метрики)");
  const req = makeFakeRequest([raw]);
  await assert.rejects(readJsonBodyLimited(req), /request_body_too_large/);
});

// ===== 11: реальные легитимные payload'ы каждого endpoint проходят =====

test("largest legitimate /rated/event payload (16-point path) passes the body-limit layer comfortably", async () => {
  const path = [];
  for (let i = 0; i < 16; i++) path.push({ row: i % 8, col: (i * 3) % 8 });
  const payload = JSON.stringify({
    roomCode: "A".repeat(50),
    matchId: "e".repeat(149),
    requestId: "r".repeat(64),
    type: "turn",
    path,
    offerSeq: 123456
  });
  const raw = enc.encode(payload);
  assert.ok(raw.byteLength < MAX_REQUEST_BODY_BYTES / 10,
    "самый большой легитимный /rated/event payload должен быть более чем на порядок меньше лимита (фактически " + raw.byteLength + " байт)");
  const parsed = await readJsonBodyLimited(makeFakeRequest([raw]));
  assert.equal(parsed.path.length, 16);
});

test("typical /auth/telegram initData payload passes the body-limit layer", async () => {
  const initData = "user=" + encodeURIComponent(JSON.stringify({ id: 123456789, first_name: "Илья", last_name: "Тестовый", username: "test_user_name", language_code: "ru" })) +
    "&auth_date=1700000000&query_id=AAtestquery&hash=" + "a".repeat(64);
  const raw = enc.encode(JSON.stringify({ initData }));
  assert.ok(raw.byteLength < MAX_REQUEST_BODY_BYTES, "обычный initData payload должен свободно проходить (фактически " + raw.byteLength + " байт)");
  const parsed = await readJsonBodyLimited(makeFakeRequest([raw]));
  assert.equal(typeof parsed.initData, "string");
});

test("largest legitimate /rated/join and /rated/settle payloads pass the body-limit layer", async () => {
  const join = enc.encode(JSON.stringify({ roomCode: "A".repeat(50) }));
  const settle = enc.encode(JSON.stringify({ roomCode: "A".repeat(50), matchId: "e".repeat(149) }));
  assert.ok(join.byteLength < 1024 && settle.byteLength < 1024);
  assert.equal((await readJsonBodyLimited(makeFakeRequest([join]))).roomCode.length, 50);
  assert.equal((await readJsonBodyLimited(makeFakeRequest([settle]))).matchId.length, 149);
});
