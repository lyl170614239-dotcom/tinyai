import { type ObservabilityEvent, type SourceConfidence } from "./event-schema.js";
import type { ConversationSnapshot } from "./conversation.js";
type CodexTurnSnapshotOptions = {
    taskId?: string;
    workspacePath?: string;
    snapshotKind?: string;
    sourceConfidence?: SourceConfidence;
};
export declare function codexSnapshotSignature(snapshot: ConversationSnapshot): string;
export declare function codexTurnSnapshotPayload(snapshot: ConversationSnapshot, options?: Pick<CodexTurnSnapshotOptions, "snapshotKind">): Record<string, unknown>;
export declare function buildCodexTurnSnapshotEvent(snapshot: ConversationSnapshot, options?: CodexTurnSnapshotOptions): ObservabilityEvent;
export {};
