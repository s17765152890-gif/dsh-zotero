import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { RESULT_RECEIPT_PREFIX } from './constants.js';
import { asRecord } from './json.js';
/** Opaque path-safe keys work with every official storageDomain backend. */
export async function resultReceiptKey(...coordinates) {
    const bytes = new TextEncoder().encode(JSON.stringify(coordinates));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const fileSchema = z
    .object({
    attachmentId: z.string().min(1),
    name: z.string().min(1),
    bytes: z.number().int().nonnegative(),
})
    .strict();
const receiptSchema = z
    .object({
    delivery: z.literal('file'),
    version: z.literal(1),
    tool: z.string().max(64),
    sessionId: z.string(),
    callId: z.string(),
    jobId: z.string().optional(),
    summary: z.string().max(256),
    file: fileSchema,
    facts: z.record(z.string(), z.json()).optional(),
})
    .strict();
const resultDomain = defineDomain({
    name: 'zotero_results',
    version: 1,
    layout: 'per-record',
    tables: { receipts: domainTable(receiptSchema) },
});
/** The pass-through wrapper for registrations that need no delivery envelope. */
export const identityToolWrapper = (definition) => definition;
/** JSON encoder with bounded string chunks, including pathological single-line fields. */
export async function* jsonBytes(value, signal) {
    const encode = (text) => new TextEncoder().encode(text);
    signal?.throwIfAborted();
    if (typeof value === 'string') {
        yield encode('"');
        for (let offset = 0; offset < value.length;) {
            signal?.throwIfAborted();
            let end = Math.min(value.length, offset + 4096);
            if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]))
                end--;
            yield encode(JSON.stringify(value.slice(offset, end)).slice(1, -1));
            offset = end;
        }
        yield encode('"');
    }
    else if (Array.isArray(value)) {
        yield encode('[');
        for (let index = 0; index < value.length; index++) {
            if (index > 0)
                yield encode(',');
            yield* jsonBytes(value[index] ?? null, signal);
        }
        yield encode(']');
    }
    else if (value !== null && typeof value === 'object') {
        yield encode('{');
        let first = true;
        for (const [key, entry] of Object.entries(value)) {
            if (entry === undefined)
                continue;
            if (!first)
                yield encode(',');
            first = false;
            yield encode(`${JSON.stringify(key)}:`);
            yield* jsonBytes(entry, signal);
        }
        yield encode('}');
    }
    else
        yield encode(JSON.stringify(value) ?? 'null');
}
export function isDelivered(value) {
    const record = asRecord(value);
    return record?.delivery === 'inline' || record?.delivery === 'file';
}
export function renderDelivered(value, render) {
    return value.delivery === 'inline'
        ? render(value.data)
        : [
            {
                type: 'text',
                text: `${RESULT_RECEIPT_PREFIX}${JSON.stringify(value)}\nFull versioned JSON is in the attached file. Parse with run_code Node file APIs for long fields; line-based read previews may truncate individual lines.`,
            },
            { type: 'file', attachment: value.file },
        ];
}
export class ResultDelivery {
    ctx;
    config;
    domain;
    pending = new Set();
    outputs = new Map();
    /**
     * One publication per owning call. A foreground settle and a promotion can
     * both reach the same call after a timeout; deduplicating in flight keeps
     * them from streaming the same body twice.
     */
    publishing = new Map();
    constructor(ctx, config) {
        this.ctx = ctx;
        this.config = config;
        ctx.effect(() => async () => {
            while (this.pending.size)
                await Promise.allSettled([...this.pending]);
            if (this.domain)
                await (await this.domain).close();
        });
    }
    track(promise) {
        this.pending.add(promise);
        void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
        return promise;
    }
    async receipts() {
        if (!this.domain) {
            const facility = this.ctx.get('storageDomain');
            if (!facility)
                throw new Error('Complete result delivery requires storageDomain and attachments services.');
            const opening = facility.open(resultDomain);
            this.domain = opening;
            void opening.catch(() => {
                if (this.domain === opening)
                    this.domain = undefined;
            });
        }
        return (await this.domain).table('receipts');
    }
    async prepare(exec, data, render, signal, jobId, facts) {
        const dedupeKey = `${exec.agent?.session?.header.id ?? ''}:${exec.callId}`;
        const running = this.publishing.get(dedupeKey);
        if (running)
            return await running;
        const task = this.publish(exec, data, render, signal, jobId, facts);
        this.publishing.set(dedupeKey, task);
        try {
            return await task;
        }
        finally {
            if (this.publishing.get(dedupeKey) === task)
                this.publishing.delete(dedupeKey);
        }
    }
    async publish(exec, data, render, signal, jobId, facts) {
        const config = this.config();
        if (jobId === undefined) {
            let bytes = 0;
            for await (const chunk of jsonBytes({ delivery: 'inline', data }, signal)) {
                bytes += chunk.byteLength;
                if (bytes > config.maxInlineResultBytes)
                    break;
            }
            if (bytes <= config.maxInlineResultBytes) {
                const content = render(data);
                const canonical = JSON.stringify({ delivery: 'inline', data });
                if (estimateContent([{ type: 'text', text: canonical }]) <= config.maxInlineResultTokens &&
                    estimateContent(content) <= config.maxInlineResultTokens &&
                    new TextEncoder().encode(JSON.stringify(content)).byteLength <=
                        config.maxInlineResultBytes)
                    return { delivery: 'inline', data };
            }
        }
        const attachments = this.ctx.get('attachments');
        const sessionId = exec.agent?.session?.header.id;
        if (!attachments || sessionId === undefined)
            throw new Error('Complete result delivery requires attachments and an owning Session.');
        const table = await this.receipts();
        const key = await resultReceiptKey(sessionId, exec.callId);
        const existing = table.get(key);
        const projection = asRecord(facts ?? this.outputs.get(exec.name)?.presentationMeta?.(exec.arguments, data));
        const record = asRecord(data);
        if (projection && typeof record?.outputFile === 'string')
            Object.assign(projection, {
                outputFile: record.outputFile,
                delivered: record.delivered === true,
            });
        const file = existing?.file ??
            (await attachments.saveFileStream({
                name: `${exec.name}-result.json`,
                signal,
                data: jsonBytes({ version: 1, tool: exec.name, request: exec.arguments, data }, signal),
            }));
        signal.throwIfAborted();
        const receipt = receiptSchema.parse({
            delivery: 'file',
            version: 1,
            tool: exec.name,
            sessionId,
            callId: exec.callId,
            ...(jobId ? { jobId } : {}),
            summary: `${exec.name}: full result persisted (${file.bytes} bytes).`,
            file,
            ...(asRecord(projection) ? { facts: projection } : {}),
        });
        const fits = () => {
            const content = renderDelivered(receipt, render);
            return (estimateContent([{ type: 'text', text: JSON.stringify(receipt) }]) <=
                config.maxInlineResultTokens &&
                estimateContent(content) <= config.maxInlineResultTokens &&
                new TextEncoder().encode(JSON.stringify(receipt)).byteLength <=
                    config.maxInlineResultBytes &&
                new TextEncoder().encode(JSON.stringify(content)).byteLength <= config.maxInlineResultBytes);
        };
        // Only previews may be omitted; ownership, file and completeness facts survive.
        for (const field of ['items', 'notesPreview', 'annotationsPreview']) {
            if (fits())
                break;
            if (receipt.facts?.[field] !== undefined) {
                delete receipt.facts[field];
                receipt.facts.detailOmitted = true;
            }
        }
        if (!fits())
            throw new Error('Result reference exceeds the configured inline budget.');
        await table.put(key, receipt);
        if (jobId)
            await table.put(await resultReceiptKey('job', sessionId, jobId), receipt);
        signal.throwIfAborted();
        return receipt;
    }
    wrap(definition) {
        const output = definition.output;
        this.outputs.set(definition.name, output);
        const jobArms = output.schema.oneOf?.filter((arm) => ['background', 'promoted'].includes(String(arm.properties?.kind?.const))) ?? [];
        return {
            ...definition,
            output: {
                schema: {
                    oneOf: [
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['delivery', 'data'],
                            properties: { delivery: { type: 'string', const: 'inline' }, data: output.schema },
                        },
                        {
                            type: 'object',
                            additionalProperties: false,
                            required: ['delivery', 'version', 'tool', 'summary', 'file', 'sessionId', 'callId'],
                            properties: {
                                delivery: { type: 'string', const: 'file' },
                                version: { type: 'integer', const: 1 },
                                tool: { type: 'string' },
                                summary: { type: 'string' },
                                file: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['attachmentId', 'name', 'bytes'],
                                    properties: {
                                        attachmentId: { type: 'string' },
                                        name: { type: 'string' },
                                        bytes: { type: 'integer' },
                                    },
                                },
                                sessionId: { type: 'string' },
                                callId: { type: 'string' },
                                jobId: { type: 'string' },
                                facts: { type: 'object' },
                            },
                        },
                        ...jobArms,
                    ],
                },
                render: (args, value) => isDelivered(value)
                    ? renderDelivered(value, (data) => output.render(args, data))
                    : output.render(args, value),
                presentationMeta: (args, value) => {
                    if (!isDelivered(value))
                        return output.presentationMeta?.(args, value) ?? {};
                    if (value.delivery === 'file')
                        return { ...value.facts, ...value };
                    const meta = asRecord(output.presentationMeta?.(args, value.data)) ?? {};
                    const data = asRecord(value.data);
                    return {
                        ...meta,
                        delivery: 'inline',
                        ...(definition.name === 'zotero_export'
                            ? {
                                text: typeof data?.text === 'string'
                                    ? data.text
                                    : output
                                        .render(args, value.data)
                                        .filter((block) => block.type === 'text')
                                        .map((block) => block.text)
                                        .join('\n'),
                            }
                            : {}),
                    };
                },
            },
            execute: (args, exec) => this.track((async () => {
                const value = (await definition.execute(args, exec));
                if (isDelivered(value) ||
                    ['background', 'promoted'].includes(String(asRecord(value)?.kind)))
                    return value;
                const violations = validateJsonSchemaValue(output.schema, value);
                if (violations.length)
                    throw new Error(`Invalid ${definition.name} result: ${violations.join('; ')}`);
                const delivered = await this.prepare(exec, value, (data) => output.render(args, data), exec.signal, undefined, output.presentationMeta?.(args, value));
                if (exec.parent && delivered.delivery === 'file')
                    exec.deferContext(createUserMessage({
                        content: renderDelivered(delivered, () => []),
                        source: { kind: 'ptc-mode' },
                    }));
                return delivered;
            })()),
        };
    }
    async receipt(sessionId, callId) {
        return (await this.receipts()).get(await resultReceiptKey(sessionId, callId));
    }
    installJobs() {
        this.ctx.on('tools/post-execute', async (exec, result, next) => {
            if (exec.name !== 'job_output' || result.isError || !exec.agent)
                return next();
            const jobId = asRecord(exec.arguments)?.job_id;
            if (typeof jobId !== 'string')
                return next();
            const job = this.ctx
                .get('jobs')
                ?.list(exec.agent.id)
                .find((entry) => entry.id === jobId);
            if (!job ||
                job.kind !== 'zotero' ||
                job.owner !== exec.agent.id ||
                job.status !== 'completed')
                return next();
            const receipt = (await this.receipts()).get(await resultReceiptKey('job', exec.agent.session.header.id, jobId));
            if (!receipt)
                return next();
            const decision = await next();
            if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value'))
                return decision;
            const content = renderDelivered(receipt, () => []);
            return {
                kind: 'accept',
                content: [...(decision.content ?? result.content), ...content],
                additionalContexts: [
                    ...(decision.additionalContexts ?? []),
                    ...(exec.parent ? [createUserMessage({ content, source: { kind: 'ptc-mode' } })] : []),
                ],
            };
        });
    }
}
//# sourceMappingURL=result-delivery.js.map