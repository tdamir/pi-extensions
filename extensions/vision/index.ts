/**
 * Vision extension - inspect images without loading them into the conversation.
 *
 * Tool:
 * - `analyze_image` - answers a question about one or more image files via a
 *   nested vision-model call. The images themselves never enter the session
 *   transcript; only the text answer does. This keeps provider request bodies
 *   small, which matters for long sessions and engines with request-body
 *   limits (e.g. TensorFold's 32 MB cap).
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

/** Maximum number of images in a single analyze_image call. */
const MAX_IMAGES = 10;

const MIME_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
};

const ANALYSIS_SYSTEM_PROMPT = `You are a precise visual inspection assistant. Answer the question about the attached image(s).
Images are labelled "Image 1 of N", "Image 2 of N", ... in attachment order; refer to them by that label or by file path.
When several images are attached, compare or combine them as the question asks and attribute each observation to the right image.
Be factual and concise, and point at visible evidence (text, elements, colors, layout) when relevant.
If an image does not show what is asked about, say so explicitly instead of guessing.`;

const AnalyzeImageParams = Type.Object({
	path: Type.Optional(
		Type.String({
			description:
				"Path to a single image file (PNG, JPEG, GIF, WebP, or BMP). Relative paths resolve against the working " +
				"directory. Provide either this or \"paths\", not both.",
		}),
	),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				`Paths to multiple image files to analyze together in one call (PNG, JPEG, GIF, WebP, or BMP; max ${MAX_IMAGES}). ` +
				"Relative paths resolve against the working directory. Images are labelled \"Image 1 of N\", \"Image 2 of N\", ... " +
				"in this order, so phrase the question accordingly (e.g. compare them). Provide either this or \"path\", not both.",
			minItems: 1,
			maxItems: MAX_IMAGES,
		}),
	),
	question: Type.String({
		description:
			"What to check or answer about the image(s). Be specific, e.g. " +
			"'Does the settings page render correctly? List any overlapping, cut-off, or misaligned elements.' " +
			"With multiple images, refer to them by their \"Image N of M\" label or file name.",
	}),
	maxWidth: Type.Optional(
		Type.Number({
			description: `Downscale each image to at most this width in pixels before sending (default ${DEFAULT_MAX_WIDTH}). Images already within the limits are sent unchanged.`,
		}),
	),
	maxHeight: Type.Optional(
		Type.Number({
			description: `Downscale each image to at most this height in pixels before sending (default ${DEFAULT_MAX_HEIGHT}).`,
		}),
	),
});

/** Per-image entry in the tool details. */
interface ImageDetails {
	/** Absolute path of the analyzed image. */
	path: string;
	/** Dimensions of the image that was actually sent. */
	width?: number;
	height?: number;
	/** Original dimensions, when the image was downscaled. */
	originalWidth?: number;
	originalHeight?: number;
	wasResized: boolean;
}

interface AnalyzeImageDetails {
	/** Model that produced the answer ("provider/id"). */
	model: string;
	/** Where the model came from: the session model or the vision.analyzeModel setting. */
	modelSource: "session" | "settings";
	/** All images analyzed in this call, in attachment order. */
	images: ImageDetails[];
	/** True when at least one image was downscaled. */
	wasResized: boolean;
}

