export type SpecScope = "personal" | "official" | "catalog" | "unknown";
export interface SpecClassification {
    spec_scope: SpecScope;
    doc_path: string;
    via_catalog: boolean;
    matched_by: string[];
    fallback_used: boolean;
}
export declare function classifySpecPath(filePath: string): SpecClassification;
export declare function searchSpecs(workspacePath: string, query: string): Promise<Array<{
    path: string;
    excerpt: string;
    matched_by: string[];
}>>;
export declare function readSpec(workspacePath: string, specPath: string): Promise<{
    path: string;
    content: string;
    classification: SpecClassification;
}>;
