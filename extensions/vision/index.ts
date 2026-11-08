/**
 * Vision extension - inspect images without loading them into the conversation.
 *
 * Tool:
 * - `analyze_image` - answers a question about an image file via a nested
 *   vision-model call. The image itself never enters the session transcript;
 *   only the text answer does. This keeps provider request bodies small, which
 *   matters for long sessions and engines with request-body limits (e.g.
 *   TensorFold's 32 MB cap).
 *
 * Model selection:
 * - Default: the current session model, when it accepts image input.
 * - Fallback: `vision.analyzeModel` ("provider/model-id") from settings.json,
 *   used when the session model cannot see images (e.g. text-only coder models
 *   during benchmarks). A fixed judge model also keeps comparisons consistent
 *   across benchmark runs.
 *
 * Pairs with the built-in `images.blockImages: true` setting, which strips every
 * image from what is sent to the model (replaced by "Image reading is disabled."
 * placeholders). With both enabled, request bodies stay small by construction
 * while the agent can still inspect images on demand through this tool.
 */

import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Default downscale target for model-facing images (matches the screenshot tool). */
const DEFAULT_MAX_WIDTH = 1600;
/** Default downscale target for height (pi's resizeImage default). */
const DEFAULT_MAX_HEIGHT = 2000;

/** Upper bound for the fallback path (no resize available): ~20 MB of image bytes. */
const MAX_FALLBACK_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const ANALYSIS_SYSTEM_PROMPT = `You are a precise visual inspection assistant. Answer the question about the attached image.
Be factual and concise, and point at visible evidence (text, elements, colors, layout) when relevant.
If the image does not show what is asked about, say so explicitly instead of guessing.`;

const AnalyzeImageParams = Type.Object({
	path: Type.String({
		description: "Path to the image file (PNG, JPEG, GIF, WebP, or BMP). Relative paths resolve against the working directory.",
	}),
	question: Type.String({
		description:
			"What to check or answer about the image. Be specific, e.g. " +
			"'Does the settings page render correctly? List any overlapping, cut-off, or misaligned elements.'",
	}),
	maxWidth: Type.Optional(
		Type.Number({
			description: `Downscale the image to at most this width in pixels before sending (default ${DEFAULT_MAX_WIDTH}). Images already within the limits are sent unchanged.`,
		}),
	),
	maxHeight: Type.Optional(
		Type.Number({
			description: `Downscale the image to at most this height in pixels before sending (default ${DEFAULT_MAX_HEIGHT}).`,
		}),
	),
});

interface AnalyzeImageDetails {
	/** Model that produced the answer ("provider/id"). */
	model: string;
	/** Where the model came from: the session model or the vision.analyzeModel setting. */
	modelSource: "session" | "settings";
	imagePath: string;
	/** Dimensions of the image that was actually sent. */
	width?: number;
	height?: number;
	/** Original dimensions, when the image was downscaled. */
	originalWidth?: number;
	originalHeight?: number;
	wasResized: boolean;
}

/** Model reference for messages and details: "provider/id". */
function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function analyzeModelSetting(pi: ExtensionAPI): string | undefined {
	// `vision` is a custom section, so read it through an index signature.
	const settings = pi.getSettings() as Record<string, unknown>;
	const vision = settings.vision as Record<string, unknown> | undefined;
	const value = vision?.analyzeModel;
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.trim();
}

/**
 * Pick the model for image analysis: the session model when it accepts images,
 * otherwise the configured fallback. Throws with actionable guidance otherwise.
 */
function resolveVisionModel(
	pi: ExtensionAPI,
	ctx: ExtensionToolContext,
): { model: Model<Api>; source: "session" | "settings" } {
	const sessionModel = ctx.model as Model<Api> | undefined;
	if (sessionModel?.input.includes("image")) {
		return { model: sessionModel, source: "session" };
	}

	const fallback = analyzeModelSetting(pi);
	if (fallback) {
		const slash = fallback.indexOf("/");
		const provider = slash === -1 ? fallback : fallback.slice(0, slash);
		const id = slash === -1 ? "" : fallback.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, id) as Model<Api> | undefined;
		if (!model) {
			throw new Error(
				`vision.analyzeModel "${fallback}" does not match a known model (provider "${provider}", id "${id}").`,
			);
		}
		if (!model.input.includes("image")) {
			throw new Error(`vision.analyzeModel "${fallback}" does not accept image input.`);
		}
		return { model, source: "settings" };
	}

	const current = sessionModel ? modelRef(sessionModel) : "(no model selected)";
	throw new Error(
		`The current model ${current} cannot accept images. ` +
			`Switch to a vision-capable model, or set "vision": { "analyzeModel": "provider/model-id" } in settings.json ` +
			`to analyze images with a dedicated model.`,
	);
}