/** A loaded + (optionally) resized image ready to be sent to the vision model. */
interface PreparedImage extends ImageDetails {
	data: string;
	mimeType: string;
	/** Dimension note appended to the answer when this image was downscaled. */
	note?: string;
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

/**
 * Load one image and bring it within the pixel/byte limits for the vision call.
 * Uses pi's built-in Photon resize pipeline; falls back to the original bytes
 * when resizing is unavailable, refusing absurd sizes.
 */
async function prepareImage(imagePath: string, maxWidth: number, maxHeight: number): Promise<PreparedImage> {
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

	const resized = await resizeImage(new Uint8Array(bytes), mimeType, { maxWidth, maxHeight });
	if (resized) {
		const image: PreparedImage = {
			path: imagePath,
			data: resized.data,
			mimeType: resized.mimeType,
			width: resized.width,
			height: resized.height,
			wasResized: resized.wasResized,
		};
		if (resized.wasResized) {
			image.originalWidth = resized.originalWidth;
			image.originalHeight = resized.originalHeight;
			image.note = formatDimensionNote(resized);
		}
		return image;
	}

	if (bytes.byteLength > MAX_FALLBACK_BYTES) {
		throw new Error(
			`Image ${imagePath} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB and cannot be resized on this platform. ` +
				`Downscale it first, then analyze the smaller file.`,
		);
	}
	return { path: imagePath, data: bytes.toString("base64"), mimeType, wasResized: false };
}

export default function visionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "analyze_image",
		label: "Analyze Image",
		description:
			"Answer a question about one or more image files (paths + question) with a vision model and return only the text " +
			"answer. The images are NOT added to the conversation, so request bodies stay small - use this instead of loading " +
			"images into the session (screenshots, read on image files) when the session is long or the engine limits request " +
			"size (e.g. TensorFold's 32 MB body cap). Pass several files in \"paths\" to analyze them together in one call - " +
			"they are labelled \"Image 1 of N\", \"Image 2 of N\", ... so the question can ask to compare them. Uses the " +
			"current session model when it accepts images; otherwise the model " +
			'configured via the "vision.analyzeModel" setting ("provider/model-id"). ' +
			"Ask one focused question per call; call again with a follow-up question if needed.",
		promptSnippet: "answer questions about one or more image files without loading them into the conversation",
		promptGuidelines: [
			"When you need to know what image files show, use analyze_image with the file path(s) and a specific question. " +
				"Pass related images together in \"paths\" (e.g. before/after screenshots to compare) instead of one call per " +
				"image. It answers with text and keeps the images out of the conversation, which keeps request bodies small. " +
				"Prefer it over viewing images directly once the session is long, and for verifying screenshots or rendered output.",
		],
		parameters: AnalyzeImageParams,
		annotations: { readOnlyHint: true },
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			if (!params.path && !params.paths?.length) {
				throw new Error('Provide "path" (single image) or "paths" (multiple images).');
			}
			if (params.path && params.paths?.length) {
				throw new Error('Provide either "path" or "paths", not both.');
			}

			const rawPaths = params.paths ?? [params.path as string];
			if (rawPaths.length > MAX_IMAGES) {
				throw new Error(`Too many images (${rawPaths.length}); pass at most ${MAX_IMAGES} per call.`);
			}

			const { model, source } = resolveVisionModel(pi, ctx);

			const images: PreparedImage[] = [];
			for (const raw of rawPaths) {
				const imagePath = isAbsolute(raw) ? raw : resolve(ctx.cwd, raw);
				images.push(await prepareImage(imagePath, params.maxWidth ?? DEFAULT_MAX_WIDTH, params.maxHeight ?? DEFAULT_MAX_HEIGHT));
			}

			const content: UserMessage["content"] = [{ type: "text", text: params.question }];
			images.forEach((image, i) => {
				content.push(
					{ type: "text", text: `Image ${i + 1} of ${images.length}: ${image.path}` },
					{ type: "image", data: image.data, mimeType: image.mimeType },
				);
			});

			const userMessage: UserMessage = { role: "user", content, timestamp: Date.now() };

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

			const notes = images.map((image) => image.note).filter((n): n is string => Boolean(n));
			const text = notes.length ? `${answer}\n\n${notes.join("\n")}` : answer;

			return {
				content: [{ type: "text", text }],
				details: {
					model: modelRef(model),
					modelSource: source,
					images: images.map(({ data: _data, mimeType: _mimeType, note: _note, ...info }) => info),
					wasResized: images.some((image) => image.wasResized),
				},
				// Report the nested call's usage so session totals stay accurate.
				usage: response.usage,
			};
		},
	});
}
