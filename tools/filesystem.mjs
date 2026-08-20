import {rename} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";

const transientRenameErrors = new Set(["EACCES", "EBUSY", "EPERM"]);

export async function renameWithRetry(source, destination, options = {}) {
    const renameOperation = options.renameOperation ?? rename;
    const wait = options.wait ?? delay;
    const attempts = options.attempts ?? 8;
    let pauseMilliseconds = options.initialDelayMilliseconds ?? 50;

    for (let attempt = 1; ; ++attempt) {
        try {
            await renameOperation(source, destination);
            return;
        } catch (error) {
            if (attempt >= attempts || !transientRenameErrors.has(error?.code)) {
                throw error;
            }
            await wait(pauseMilliseconds);
            pauseMilliseconds = Math.min(pauseMilliseconds * 2, 1000);
        }
    }
}
