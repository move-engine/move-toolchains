import path from "node:path";
import {validateArchiveManifest} from "./gcc-build-io.mjs";

function fail(message) {
    throw new Error(message);
}

export function normalizeArchiveEntry(entry) {
    return entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function parseTarVerboseListing(listing) {
    const entries = [];
    for (const line of listing.split(/\r?\n/).filter(Boolean)) {
        const match = line.match(
            /^([bcdhlps-])[rwxStTs-]{9}\s+(?:\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})|\S+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/u);
        if (!match) fail(`could not parse archive metadata: ${line}`);
        const kinds = {"-": "file", d: "directory", h: "hardlink", l: "symlink"};
        const type = kinds[match[1]];
        if (!type) fail(`archive contains unsupported entry type: ${line}`);
        let archivePath = match[2];
        let linkTarget;
        if (type === "symlink") {
            const separator = archivePath.lastIndexOf(" -> ");
            if (separator < 0) fail(`archive symlink has no target: ${line}`);
            linkTarget = archivePath.slice(separator + 4);
            archivePath = archivePath.slice(0, separator);
        } else if (type === "hardlink") {
            const separator = archivePath.lastIndexOf(" link to ");
            if (separator < 0) fail(`archive hardlink has no target: ${line}`);
            linkTarget = archivePath.slice(separator + 9);
            archivePath = archivePath.slice(0, separator);
        }
        const entry = {mode: 0, path: normalizeArchiveEntry(archivePath), type};
        if (type === "file") entry.sha256 = "0".repeat(64);
        if (linkTarget !== undefined) entry.linkTarget = linkTarget;
        entries.push(entry);
    }
    return validateArchiveManifest(entries);
}

export function parseZipLongListing(listing) {
    const entries = [];
    for (const line of listing.split(/\r?\n/)) {
        const match = line.match(
            /^([bcdhlps-])[rwxStTs-]{9}\s+(?:\S+\s+){8}(.+)$/u);
        if (!match) continue;
        if (!["-", "d"].includes(match[1])) {
            fail(`ZIP archive contains a link or unsupported entry: ${line}`);
        }
        const type = match[1] === "d" ? "directory" : "file";
        const entry = {mode: 0, path: normalizeArchiveEntry(match[2]), type};
        if (type === "file") entry.sha256 = "0".repeat(64);
        entries.push(entry);
    }
    if (!entries.length) fail("ZIP archive metadata contained no entries");
    return validateArchiveManifest(entries);
}

export function inspectPortableArchive(file, run, platform = process.platform) {
    const zip = file.toLowerCase().endsWith(".zip");
    if (zip && platform !== "win32") {
        return parseZipLongListing(run("unzip", ["-Z", "-l", file]));
    }
    return parseTarVerboseListing(run("tar", ["-tvf", file]));
}

export function archivePathSet(entries) {
    return new Set(entries.map(entry => entry.path));
}
