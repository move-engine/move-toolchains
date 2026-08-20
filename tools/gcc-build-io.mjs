import {createHash, randomUUID} from "node:crypto";
import {link, lstat, mkdir, open, rm} from "node:fs/promises";
import path from "node:path";

function fail(message) {
    throw new Error(message);
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
}

async function sha256File(file, io, signal) {
    throwIfAborted(signal);
    const handle = await io.open(file, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    try {
        for (;;) {
            throwIfAborted(signal);
            const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        await handle.close();
    }
    return hash.digest("hex");
}

function validateAsset(asset) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset) ||
        !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 ||
        !/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) {
        fail("locked download lacks exact byte and SHA-256 identity");
    }
    const url = new URL(asset.url);
    if (url.protocol !== "https:" || url.username || url.password) {
        fail(`locked download is not credential-free HTTPS: ${asset.url}`);
    }
    return url;
}

async function inspectExisting(file, asset, io, signal) {
    throwIfAborted(signal);
    try {
        const information = await io.lstat(file);
        return information.isFile() && information.size === asset.bytes &&
            await sha256File(file, io, signal) === asset.sha256 ? "exact" : "invalid";
    } catch (error) {
        if (error.code === "ENOENT") return "absent";
        throw error;
    }
}

async function fetchHttps(fetchOperation, initialUrl, signal) {
    let url = initialUrl;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
        throwIfAborted(signal);
        const response = await fetchOperation(url, {redirect: "manual", signal});
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel?.();
            if (redirect === 5) fail(`too many redirects for locked download: ${initialUrl}`);
            const location = response.headers.get("location");
            if (!location) fail(`redirect lacks Location for locked download: ${url}`);
            const next = new URL(location, url);
            if (next.protocol !== "https:" || next.username || next.password) {
                fail(`locked download redirected outside HTTPS: ${next}`);
            }
            url = next;
            continue;
        }
        if (!response.ok || !response.body) {
            fail(`locked download failed (${response.status}): ${url}`);
        }
        return {response, finalUrl: url};
    }
    fail(`unreachable redirect state for locked download: ${initialUrl}`);
}

export async function downloadExactHttpsAsset(asset, destination, options = {}) {
    throwIfAborted(options.signal);
    const initialUrl = validateAsset(asset);
    const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
        asset.bytes > maximumBytes) {
        fail(`locked download exceeds the configured size ceiling: ${asset.bytes} > ${maximumBytes}`);
    }
    const io = options.io ?? defaultIo;
    const fetchOperation = options.fetch ?? globalThis.fetch;
    const existing = await inspectExisting(destination, asset, io, options.signal);
    if (existing === "exact") {
        return {destination, finalUrl: initialUrl.href, reused: true};
    }
    if (existing === "invalid") {
        fail(`locked download cache entry has the wrong identity and was preserved: ${destination}`);
    }
    await io.mkdir(path.dirname(destination), {recursive: true});
    const temporary = `${destination}.part-${process.pid}-${randomUUID()}`;
    let handle = null;
    try {
        const {response, finalUrl} = await fetchHttps(
            fetchOperation, initialUrl, options.signal);
        const declaredLength = response.headers.get("content-length");
        if (declaredLength !== null && Number(declaredLength) !== asset.bytes) {
            await response.body.cancel?.();
            fail(`locked download Content-Length mismatch: expected ${asset.bytes}, got ${declaredLength}`);
        }
        try {
            handle = await io.open(temporary, "wx");
        } catch (error) {
            await response.body.cancel?.();
            throw error;
        }
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunkValue of response.body) {
            throwIfAborted(options.signal);
            const chunk = Buffer.from(chunkValue);
            bytes += chunk.length;
            if (bytes > asset.bytes) {
                fail(`locked download exceeded ${asset.bytes} bytes`);
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                throwIfAborted(options.signal);
                const result = await handle.write(
                    chunk, offset, chunk.length - offset, null);
                if (result.bytesWritten < 1) fail("locked download write made no progress");
                offset += result.bytesWritten;
            }
        }
        await handle.sync();
        await handle.close();
        handle = null;
        const digest = hash.digest("hex");
        if (bytes !== asset.bytes || digest !== asset.sha256) {
            fail(`locked download identity mismatch: expected ${asset.bytes} bytes/${asset.sha256}, got ${bytes}/${digest}`);
        }
        throwIfAborted(options.signal);
        const published = await inspectExisting(destination, asset, io, options.signal);
        if (published === "exact") {
            return {destination, finalUrl: finalUrl.href, reused: true};
        }
        if (published === "invalid") {
            fail(`locked download destination changed before publication and was preserved: ${destination}`);
        }
        try {
            await io.link(temporary, destination);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            if (await inspectExisting(destination, asset, io, options.signal) === "exact") {
                return {destination, finalUrl: finalUrl.href, reused: true};
            }
            fail(`locked download destination raced with invalid content and was preserved: ${destination}`);
        }
        if (await inspectExisting(destination, asset, io, options.signal) !== "exact") {
            fail(`locked download changed during publication: ${destination}`);
        }
        return {destination, finalUrl: finalUrl.href, reused: false};
    } finally {
        if (handle) await handle.close();
        await io.rm(temporary, {force: true});
    }
}

