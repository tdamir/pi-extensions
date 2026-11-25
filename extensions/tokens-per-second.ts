/**
 * Tokens-per-second extension - shows measured token generation speed of the
 * currently running turn in the footer status bar.
 *
 * The rate is measured locally, without relying on usage metrics reported by
 * the engine/provider: every streamed delta (text, thinking, tool-call
 * arguments) is counted and converted to an approximate token count
 * (chars / CHARS_PER_TOKEN, matching pi's own estimator). Elapsed time only
 * accumulates while tokens are actually streaming, so tool execution and
 * other gaps do not drag the number down.
 *
 * Nothing is written to the session log; the rate lives only in the footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tokens-per-sec";
const TICK_MS = 500; // status refresh interval while streaming
const CHARS_PER_TOKEN = 3.5; // same constant pi uses in its own estimator

export default function tokensPerSecondExtension(pi: ExtensionAPI) {
	// Latest context (for ui/theme access from the timer callback).
	let lastCtx: ExtensionContext | undefined;

	// Completed streaming in the current turn (previous assistant messages).
	let turnStreamMs = 0;
	let turnTokens = 0;

	// The assistant message currently streaming (null between messages).
	let streamStart: number | null = null;
	let streamChars = 0;

	let timer: ReturnType<typeof setInterval> | undefined;
	let lastRendered: string | undefined;

	const estTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

	const stopTimer = (): void => {
		if (timer !== undefined) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	/** Tokens/s across all streaming time of the current turn. */
	const currentRate = (now: number): number | undefined => {
		let ms = turnStreamMs;
		let tokens = turnTokens;
		if (streamStart !== null) {
			ms += Math.max(0, now - streamStart);
			tokens += estTokens(streamChars);
		}
		// Grace period: with a tiny window the rate is meaningless (e.g. one
		// delta within the first few hundred ms would show ~1000 tok/s).
		if (ms < 800 || tokens <= 0) return undefined;
		return tokens / (ms / 1000);
	};

	const render = (): void => {
		const ctx = lastCtx;
		if (!ctx?.hasUI) return;
		const rate = currentRate(Date.now());
		const text =
			rate === undefined
				? undefined
				: ctx.ui.theme.fg("accent", `⚡ ${rate >= 100 ? rate.toFixed(0) : rate.toFixed(1)} tok/s`);
		if (text === lastRendered) return;
		lastRendered = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	const reset = (ctx: ExtensionContext): void => {
		lastCtx = ctx;
		stopTimer();
		turnStreamMs = 0;
		turnTokens = 0;
		streamStart = null;
		streamChars = 0;
		if (lastRendered !== undefined) {
			lastRendered = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTimer();
	});

	pi.on("turn_start", async (_event, ctx) => {
		reset(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		lastCtx = ctx;
		if (event.message.role !== "assistant") return;

		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) {
			return;
		}

		if (streamStart === null) {
			streamStart = Date.now();
			if (timer === undefined) timer = setInterval(render, TICK_MS);
		}
		streamChars += streamEvent.delta.length;
		render();
	});

	pi.on("message_end", async (event, ctx) => {
		lastCtx = ctx;
		if (event.message.role !== "assistant" || streamStart === null) return;

		// Freeze this message's streaming time and tokens into the turn totals.
		turnStreamMs += Math.max(0, Date.now() - streamStart);
		turnTokens += estTokens(streamChars);
		streamStart = null;
		streamChars = 0;
		stopTimer();
		render(); // keep showing the frozen rate (e.g. while tools run)
	});

	pi.on("turn_end", async (_event, ctx) => {
		lastCtx = ctx;
		stopTimer();
		render();
	});

	// Agent will not continue automatically - drop the stale rate.
	pi.on("agent_settled", async (_event, ctx) => {
		lastCtx = ctx;
		stopTimer();
		if (lastRendered !== undefined) {
			lastRendered = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}
