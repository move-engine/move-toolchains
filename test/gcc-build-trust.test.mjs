import assert from "node:assert/strict";
import test from "node:test";
import {
    lockedSignatureOrder,
    parseGpgKeyInventory,
    parseGpgvStatus,
    parseMsys2RevokedFingerprints,
    parseMsys2TrustedFingerprints,
} from "../tools/gcc-build-trust.mjs";

const fingerprint = "5F944B027F7FE2091985AA2EFA11531AA0AA7F57";
const validStatus = `[GNUPG:] NEWSIG
[GNUPG:] KEY_CONSIDERED ${fingerprint} 0
[GNUPG:] SIG_ID fixture 2026-02-17 1771311856
[GNUPG:] GOODSIG FA11531AA0AA7F57 Untrusted display name
[GNUPG:] VALIDSIG ${fingerprint} 2026-02-17 1771311856 0 4 0 1 10 00 ${fingerprint}
`;
const keyInventory = parseGpgKeyInventory(
    `pub:u:4096:1:FA11531AA0AA7F57:1700000000:0:::::scESC::::::23::0:\n` +
    `fpr:::::::::${fingerprint}:\n`);
const trust = {
    keyInventory,
    revokedFingerprints: [],
    verificationTime: 1782000000,
};

test("parses one machine-readable detached-signature identity", () => {
    assert.deepEqual(parseGpgvStatus(validStatus, trust), {
        expirationTimestamp: 0,
        fingerprint,
        hashAlgorithm: 10,
        primaryFingerprint: fingerprint,
        primaryKeyCreated: 1700000000,
        primaryKeyExpires: 0,
        publicKeyAlgorithm: 1,
        signatureVersion: 4,
        signatureClass: "00",
        signatureTimestamp: 1771311856,
        signingKeyCreated: 1700000000,
        signingKeyExpires: 0,
        verificationTime: 1782000000,
    });
});

test("rejects failure, ambiguity, revocation, and mismatched key identity", () => {
    for (const status of [
        validStatus.replace("GOODSIG", "BADSIG"),
        validStatus + validStatus,
        validStatus.replace("[GNUPG:] GOODSIG FA11531AA0AA7F57",
            "[GNUPG:] GOODSIG 0000000000000000"),
        validStatus.replace("[GNUPG:] NEWSIG\n", ""),
    ]) assert.throws(() => parseGpgvStatus(status, trust));
    assert.throws(() => parseGpgvStatus(validStatus));
    assert.throws(() => parseGpgvStatus(validStatus, {...trust,
        revokedFingerprints: [fingerprint],
    }), /revoked/);
    assert.throws(() => parseGpgvStatus(validStatus, {...trust,
        keyInventory: keyInventory.map((entry) => ({...entry, expires: 1781999999})),
    }), /unusable/);
    assert.throws(() => parseGpgvStatus(validStatus, {...trust,
        keyInventory: [],
    }), /unusable/);
    assert.throws(() => parseGpgvStatus(validStatus.replace(
        "1771311856 0 4 0 1", "999999999999999999 0 4 0 1"), trust), /unsafe/);
    assert.throws(() => parseGpgvStatus(validStatus.replace(
        "1771311856 0 4 0 1", "1771311856 1781999999 4 0 1"), trust), /unusable/);
});

test("parses the MSYS2 trusted and revoked fingerprint formats", () => {
    assert.deepEqual(parseMsys2TrustedFingerprints(
        `# exact trust\n${fingerprint}:4:\n`), [fingerprint]);
    assert.deepEqual(parseMsys2RevokedFingerprints(`${fingerprint}\n`), [fingerprint]);
    assert.throws(() => parseMsys2TrustedFingerprints(`${fingerprint}:1:\n`), /grammar/);
    assert.throws(() => parseMsys2TrustedFingerprints(`${fingerprint}:garbage\n`), /grammar/);
    assert.throws(() => parseMsys2RevokedFingerprints(
        `${fingerprint}\n${fingerprint}\n`), /duplicates/);
    assert.throws(() => parseMsys2RevokedFingerprints("short\n"), /line 1/);
});

test("rejects unusable or malformed authenticated key inventories", () => {
    assert.equal(keyInventory[0].primaryFingerprint, fingerprint);
    assert.throws(() => parseGpgKeyInventory("sub:u:1:1:key:1:0:\n"),
        /empty|precedes|lacks its fingerprint/);
    assert.throws(() => parseGpgKeyInventory(
        `pub:u:1:1:key:999999999999999999:0:\nfpr:::::::::${fingerprint}:\n`),
    /unsafe/);
    assert.throws(() => parseGpgKeyInventory(
        `pub:x:1:1:key:1:0:\nfpr:::::::::${fingerprint}:\n`), /unknown validity/);
    assert.throws(() => parseGpgKeyInventory(
        `pub:u:1:1:key:1:0:\npub:u:1:1:key:2:0:\n`), /lacks its fingerprint/);
    assert.throws(() => parseGpgKeyInventory(
        `fpr:::::::::${fingerprint}:\n`), /orphan/);
    assert.throws(() => parseGpgKeyInventory(
        `sub:u:1:1:key:1:0:\nfpr:::::::::${fingerprint}:\n`), /precedes/);
});

test("requires both a signing subkey and its primary key to be usable", () => {
    const primary = "A".repeat(40);
    const inventory = parseGpgKeyInventory(
        `pub:u:4096:1:AAAAAAAAAAAAAAAA:1600000000:0:\n` +
        `fpr:::::::::${primary}:\n` +
        `sub:u:4096:1:FA11531AA0AA7F57:1700000000:0:\n` +
        `fpr:::::::::${fingerprint}:\n`);
    const status = validStatus.replace(
        `00 ${fingerprint}`, `00 ${primary}`);
    assert.equal(parseGpgvStatus(status, {...trust, keyInventory: inventory})
        .primaryFingerprint, primary);
    assert.throws(() => parseGpgvStatus(status, {...trust,
        keyInventory: inventory.map((entry) => entry.type === "pub"
            ? {...entry, expires: 1781999999} : entry),
    }), /unusable/);
});

test("verifies every locked package has one signature with keyring first", () => {
    const keyring = {name: "msys2-keyring", signature: {file: "keyring.sig"}};
    const bash = {name: "bash", signature: {file: "bash.sig"}};
    assert.deepEqual(lockedSignatureOrder({packages: [bash, keyring]}),
        [keyring, bash]);
    assert.throws(() => lockedSignatureOrder({packages: [bash]}), /keyring/);
    assert.throws(() => lockedSignatureOrder({packages: [keyring, {
        name: "unsigned",
    }]}), /detached signature/);
});
