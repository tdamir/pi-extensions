/**
 * Request-body guard for engines with a hard request-body limit.
 *
 * TensorFold rejects request bodies above 32 MiB (not configurable). Images
 * are re-sent with every request, and pi's token accounting counts each image
 * as ~1200 tokens regardless of its byte size, so the context-window based
 * auto-compaction never reacts to image bytes. This guard works on bytes
 * instead: before a request goes out it omits the oldest images from the
 * request (non-destructively - the session transcript keeps them) until the
 * estimated body fits the budget.
 *
 * To keep the provider's prompt cache useful, the omitted set is sticky: a
 * cutoff timestamp is remembered and every image at or before it stays omitted
 * on later requests. New images are only appended after the cutoff, so the
 * request prefix does not change between requests. The cutoff is advanced in
 * batches (hysteresis): when the body crosses the high watermark it is dropped
 * down to a low watermark, then left alone until the body grows past the high
 * watermark again. That makes a cache-invalidating change happen once per
 * batch of new images instead of once per image.
 *
 * The handlers that use these helpers live in index.ts; the pure helpers live
 * here so they can be tested in isolation.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { pickEngine } from "../llama-swap/engines";
import { collectUsageRecords } from "../llama-swap/stats";

/** TensorFold's hard request-body limit. */
export const TENSORFOLD_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
/** Room left for the system prompt, tool declarations and JSON overhead. */
export const BODY_GUARD_HEADROOM_BYTES = 4 * 1024 * 1024;
/** Smaller image budget used after a request was actually rejected. */
export const BODY_GUARD_RETRY_BUDGET_BYTES = 12 * 1024 * 1024;
/**
 * After pruning, the body is dropped to this fraction of the budget (the low
 * watermark). New images may then accumulate up to the full budget (the high
 * watermark) before the cutoff advances again - fewer cache invalidations.
 */
export const BODY_GUARD_LOW_WATERMARK_RATIO = 0.5;
/** Provider error text that means the body was too large (TensorFold / gateways). */
export const BODY_LIMIT_ERROR_RE =
	/request body exceeds|exceeds the \d+\s*(?:MiB|MB) limit|payload too large|request entity too large/i;

/** What an omitted image is replaced with in the request (the transcript keeps the image). */
export const BODY_GUARD_PLACEHOLDER =
	"[image omitted from this request to keep it under the server's request-body limit - the image is still in the session transcript. Read the file again if you need to inspect it.]";

/** Sent to the model after a benchmark run ended on a body-limit rejection. */
export const BODY_LIMIT_RECOVERY_PROMPT =
	"The previous request was rejected because the request body exceeded the server's 32 MiB limit. " +
	"Images have been dropped from the request context to fit the limit (they remain in the transcript). " +
	"Continue the task from where you left off. Read images one at a time, right before you need them, and prefer smaller captures.";

/** Session-scoped request-body guard state. */
export interface BodyGuardState {
	/** Engine that served the most recent request for the current model. */
	engine?: string;
	/** Estimated body-byte budget for one request (high watermark). */
	budgetBytes: number;
	/**
	 * Images in messages with `timestamp <= pruneBeforeMs` are omitted from
	 * requests. Remembered so the omitted set stays fixed between advances.
	 * -1 means nothing is omitted yet.
	 */
	pruneBeforeMs: number;
	/** Whether the user has already been told about pruning in this session. */
	notified: boolean;
	/** Unique images omitted from requests (not re-counted on every request). */
	prunedImages: number;
	/** How many times the cutoff advanced (batch prune steps). */
	pruneEvents: number;
}

export function createBodyGuardState(): BodyGuardState {
	return {
		engine: undefined,
		budgetBytes: TENSORFOLD_BODY_LIMIT_BYTES - BODY_GUARD_HEADROOM_BYTES,
		pruneBeforeMs: -1,
		notified: false,
		prunedImages: 0,
		pruneEvents: 0,
	};
}

export function resetBodyGuardState(state: BodyGuardState): void {
	state.engine = undefined;
	state.budgetBytes = TENSORFOLD_BODY_LIMIT_BYTES - BODY_GUARD_HEADROOM_BYTES;
	state.pruneBeforeMs = -1;
	state.notified = false;
	state.prunedImages = 0;
	state.pruneEvents = 0;
}

/** Minimal view of a message content block (only the fields the guard needs). */
interface GuardBlock {
	type: string;
	text?: string;
	textSignature?: string;
	thinking?: string;
	thinkingSignature?: string;
	data?: string;
	arguments?: unknown;
	thoughtSignature?: string;
}

function contentBlocks(message: AgentMessage): GuardBlock[] | undefined {
	const content = (message as { content?: unknown }).content;
	return Array.isArray(content) ? (content as GuardBlock[]) : undefined;
}

/**
 * Approximate the JSON bytes a message list produces as a request body.
 * Images dominate: their base64 `data` is sent verbatim, so summing the base64
 * lengths tracks the real body size far better than token estimates do.
 */
