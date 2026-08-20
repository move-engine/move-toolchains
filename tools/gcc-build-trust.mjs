function fail(message) {
    throw new Error(message);
}

const failureStatuses = new Set([
    "BADSIG", "ERRSIG", "EXPSIG", "EXPKEYSIG", "KEYEXPIRED", "KEYREVOKED",
    "NO_PUBKEY", "REVKEYSIG", "SIGEXPIRED",
]);

function fullFingerprint(value, description) {
    if (!/^(?:[0-9A-F]{40}|[0-9A-F]{64})$/.test(value ?? "")) {
        fail(`${description} is not a full uppercase OpenPGP fingerprint`);
    }
    return value;
}

export function parseGpgvStatus(statusText, options = {}) {
    if (typeof statusText !== "string") fail("gpgv status output must be text");
    const records = statusText.split(/\r?\n/).filter(
        (line) => line.startsWith("[GNUPG:] ")).map(
        (line) => line.slice("[GNUPG:] ".length).split(" "));
    const failure = records.find(([kind]) => failureStatuses.has(kind));
    if (failure) fail(`gpgv rejected the detached signature: ${failure[0]}`);
    const newsig = records.filter(([kind]) => kind === "NEWSIG");
    const good = records.filter(([kind]) => kind === "GOODSIG");
    const valid = records.filter(([kind]) => kind === "VALIDSIG");
    if (newsig.length !== 1 || good.length !== 1 || valid.length !== 1) {
        fail("gpgv status must contain exactly one good valid detached signature");
    }
    const fields = valid[0];
    if (fields.length !== 11 || !/^\d{4}-\d{2}-\d{2}$/.test(fields[2]) ||
        !/^\d+$/.test(fields[3]) || !/^\d+$/.test(fields[4]) ||
        !/^\d+$/.test(fields[7]) || !/^\d+$/.test(fields[8]) ||
        !/^[0-9A-F]{2}$/.test(fields[9])) {
        fail("gpgv VALIDSIG status has an unexpected shape");
    }
    const numeric = [3, 4, 5, 6, 7, 8].map((index) => Number(fields[index]));
    if (numeric.some((value) => !Number.isSafeInteger(value)) ||
        ![4, 5].includes(numeric[2]) || numeric[3] !== 0) {
        fail("gpgv VALIDSIG numeric fields are unsupported or unsafe");
    }
    const fingerprint = fullFingerprint(fields[1], "gpgv signing fingerprint");
    const primaryFingerprint = fullFingerprint(
        fields[10], "gpgv primary fingerprint");
    const keyId = good[0][1];
    if (!/^[0-9A-F]{16}$/.test(keyId ?? "") || !fingerprint.endsWith(keyId)) {
        fail("gpgv GOODSIG key id disagrees with VALIDSIG");
    }
    if (!Array.isArray(options.revokedFingerprints) ||
        !Array.isArray(options.keyInventory) ||
        !Number.isSafeInteger(options.verificationTime) || options.verificationTime < 1) {
        fail("gpgv trust evaluation requires authenticated key inventory, revocations, and time");
    }
    const revoked = new Set(options.revokedFingerprints);
    for (const value of revoked) fullFingerprint(value, "revoked fingerprint");
    if (revoked.has(fingerprint) || revoked.has(primaryFingerprint)) {
        fail(`gpgv accepted a fingerprint listed as revoked: ${fingerprint}`);
    }
    const key = options.keyInventory.find((entry) => entry.fingerprint === fingerprint);
    const primaryMatches = options.keyInventory.filter(
        (entry) => entry.fingerprint === primaryFingerprint && entry.type === "pub");
    const primary = primaryMatches[0];
    const unusable = (entry) => !entry || entry.created > numeric[0] ||
        ["r", "e", "d", "i"].includes(entry.validity) ||
        (entry.expires !== 0 && entry.expires <= options.verificationTime);
    if (!key || key.primaryFingerprint !== primaryFingerprint ||
        primaryMatches.length !== 1 || primary.primaryFingerprint !== primaryFingerprint ||
        unusable(key) || unusable(primary) || numeric[0] > options.verificationTime ||
        (numeric[1] !== 0 &&
            (numeric[1] <= numeric[0] || numeric[1] <= options.verificationTime))) {
        fail(`gpgv signing key is absent, mismatched, expired, revoked, or unusable: ${fingerprint}`);
    }
    return {
        expirationTimestamp: numeric[1],
        fingerprint,
        hashAlgorithm: numeric[5],
        primaryFingerprint,
        primaryKeyCreated: primary.created,
        primaryKeyExpires: primary.expires,
        publicKeyAlgorithm: numeric[4],
        signatureVersion: numeric[2],
        signatureClass: fields[9],
        signatureTimestamp: numeric[0],
        signingKeyCreated: key.created,
        signingKeyExpires: key.expires,
        verificationTime: options.verificationTime,
    };
}

