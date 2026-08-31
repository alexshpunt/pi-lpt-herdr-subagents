import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface SubagentTreeMetadata {
    readonly value: unknown;
    /** Immutable package-owned identity; value is the consumer-owned opaque metadata. */
    readonly callerId?: string;
    readonly treeId?: string;
    readonly ownerId?: string;
    readonly nodeId?: string;
    readonly parentId?: string;
}
export interface SubagentError {
    readonly code: string;
    readonly message: string;
}
export interface SubagentWorktree {
    readonly path?: string;
    readonly branch?: string;
    readonly baseRef?: string;
    readonly baseSha?: string;
    readonly workspaceId?: string;
    readonly paneId?: string;
    readonly headSha?: string | null;
    readonly commitsAhead?: number | null;
    readonly clean?: boolean | null;
    readonly conflicted?: boolean | null;
    readonly changedFiles?: string[] | null;
    readonly untrackedFiles?: string[] | null;
    readonly manifestFile?: string;
}
export type SubagentChildOutcome = "clean" | "empty" | "error" | "intentional-abort" | "unexpected-abort";
export interface SubagentChildResult {
    readonly resultId: string;
    readonly assistantEntryId: string;
    readonly answer: string | null;
    readonly outcome: SubagentChildOutcome;
    readonly sessionReference?: string;
    readonly error?: SubagentError;
    readonly worktree?: SubagentWorktree;
    readonly metadata?: SubagentTreeMetadata;
}
export interface SubagentNodeResult {
    readonly nodeId: string;
    readonly parentId: string;
    readonly outcome: SubagentChildOutcome;
    readonly open: boolean;
    readonly sessionReference?: string;
    readonly error?: SubagentError;
}
export interface SubagentTreeResult {
    readonly terminalId: string;
    readonly state: "completed" | "failed" | "cancelled";
    readonly rootResult: SubagentChildResult;
    readonly callerMetadata: SubagentTreeMetadata;
    readonly nodes: readonly SubagentNodeResult[];
    readonly error?: SubagentError;
}
export interface SubagentChildHandle {
    readonly nodeId: string;
    readonly parentId: string;
    readonly result: Promise<SubagentChildResult>;
}
export interface LaunchChildOptions {
    readonly parentId: string;
    readonly name: string;
    readonly task: string;
    readonly agent?: string;
    readonly model?: string;
    readonly thinking?: ThinkingLevel;
    readonly skills?: string;
    readonly tools: readonly string[];
    readonly cwd?: string;
    readonly worktree?: {
        readonly branch: string;
        readonly base?: string;
    };
    readonly metadata?: unknown;
}
export interface SubagentTreeHandle {
    readonly callerId: string;
    readonly treeId: string;
    readonly ownershipToken: string;
    readonly ownerId: string;
    readonly children: ReadonlyMap<string, SubagentChildHandle>;
    readonly result: Promise<SubagentTreeResult>;
    launchChild(options: LaunchChildOptions): Promise<SubagentChildHandle>;
    bindFinalCallback(callback: (result: SubagentTreeResult) => void | Promise<void>): void;
    cancel(): Promise<SubagentTreeResult>;
}
export interface CreateSubagentTreeOptions {
    readonly pi: ExtensionAPI;
    readonly ctx: ExtensionContext;
    readonly metadata?: unknown;
}
export interface ForkLineage {
    readonly previousSessionFile: string;
}
export interface AttachSubagentTreeOptions {
    readonly pi: ExtensionAPI;
    readonly ctx: ExtensionContext;
    readonly callerId?: string;
    readonly treeId?: string;
    readonly ownershipToken?: string;
    readonly forkLineage?: ForkLineage;
}
export declare class SubagentTreeError extends Error {
    constructor(message: string);
}
export declare class SubagentTreeValidationError extends SubagentTreeError {
    constructor(message: string);
}
export declare class SubagentTreeOwnershipError extends SubagentTreeError {
    constructor(message: string);
}
/** Create a caller-owned tree. Importing this module performs no registration. */
export declare function createSubagentTree(options: CreateSubagentTreeOptions): SubagentTreeHandle;
/** Reattach a caller or claim a child branch using its package context. */
export declare function attachSubagentTree(options: AttachSubagentTreeOptions): SubagentTreeHandle;
