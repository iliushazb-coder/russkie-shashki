// Минимальный in-memory REST-совместимый fake для dbGet/dbGetWithEtag/
// dbPutIfMatch/dbPatchRoot из worker/index.mjs — воспроизводит ровно ту
// часть Firebase RTDB REST API, которую эти четыре функции реально
// используют (GET, GET+X-Firebase-ETag, PUT+if-match с 412 на конфликт,
// корневой PATCH). Не заменяет Rules Emulator — Rules здесь не
// применяются вовсе, только сама persistence-механика и ETag-CAS.
"use strict";

function getAtPath(store, path) {
    const parts = path.split("/").filter(Boolean);
    let node = store.data;
    for (const p of parts) {
        if (node == null || typeof node !== "object") return undefined;
        node = node[p];
    }
    return node;
}

function setAtPath(store, path, value) {
    if (store.data == null || typeof store.data !== "object") store.data = {};
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) { store.data = value; return; }
    let node = store.data;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (node[p] == null || typeof node[p] !== "object") node[p] = {};
        node = node[p];
    }
    if (value === null || value === undefined) delete node[parts[parts.length - 1]];
    else node[parts[parts.length - 1]] = value;
}

function etagFor(value) {
    // Детерминированная строка, меняющаяся при любом изменении значения —
    // этого достаточно для if-match CAS-семантики в тестах.
    return "etag:" + JSON.stringify(value === undefined ? null : value);
}

function parsePathFromUrl(baseUrl, url) {
    const withoutBase = url.slice(baseUrl.length + 1); // убрать "base/"
    const withoutJson = withoutBase.replace(/\.json(\?.*)?$/, "");
    return withoutJson;
}

function makeResponse(status, jsonBody, headers) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: function (name) { return (headers && headers[name]) || null; } },
        json: async function () { return jsonBody; }
    };
}

function resolveServerValues(value, nowFn) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        if (typeof value[".sv"] === "string") {
            if (value[".sv"] === "timestamp") return nowFn();
            return value; // другие .sv-типы этому проекту не нужны
        }
        const out = Array.isArray(value) ? [] : {};
        for (const k of Object.keys(value)) out[k] = resolveServerValues(value[k], nowFn);
        return out;
    }
    if (Array.isArray(value)) return value.map(function (v) { return resolveServerValues(v, nowFn); });
    return value;
}

// Создаёт { fetch, store } — store.data доступен тесту напрямую для seed/assert.
// "nowFn" — функция без аргументов, возвращающая текущее fake "now" (та же,
// что используется в deps.now()) — нужна, чтобы placeholder
// {".sv":"timestamp"} (serverTimestamp() в worker/index.mjs) резолвился в
// РЕАЛЬНОЕ число ПРИ ЗАПИСИ, как это делает настоящий Firebase RTDB сервер,
// а не хранился буквально как объект-плейсхолдер.
function createFakeRtdb(baseUrl, nowFn) {
    const store = { data: null };
    const getNow = nowFn || function () { return Date.now(); };

    async function fetchImpl(url, options) {
        options = options || {};
        const method = options.method || "GET";
        const path = parsePathFromUrl(baseUrl, url.split("?")[0]);

        if (method === "GET") {
            const value = getAtPath(store, path);
            const wantsEtag = options.headers && options.headers["X-Firebase-ETag"] === "true";
            const headers = wantsEtag ? { ETag: etagFor(value) } : {};
            return makeResponse(200, value === undefined ? null : value, headers);
        }

        if (method === "PUT") {
            const current = getAtPath(store, path);
            const ifMatch = options.headers && options.headers["if-match"];
            if (ifMatch !== undefined && ifMatch !== null) {
                const currentEtag = etagFor(current);
                if (ifMatch !== currentEtag) return makeResponse(412, null);
            }
            const value = resolveServerValues(JSON.parse(options.body), getNow);
            setAtPath(store, path, value);
            return makeResponse(200, value);
        }

        if (method === "PATCH") {
            const updates = resolveServerValues(JSON.parse(options.body), getNow);
            for (const key of Object.keys(updates)) {
                setAtPath(store, key, updates[key]);
            }
            return makeResponse(200, updates);
        }

        return makeResponse(404, null);
    }

    return { fetch: fetchImpl, store };
}

module.exports = { createFakeRtdb };