function safeArchivePath(value, description) {
    if (typeof value !== "string" || !value || value.includes("\\") ||
        value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.includes("\0") ||
        /[<>:"|?*\u0000-\u001f]/.test(value) || value.normalize("NFC") !== value) {
        fail(`${description} is not a safe portable archive path`);
    }
    const parts = value.replace(/\/$/, "").split("/");
    const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;
    if (parts.some((part) => !part || part === "." || part === ".." ||
        part.endsWith(".") || part.endsWith(" ") || reserved.test(part))) {
        fail(`${description} is not a normalized archive path`);
    }
    return parts.join("/");
}

function resolvedLink(entryPath, target, hardlink) {
    if (typeof target !== "string" || !target || target.includes("\\") ||
        target.startsWith("/") || /^[A-Za-z]:/.test(target) ||
        /[<>:"|?*\u0000-\u001f]/.test(target) || target.normalize("NFC") !== target) {
        fail(`archive link ${entryPath} target is not portable`);
    }
    const base = hardlink ? "" : path.posix.dirname(entryPath);
    const resolved = path.posix.normalize(path.posix.join(base, target));
    if (resolved === ".." || resolved.startsWith("../") ||
        path.posix.isAbsolute(resolved)) {
        fail(`archive link escapes its root: ${entryPath} -> ${target}`);
    }
    safeArchivePath(resolved, `archive link ${entryPath} resolved target`);
    return resolved;
}

export function validateArchiveManifest(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        fail("archive manifest must contain entries");
    }
    const exact = new Set();
    const folded = new Map();
    const normalized = [];
    for (const sourceEntry of entries) {
        const entry = structuredClone(sourceEntry);
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            fail("archive manifest entry must be an object");
        }
        entry.path = safeArchivePath(entry.path, "archive entry path");
        if (!["directory", "file", "hardlink", "symlink"].includes(entry.type)) {
            fail(`archive entry type is unsupported: ${entry.type}`);
        }
        const expectedKeys = entry.type === "file"
            ? ["mode", "path", "sha256", "type"]
            : ["hardlink", "symlink"].includes(entry.type)
                ? ["linkTarget", "mode", "path", "type"]
                : ["mode", "path", "type"];
        const actualKeys = Object.keys(entry).sort();
        if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
            fail(`archive entry has undeclared or inapplicable fields: ${entry.path}`);
        }
        if (exact.has(entry.path)) fail(`archive contains a duplicate path: ${entry.path}`);
        exact.add(entry.path);
        const pathParts = entry.path.split("/");
        for (let index = 1; index <= pathParts.length; index += 1) {
            const prefix = pathParts.slice(0, index).join("/");
            const caseKey = prefix.toLowerCase();
            if (folded.has(caseKey) && folded.get(caseKey) !== prefix) {
                fail(`archive contains a case-fold collision: ${folded.get(caseKey)} / ${prefix}`);
            }
            folded.set(caseKey, prefix);
        }
        if (["hardlink", "symlink"].includes(entry.type)) {
            resolvedLink(entry.path, entry.linkTarget, entry.type === "hardlink");
        } else if (entry.linkTarget !== undefined) {
            fail(`non-link archive entry has a link target: ${entry.path}`);
        }
        if (entry.type === "file" && !/^[0-9a-f]{64}$/.test(entry.sha256 ?? "")) {
            fail(`archive file lacks a SHA-256 digest: ${entry.path}`);
        }
        if (!Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
            fail(`archive entry has an invalid mode: ${entry.path}`);
        }
        normalized.push(entry);
    }
    const byPath = new Map(normalized.map((entry) => [entry.path, entry]));
    for (const entry of normalized) {
        const parts = entry.path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
            const parent = byPath.get(parts.slice(0, index).join("/"));
            if (parent && parent.type !== "directory") {
                fail(`archive entry traverses a non-directory parent: ${entry.path}`);
            }
        }
    }
    return normalized;
}

function entryIdentity(entry) {
    return JSON.stringify({
        linkTarget: entry.linkTarget ?? null,
        mode: entry.mode,
        sha256: entry.sha256 ?? null,
        type: entry.type,
    });
}

export function mergeArchiveManifests(manifests) {
    const merged = new Map();
    for (const manifest of manifests) {
        for (const entry of validateArchiveManifest(manifest)) {
            const existing = merged.get(entry.path);
            if (existing && entryIdentity(existing) !== entryIdentity(entry)) {
                fail(`archive payload collision is not identical: ${entry.path}`);
            }
            if (!existing) merged.set(entry.path, structuredClone(entry));
        }
    }
    return validateArchiveManifest([...merged.values()]).sort((left, right) => Buffer.compare(
        Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
}

const defaultIo = {link, lstat, mkdir, open, rm};
