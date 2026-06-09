import { copyFile, lstat, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getGlobalConfigDir } from "./core/config.js";

/**
 * Installs default profiles and workflows into the global config directory.
 * Skips files that already exist unless `force` is true.
 */
export async function initDefaultConfig(options?: {
    force?: boolean;
}): Promise<{ installed: string[]; skipped: string[] }> {
    const globalDir = getGlobalConfigDir();
    const defaultsDir = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "defaults",
    );

    const installed: string[] = [];
    const skipped: string[] = [];

    const subdirs = ["profiles", "workflows"] as const;

    for (const subdir of subdirs) {
        const sourceDir = join(defaultsDir, subdir);
        const targetDir = join(globalDir, subdir);

        let files: string[];
        try {
            files = await readdir(sourceDir);
        } catch (err: unknown) {
            if (err instanceof Error && "code" in err && err.code === "ENOENT") {
                process.stderr.write(
                    `warning: defaults directory not found: ${sourceDir}\n`,
                );
                continue;
            }
            throw err;
        }

        await ensureDir(targetDir);

        for (const file of files) {
            const sourcePath = join(sourceDir, file);
            const targetPath = join(targetDir, file);

            const srcStat = await stat(sourcePath);
            if (!srcStat.isFile()) continue;

            if (!options?.force) {
                try {
                    await stat(targetPath);
                    skipped.push(join(subdir, file));
                    continue;
                } catch {
                    // target does not exist — proceed to copy
                }
            }

            // Check for symlinks before overwriting
            const targetStat = await lstat(targetPath).catch(() => null);
            if (targetStat?.isSymbolicLink()) {
                process.stderr.write(`Warning: Skipping symlink: ${targetPath}\n`);
                skipped.push(join(subdir, file));
                continue;
            }

            await copyFile(sourcePath, targetPath);
            installed.push(join(subdir, file));
        }
    }

    return { installed, skipped };
}
