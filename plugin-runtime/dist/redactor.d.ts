export interface RedactOptions {
    allowFullConversationText?: boolean;
}
export declare function redactText(value: string, options?: RedactOptions): string;
export declare function redact(value: unknown, options?: RedactOptions): unknown;
