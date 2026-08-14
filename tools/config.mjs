import {access, mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
export const localConfigurationPath = path.join(
    repositoryRoot, ".local", "config.json");

export function hostIdentity() {
    return `${process.platform}-${process.arch}`;
}

export function hostEnvironmentSuffix(host = hostIdentity()) {
    return host.replaceAll("-", "_").toUpperCase();
}

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

export function parseDotEnv(text) {
    const values = {};
    for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
        const line = sourceLine.trim();
        if (!line || line.startsWith("#")) continue;
        const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) throw new Error(`invalid .env line ${index + 1}`);
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        values[match[1]] = value;
    }
    return values;
}

export async function loadEnvironmentFile(environment = process.env) {
    const configured = environment.MOVE_TOOLCHAINS_ENV_FILE;
    const file = path.resolve(configured || path.join(repositoryRoot, ".env"));
    if (!(await exists(file))) return null;
    const values = parseDotEnv(await readFile(file, "utf8"));
    for (const [name, value] of Object.entries(values)) {
        if (environment[name] === undefined) environment[name] = value;
    }
    return file;
}

export async function loadLocalConfiguration() {
    if (!(await exists(localConfigurationPath))) {
        return {schemaVersion: 1, hosts: {}};
    }
    const configuration = JSON.parse(
        await readFile(localConfigurationPath, "utf8"));
    if (configuration.schemaVersion !== 1 ||
        !configuration.hosts || typeof configuration.hosts !== "object") {
        throw new Error(`unsupported local configuration: ${localConfigurationPath}`);
    }
    return configuration;
}

function nonempty(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveSettings(configuration, environment = process.env,
    host = hostIdentity()) {
    const saved = configuration.hosts[host] ?? {};
    const hostRoot = nonempty(
        environment[`MOVE_TOOLCHAINS_${hostEnvironmentSuffix(host)}_ROOT`]);
    const globalRoot = nonempty(environment.MOVE_TOOLCHAINS_LOCAL_ROOT);
    const localRoot = path.resolve(
        hostRoot ?? globalRoot ?? saved.localRoot ??
        path.join(repositoryRoot, ".local", "toolchains", host));
    const clangRoot = path.resolve(
        nonempty(environment.MOVE_CLANG_P2996_ROOT) ??
        saved.clangRoot ?? localRoot);
    const gccRootValue = nonempty(environment.MOVE_GCC_ROOT) ?? saved.gccRoot ??
        (host === "win32-x64" ?
            nonempty(environment.MOVE_UCRT64_ROOT) ?? saved.ucrt64Root ??
                "C:\\msys64\\ucrt64" :
            path.join(localRoot, "gcc", "current"));
    return {
        host,
        localRoot,
        clangRoot,
        gccRoot: path.resolve(gccRootValue),
        xmakePath: nonempty(environment.MOVE_XMAKE_PATH) ??
            saved.xmakePath ?? null,
        ucrt64Root: host === "win32-x64" ? path.resolve(
            nonempty(environment.MOVE_UCRT64_ROOT) ?? saved.ucrt64Root ??
            gccRootValue) : null,
        releaseRepository: nonempty(
            environment.MOVE_TOOLCHAINS_RELEASE_REPOSITORY) ??
            saved.releaseRepository ?? null,
    };
}

export async function saveHostSettings(update, host = hostIdentity()) {
    const configuration = await loadLocalConfiguration();
    configuration.hosts[host] = {
        ...(configuration.hosts[host] ?? {}),
        ...update,
    };
    await mkdir(path.dirname(localConfigurationPath), {recursive: true});
    await writeFile(localConfigurationPath,
        `${JSON.stringify(configuration, null, 2)}\n`);
    return configuration.hosts[host];
}