export default function visionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description:
			"Answer a question about an image file (path + question) with a vision model and return only the text answer. " +
			"The image is NOT added to the conversation, so request bodies stay small - use this instead of loading images " +
			"into the session (screenshots, read on image files) when the session is long or the engine limits request size " +
			"(e.g. TensorFold's 32 MB body cap). Uses the current session model when it accepts images; otherwise the model " +
			'configured via the "vision.analyzeModel" setting ("provider/model-id"). ' +
			"Ask one focused question per call; call again with a follow-up question if needed.",
		promptSnippet: "answer questions about image files without loading them into the conversation",
		promptGuidelines: [
			"When you need to know what an image file shows, use analyze_image with the file path and a specific question. " +
				"It answers with text and keeps the image out of the conversation, which keeps request bodies small. " +
				"Prefer it over viewing images directly once the session is long, and for verifying screenshots or rendered output.",
		],
		parameters: AnalyzeImageParams,
		annotations: { readOnlyHint: true },
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const imagePath = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);

			let bytes: Buffer;
			try {
				bytes = await readFile(imagePath);
			} catch (err) {
				throw new Error(`Cannot read image file ${imagePath}: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (bytes.byteLength === 0) {
				throw new Error(`Image file is empty: ${imagePath}`);
			}

			const mimeType = MIME_TYPES[extname(imagePath).toLowerCase()];
			if (!mimeType) {
				throw new Error(`Unsupported image type: ${imagePath} (expected PNG, JPEG, GIF, WebP, or BMP)`);
			}

			const { model, source } = resolveVisionModel(pi, ctx);

			// pi's built-in Photon pipeline: fits the image within the pixel and byte limits
			// and picks the cheapest encoding (PNG vs JPEG). Returns null when resizing is
			// unavailable; fall back to the original bytes, refusing absurd sizes.
			const resized = await resizeImage(new Uint8Array(bytes), mimeType, {
				maxWidth: params.maxWidth ?? DEFAULT_MAX_WIDTH,
				maxHeight: params.maxHeight ?? DEFAULT_MAX_HEIGHT,
			});

			let data: string;
			let sentMimeType = mimeType;
			let details: AnalyzeImageDetails;
			let note: string | undefined;

			if (resized) {
				data = resized.data;
				sentMimeType = resized.mimeType;
				details = {
					model: modelRef(model),
					modelSource: source,
					imagePath,
					width: resized.width,
					height: resized.height,
					wasResized: resized.wasResized,
				};
				if (resized.wasResized) {
					details.originalWidth = resized.originalWidth;
					details.originalHeight = resized.originalHeight;
					note = formatDimensionNote(resized);
				}
			} else {
				if (bytes.byteLength > MAX_FALLBACK_BYTES) {
					throw new Error(
						`Image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB and cannot be resized on this platform. ` +
							`Downscale it first, then analyze the smaller file.`,
					);
				}
				data = bytes.toString("base64");
				details = { model: modelRef(model), modelSource: source, imagePath, wasResized: false };
			}

			const userMessage: UserMessage = {
				role: "user",
				content: [
					{ type: "text", text: params.question },
					{ type: "image", data, mimeType: sentMimeType },
				],
				timestamp: Date.now(),
			};

			const response = await ctx.modelRegistry.complete(
				model,
				{ systemPrompt: ANALYSIS_SYSTEM_PROMPT, messages: [userMessage] },
				{ signal },
			);

			if (response.stopReason === "error") {
				throw new Error(
					`Image analysis failed (${modelRef(model)}): ${response.errorMessage ?? "unknown provider error"}`,
				);
			}
			const answer = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!answer) {
				throw new Error(`The vision model (${modelRef(model)}) returned no text (stopReason: ${response.stopReason}).`);
			}

			return {
				content: [{ type: "text", text: note ? `${answer}\n\n${note}` : answer }],
				details,
				// Report the nested call's usage so session totals stay accurate.
				usage: response.usage,
			};
		},
	});
}