function parseFingerprintList(text, description, trusted) {
    if (typeof text !== "string") fail(`${description} fingerprint list must be text`);
    const fingerprints = [];
    for (const [index, lineValue] of text.split(/\r?\n/).entries()) {
        const line = lineValue.trim();
        if (!line || line.startsWith("#")) continue;
        const match = trusted
            ? line.match(/^([0-9A-F]{40}|[0-9A-F]{64}):4:$/)
            : line.match(/^([0-9A-F]{40}|[0-9A-F]{64})$/);
        if (!match) fail(`${description} fingerprint list line ${index + 1} has invalid grammar`);
        const fingerprint = match[1];
        try {
            fingerprints.push(fullFingerprint(fingerprint, description));
        } catch (error) {
            fail(`${description} fingerprint list line ${index + 1}: ${error.message}`);
        }
    }
    if (fingerprints.length === 0 || new Set(fingerprints).size !== fingerprints.length) {
        fail(`${description} fingerprint list is empty or contains duplicates`);
    }
    return fingerprints;
}

export const parseMsys2TrustedFingerprints = (text) =>
    parseFingerprintList(text, "trusted", true);
export const parseMsys2RevokedFingerprints = (text) =>
    parseFingerprintList(text, "revoked", false);

export function parseGpgKeyInventory(colonText) {
    if (typeof colonText !== "string") fail("GnuPG key inventory must be text");
    const inventory = [];
    let pending = null;
    let primaryFingerprint = null;
    for (const line of colonText.split(/\r?\n/)) {
        if (!line) continue;
        const fields = line.split(":");
        if (["pub", "sub"].includes(fields[0])) {
            if (pending) fail("GnuPG key inventory key lacks its fingerprint record");
            if (fields[0] === "pub") primaryFingerprint = null;
            if (fields[0] === "sub" && !primaryFingerprint) {
                fail("GnuPG subkey precedes its primary key");
            }
            const created = Number(fields[5]);
            const expires = fields[6] ? Number(fields[6]) : 0;
            if (!Number.isSafeInteger(created) || created < 1 ||
                !Number.isSafeInteger(expires) || expires < 0) {
                fail("GnuPG key inventory has unsafe key timestamps");
            }
            if (!["", "-", "o", "i", "d", "r", "e", "q", "n", "m", "f", "u", "w", "s"].includes(fields[1])) {
                fail("GnuPG key inventory has an unknown validity value");
            }
            pending = {created, expires, type: fields[0], validity: fields[1]};
            continue;
        }
        if (fields[0] !== "fpr") continue;
        if (!pending) fail("GnuPG key inventory has an orphan fingerprint record");
        const fingerprint = fullFingerprint(fields[9], "GnuPG key inventory fingerprint");
        if (pending.type === "pub") primaryFingerprint = fingerprint;
        if (!primaryFingerprint) fail("GnuPG subkey precedes its primary key");
        inventory.push({...pending, fingerprint, primaryFingerprint});
        pending = null;
    }
    if (pending) fail("GnuPG key inventory key lacks its fingerprint record");
    if (inventory.length === 0 ||
        new Set(inventory.map((entry) => entry.fingerprint)).size !== inventory.length) {
        fail("GnuPG key inventory is empty or contains duplicate fingerprints");
    }
    return inventory;
}

export function lockedSignatureOrder(builderLock) {
    if (!builderLock || typeof builderLock !== "object" ||
        !Array.isArray(builderLock.packages)) {
        fail("builder lock packages are absent");
    }
    const keyrings = builderLock.packages.filter(
        (entry) => entry.name === "msys2-keyring");
    if (keyrings.length !== 1) fail("builder lock must contain exactly one msys2-keyring");
    for (const entry of builderLock.packages) {
        if (!entry.signature || typeof entry.signature !== "object") {
            fail(`builder package lacks a detached signature: ${entry.name ?? "unknown"}`);
        }
    }
    return [keyrings[0], ...builderLock.packages.filter(
        (entry) => entry !== keyrings[0])];
}
