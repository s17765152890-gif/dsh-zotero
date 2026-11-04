/** Bounded tool values backed by immutable Harness files and durable receipts. */
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import { z } from 'zod';
import type { ResolvedConfig } from './config.js';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'ptc-mode': {
            kind: 'ptc-mode';
        };
    }
}
/** Opaque path-safe keys work with every official storageDomain backend. */
export declare function resultReceiptKey(...coordinates: string[]): Promise<string>;
declare const receiptSchema: z.ZodObject<{
    delivery: z.ZodLiteral<"file">;
    version: z.ZodLiteral<1>;
    tool: z.ZodString;
    sessionId: z.ZodString;
    callId: z.ZodString;
    jobId: z.ZodOptional<z.ZodString>;
    summary: z.ZodString;
    file: z.ZodObject<{
        attachmentId: z.ZodString;
        name: z.ZodString;
        bytes: z.ZodNumber;
    }, z.core.$strict>;
    facts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
}, z.core.$strict>;
type Receipt = z.infer<typeof receiptSchema>;
export type DeliveredResult = {
    delivery: 'inline';
    data: JsonValue;
} | Receipt;
/** A registration transform applied to one tool definition before it is registered. */
export type ToolWrapper = (definition: ToolDefinition) => ToolDefinition;
/** The pass-through wrapper for registrations that need no delivery envelope. */
export declare const identityToolWrapper: ToolWrapper;
/** JSON encoder with bounded string chunks, including pathological single-line fields. */
export declare function jsonBytes(value: unknown, signal?: AbortSignal): AsyncGenerator<Uint8Array>;
export declare function isDelivered(value: unknown): value is DeliveredResult;
export declare function renderDelivered(value: DeliveredResult, render: (value: JsonValue) => ContentBlock[]): ContentBlock[];
export declare class ResultDelivery {
    private readonly ctx;
    private readonly config;
    private domain?;
    private readonly pending;
    private readonly outputs;
    /**
     * One publication per owning call. A foreground settle and a promotion can
     * both reach the same call after a timeout; deduplicating in flight keeps
     * them from streaming the same body twice.
     */
    private readonly publishing;
    constructor(ctx: Context, config: () => ResolvedConfig);
    track<T>(promise: Promise<T>): Promise<T>;
    private receipts;
    prepare(exec: ToolExecution, data: JsonValue, render: (value: JsonValue) => ContentBlock[], signal: AbortSignal, jobId?: string, facts?: JsonValue): Promise<DeliveredResult>;
    private publish;
    wrap(definition: ToolDefinition): ToolDefinition;
    receipt(sessionId: string, callId: string): Promise<Receipt | undefined>;
    installJobs(): void;
}
export {};
//# sourceMappingURL=result-delivery.d.ts.map