export function estimateBodyBytes(messages: AgentMessage[]): number {
	let bytes = 0;
	for (const message of messages) {
		bytes += 128; // per-message JSON keys and quoting
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") {
			bytes += content.length;
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content as GuardBlock[]) {
			switch (block.type) {
				case "text":
					bytes += (block.text ?? "").length + (block.textSignature ?? "").length;
					break;
				case "image":
					bytes += (block.data ?? "").length + 64; // data:<mime>;base64, prefix
					break;
				case "thinking":
					bytes += (block.thinking ?? "").length + (block.thinkingSignature ?? "").length;
					break;
				case "toolCall":
					bytes += JSON.stringify(block.arguments ?? {}).length + (block.thoughtSignature ?? "").length + 64;
					break;
			}
		}
	}
	return bytes;
}

/** One image block position inside the message list. */
interface ImageRef {
	messageIndex: number;
	blockIndex: number;
	/** Base64 payload length (the dominant part of the request bytes). */
	bytes: number;
	/** Timestamp of the message holding the image - the stable prune key. */
	timestamp: number;
}

export interface PruneResult {
	messages: AgentMessage[];
	/** Images omitted from this request (the whole sticky prune set). */
	dropped: number;
	/** Images newly added to the prune set by this call. */
	newlyDropped: number;
	/** Cutoff to remember for the next request. */
	pruneBeforeMs: number;
}

/**
 * Omit images from the request according to a sticky timestamp cutoff.
 *
 * - Every image in a message at or before `pruneBeforeMs` stays omitted.
 * - When the estimated body is still above `budgetBytes` (the high
 *   watermark), the cutoff advances until the body is back at or below the
 *   low watermark (`budgetBytes * BODY_GUARD_LOW_WATERMARK_RATIO`).
 * - Otherwise the cutoff is left alone, so the same set stays omitted and the
 *   request prefix is unchanged (prompt cache friendly) while new images are
 *   appended.
 *
 * Returns the rewritten messages (the input is not mutated) and the updated
 * cutoff, or undefined when there is nothing to omit.
 */
export function pruneImagesForBudget(
	messages: AgentMessage[],
	budgetBytes: number,
	pruneBeforeMs: number,
): PruneResult | undefined {
	const refs: ImageRef[] = [];
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex];
		const timestamp = (message as { timestamp?: number }).timestamp ?? 0;
		const content = contentBlocks(message);
		if (!content) continue;
		for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
			const block = content[blockIndex];
			if (block.type === "image") {
				refs.push({ messageIndex, blockIndex, bytes: (block.data ?? "").length, timestamp });
			}
		}
	}
	if (refs.length === 0) return undefined;

	const baseBytes = estimateBodyBytes(messages);
	const bytesWithCutoff = (cutoff: number): number => {
		let bytes = baseBytes;
		for (const ref of refs) {
			if (ref.timestamp <= cutoff) bytes += BODY_GUARD_PLACEHOLDER.length - ref.bytes;
		}
		return bytes;
	};

	const high = budgetBytes;
	const low = Math.max(0, Math.floor(budgetBytes * BODY_GUARD_LOW_WATERMARK_RATIO));
	let cutoff = pruneBeforeMs;
	let bytes = bytesWithCutoff(cutoff);

	// Advance the cutoff only when the high watermark is crossed, and drop all
	// the way down to the low watermark so the next advance is far away.
	if (bytes > high) {
		for (const ref of refs) {
			if (bytes <= low) break;
			if (ref.timestamp <= cutoff) continue; // already omitted
			cutoff = Math.max(cutoff, ref.timestamp);
			bytes = bytesWithCutoff(cutoff);
		}
	}

	let dropped = 0;
	let newlyDropped = 0;
	for (const ref of refs) {
		if (ref.timestamp > cutoff) continue;
		dropped++;
		if (ref.timestamp > pruneBeforeMs) newlyDropped++;
	}
	if (dropped === 0) return undefined;

	const out = messages.slice();
	for (const ref of refs) {
		if (ref.timestamp > cutoff) continue;
		const content = [...(contentBlocks(out[ref.messageIndex]) ?? [])];
		content[ref.blockIndex] = { type: "text", text: BODY_GUARD_PLACEHOLDER };
		out[ref.messageIndex] = { ...(out[ref.messageIndex] as object), content } as unknown as AgentMessage;
	}
	return { messages: out, dropped, newlyDropped, pruneBeforeMs: cutoff };
}

/**
 * Engine that served the most recent request for `modelId`, from the
 * llama-swap usage records persisted in the session. Records for other models
 * on the same server are skipped (a server can front several engines).
 */
export function detectEngine(entries: SessionEntry[], modelId: string | undefined): string | undefined {
	const records = collectUsageRecords(entries);
	// Records whose response carried no model name still describe this server;
	// keep the newest one as a fallback when no record matches the model.
	let unknownModelEngine: string | undefined;
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i].record;
		const engine = pickEngine(record);
		if (!engine) continue;
		const served = record.model;
		if (!served) {
			unknownModelEngine ??= engine.id;
			continue;
		}
		if (!modelId || served === modelId || served.startsWith(modelId) || modelId.startsWith(served)) {
			return engine.id;
		}
	}
	return unknownModelEngine;
}

/** Did the run's last assistant message fail because the request body was too large? */
export function runEndedWithBodyLimitError(ctx: ExtensionContext, startedAt: Date): boolean {
	const startMs = startedAt.getTime() - 5000;
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		if (Number.isFinite(at) && at < startMs) return false; // from a previous run
		return entry.message.stopReason === "error" && BODY_LIMIT_ERROR_RE.test(entry.message.errorMessage ?? "");
	}
	return false;
}
