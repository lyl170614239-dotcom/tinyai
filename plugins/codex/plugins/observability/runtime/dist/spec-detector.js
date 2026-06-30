import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
export function classifySpecPath(filePath) {
    const normalized = filePath.replaceAll("\\", "/");
    const isCatalog = normalized.includes("/_meta/catalog") || normalized.endsWith("_meta/catalog.yml");
    const isPersonal = normalized.includes("openspec/specs/workspaces/") && normalized.includes("/specs/");
    const isOfficial = normalized.includes("openspec/specs/official/");
    return {
        spec_scope: isCatalog ? "catalog" : isPersonal ? "personal" : isOfficial ? "official" : "unknown",
        doc_path: normalized,
        via_catalog: isCatalog,
        matched_by: inferMatchedBy(normalized),
        fallback_used: false
    };
}
function inferMatchedBy(text) {
    const hits = [];
    if (/keywords?/i.test(text))
        hits.push("keywords");
    if (/related[_-]?code/i.test(text))
        hits.push("related_code");
    if (/modules?/i.test(text))
        hits.push("module");
    if (/tags?/i.test(text))
        hits.push("tags");
    return hits;
}
async function walk(root, maxFiles = 300) {
    const results = [];
    async function visit(dir) {
        if (results.length >= maxFiles)
            return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= maxFiles)
                return;
            const path = join(dir, entry.name);
            if (entry.isDirectory())
                await visit(path);
            else if (/\.(md|ya?ml)$/i.test(entry.name))
                results.push(path);
        }
    }
    await visit(root);
    return results;
}
function inferContentMatchedBy(content, terms) {
    const lower = content.toLowerCase();
    const hits = new Set();
    const fields = [
        ["keywords", /keywords?\s*[:\n]/i],
        ["related_code", /related[_-]?code\s*[:\n]/i],
        ["module", /modules?\s*[:\n]/i],
        ["tags", /tags?\s*[:\n]/i]
    ];
    for (const [name, pattern] of fields) {
        const match = pattern.exec(content);
        if (!match || match.index < 0)
            continue;
        const window = lower.slice(match.index, match.index + 900);
        if (terms.some((term) => window.includes(term)))
            hits.add(name);
    }
    if (hits.size === 0 && terms.some((term) => lower.includes(term)))
        hits.add("body");
    return [...hits];
}
export async function searchSpecs(workspacePath, query) {
    const roots = [
        join(workspacePath, "openspec", "specs", "workspaces"),
        join(workspacePath, "openspec", "specs", "official")
    ];
    const files = (await Promise.all(roots.map((root) => walk(root)))).flat();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const scored = [];
    for (const file of files) {
        const content = await readFile(file, "utf8").catch(() => "");
        const lower = content.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
        if (score > 0) {
            const hitIndexes = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0);
            const firstHit = Math.max(0, Math.min(...hitIndexes) - 120);
            const relativePath = relative(workspacePath, file);
            scored.push({
                path: relativePath,
                excerpt: content.slice(firstHit, firstHit + 420),
                score,
                matched_by: [...new Set([...inferMatchedBy(relativePath), ...inferContentMatchedBy(content, terms)])]
            });
        }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 10).map(({ path, excerpt, matched_by }) => ({ path, excerpt, matched_by }));
}
export async function readSpec(workspacePath, specPath) {
    const absolute = join(workspacePath, specPath);
    const content = await readFile(absolute, "utf8");
    return {
        path: specPath,
        content,
        classification: classifySpecPath(specPath)
    };
}
