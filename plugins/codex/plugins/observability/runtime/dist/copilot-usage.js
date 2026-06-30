function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function isoTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (typeof value === "string" && value.trim()) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    return undefined;
}
function cleanModel(value) {
    if (typeof value !== "string" || !value.trim())
        return undefined;
    return value.trim().replace(/^copilot\//, "");
}
function creditsFromDetails(value) {
    if (typeof value !== "string")
        return undefined;
    const match = /(?:^|[^\d])(\d+(?:\.\d+)?)\s*credits?\b/i.exec(value);
    return match ? Number(match[1]) : undefined;
}
function requestId(request, index, sessionId) {
    const value = request.requestId || request.id || request.request_id;
    if (typeof value === "string" && value.trim())
        return value.trim();
    return `${sessionId || "copilot"}:request:${index}`;
}
function setNumber(target, key, value) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) {
        target[key] = parsed;
    }
}
function applyResult(target, value) {
    const result = record(value);
    if (!result)
        return;
    const metadata = record(result.metadata);
    const timings = record(result.timings);
    const resolvedModel = cleanModel(metadata?.resolvedModel || result.resolvedModel);
    if (resolvedModel)
        target.model = resolvedModel;
    setNumber(target, "prompt_tokens", metadata?.promptTokens ?? result.promptTokens);
    setNumber(target, "output_tokens", metadata?.outputTokens ?? result.outputTokens);
    setNumber(target, "completion_tokens", metadata?.completionTokens ?? result.completionTokens);
    if (target.elapsed_ms === undefined)
        setNumber(target, "elapsed_ms", timings?.totalElapsed);
    const directCredits = finiteNumber(result.copilotCredits ?? metadata?.copilotCredits);
    if (directCredits !== undefined) {
        target.copilot_credits = directCredits;
        target.credits_source = "direct";
    }
    else if (target.copilot_credits === undefined) {
        const derivedCredits = creditsFromDetails(result.details);
        if (derivedCredits !== undefined) {
            target.copilot_credits = derivedCredits;
            target.credits_source = "details";
        }
    }
}
function applyRequest(target, request) {
    const model = cleanModel(record(request.result)?.metadata && record(record(request.result)?.metadata)?.resolvedModel)
        || cleanModel(record(request.result)?.resolvedModel)
        || cleanModel(request.resolvedModel)
        || cleanModel(request.modelId);
    if (model)
        target.model = model;
    const occurredAt = isoTimestamp(request.timestamp ?? request.createdAt);
    if (occurredAt)
        target.occurred_at = occurredAt;
    setNumber(target, "prompt_tokens", request.promptTokens);
    setNumber(target, "output_tokens", request.outputTokens);
    setNumber(target, "completion_tokens", request.completionTokens);
    setNumber(target, "elapsed_ms", request.elapsedMs);
    const directCredits = finiteNumber(request.copilotCredits);
    if (directCredits !== undefined) {
        target.copilot_credits = directCredits;
        target.credits_source = "direct";
    }
    applyResult(target, request.result);
}
export function parseCopilotRequestUsage(entries) {
    let sessionId;
    let title;
    let startedAt;
    let nextRequestIndex = 0;
    const usages = new Map();
    const usageAt = (index) => {
        let usage = usages.get(index);
        if (!usage) {
            usage = {
                request_id: `${sessionId || "copilot"}:request:${index}`,
                request_index: index
            };
            usages.set(index, usage);
        }
        return usage;
    };
    const registerRequest = (value, index) => {
        const request = record(value);
        if (!request)
            return;
        const usage = usageAt(index);
        usage.request_id = requestId(request, index, sessionId);
        applyRequest(usage, request);
        nextRequestIndex = Math.max(nextRequestIndex, index + 1);
    };
    for (const entry of entries) {
        const kind = finiteNumber(entry.kind);
        if (kind === 0) {
            const snapshot = record(entry.v);
            if (!snapshot)
                continue;
            if (typeof snapshot.sessionId === "string" && snapshot.sessionId.trim())
                sessionId = snapshot.sessionId.trim();
            if (typeof snapshot.customTitle === "string" && snapshot.customTitle.trim())
                title = snapshot.customTitle.trim();
            startedAt = isoTimestamp(snapshot.creationDate) || startedAt;
            const requests = Array.isArray(snapshot.requests) ? snapshot.requests : [];
            requests.forEach((request, index) => registerRequest(request, index));
            continue;
        }
        const path = Array.isArray(entry.k) ? entry.k : [];
        if (path.length === 1 && path[0] === "customTitle" && typeof entry.v === "string") {
            title = entry.v.trim() || title;
            continue;
        }
        if (kind === 2 && path.length === 1 && path[0] === "requests" && Array.isArray(entry.v)) {
            for (const request of entry.v)
                registerRequest(request, nextRequestIndex);
            continue;
        }
        if (path.length < 3 || path[0] !== "requests" || typeof path[1] !== "number")
            continue;
        const usage = usageAt(path[1]);
        const field = String(path[2]);
        if (field === "result") {
            applyResult(usage, entry.v);
        }
        else if (field === "modelId" || field === "resolvedModel") {
            const model = cleanModel(entry.v);
            if (model)
                usage.model = model;
        }
        else if (field === "timestamp" || field === "createdAt") {
            const occurredAt = isoTimestamp(entry.v);
            if (occurredAt)
                usage.occurred_at = occurredAt;
        }
        else if (field === "promptTokens") {
            setNumber(usage, "prompt_tokens", entry.v);
        }
        else if (field === "outputTokens") {
            setNumber(usage, "output_tokens", entry.v);
        }
        else if (field === "completionTokens") {
            setNumber(usage, "completion_tokens", entry.v);
        }
        else if (field === "elapsedMs") {
            setNumber(usage, "elapsed_ms", entry.v);
        }
        else if (field === "copilotCredits") {
            const credits = finiteNumber(entry.v);
            if (credits !== undefined) {
                usage.copilot_credits = credits;
                usage.credits_source = "direct";
            }
        }
        else if (field === "details" && usage.credits_source !== "direct") {
            const credits = creditsFromDetails(entry.v);
            if (credits !== undefined) {
                usage.copilot_credits = credits;
                usage.credits_source = "details";
            }
        }
    }
    const requestUsage = [...usages.values()].sort((left, right) => left.request_index - right.request_index);
    const usageTotals = requestUsage.reduce((totals, usage) => ({
        prompt_tokens: totals.prompt_tokens + (usage.prompt_tokens ?? 0),
        output_tokens: totals.output_tokens + (usage.output_tokens ?? 0),
        completion_tokens: totals.completion_tokens + (usage.completion_tokens ?? 0),
        elapsed_ms: totals.elapsed_ms + (usage.elapsed_ms ?? 0),
        copilot_credits: Math.round((totals.copilot_credits + (usage.copilot_credits ?? 0)) * 1000) / 1000
    }), { prompt_tokens: 0, output_tokens: 0, completion_tokens: 0, elapsed_ms: 0, copilot_credits: 0 });
    const resolvedModel = [...requestUsage].reverse().find((usage) => usage.model)?.model;
    return {
        sessionId,
        title,
        startedAt,
        resolvedModel,
        requestUsage,
        usageTotals,
        requestCount: requestUsage.length
    };
}
