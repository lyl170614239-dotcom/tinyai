import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function readVersion(path) {
    if (!existsSync(path))
        return undefined;
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const version = typeof parsed?.version === "string" ? parsed.version.trim() : "";
        return version || undefined;
    }
    catch {
        return undefined;
    }
}
export function discoverPluginVersion(startUrl = import.meta.url) {
    let dir = dirname(fileURLToPath(startUrl));
    for (let depth = 0; depth < 8; depth += 1) {
        const claudeVersion = readVersion(join(dir, ".claude-plugin", "plugin.json"));
        if (claudeVersion)
            return claudeVersion;
        const codexVersion = readVersion(join(dir, ".codex-plugin", "plugin.json"));
        if (codexVersion)
            return codexVersion;
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
export function resolvePluginVersion(explicit) {
    const explicitVersion = explicit?.trim();
    if (explicitVersion)
        return explicitVersion;
    return discoverPluginVersion() || process.env.TINYAI_OBS_PLUGIN_VERSION || "0.1.0";
}
