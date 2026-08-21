import {copyFile, mkdir, realpath} from "node:fs/promises";
import path from "node:path";

function fail(message) {
    throw new Error(message);
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

export const pairedGccRuntimeLibraries = ["libgcc_s.so.1", "libatomic.so.1"];

export async function copyPairedGccRuntimeLibraries(
    pairedGccInstall, stagedClangInstall) {
    const canonicalGcc = await realpath(pairedGccInstall);
    const destination = path.join(stagedClangInstall, "lib");
    await mkdir(destination, {recursive: true});
    for (const name of pairedGccRuntimeLibraries) {
        const source = await realpath(path.join(pairedGccInstall, "lib64", name));
        if (!isInside(canonicalGcc, source)) {
            fail(`paired GCC runtime escaped its installation: ${name}`);
        }
        // Dereference the GCC archive's development symlink chain so each
        // runtime SONAME is a self-contained regular file in the clang tree.
        await copyFile(source, path.join(destination, name));
    }
}
