/**
 * Shared capture contract.
 *
 * Platform backends (`capture/<platform>/`) implement `ScreenCapturer` and must not
 * leak platform specifics beyond this interface — the tools in `index.ts` and the
 * platform factory in `platform.ts` are the only consumers.
 */

/** Default downscale target for model-facing screenshots. Keeps base64 payloads provider-friendly. */
export const DEFAULT_MAX_WIDTH = 1600;

/** A capturable top-level window, roughly in z-order (front first). */
export interface CaptureTarget {
	pid: number;
	title: string;
	processName: string;
	width: number;
	height: number;
}

/** A captured screenshot: saved PNG file plus base64 payload for the model. */
export interface CapturedImage {
	/** File the PNG was saved to. */
	filePath: string;
	/** Image dimensions after optional downscaling. */
	width: number;
	height: number;
	/** Base64-encoded PNG bytes. */
	base64: string;
	mimeType: "image/png";
	/** Window captures only: title and pid of the captured window. */
	title?: string;
	pid?: number;
	/** Optional caveat about how the image was produced (e.g. PrintWindow fallback used). */
	note?: string;
}

export interface DesktopCaptureOptions {
	/** 0-based monitor index. Omit to capture the whole virtual desktop (all monitors combined). */
	monitor?: number;
	/** Downscale to at most this width in pixels. 0 disables resizing. */
	maxWidth?: number;
	/** Where to save the PNG. Defaults to a timestamped file in the temp directory. */
	savePath?: string;
}

export interface WindowCaptureOptions {
	/** Case-insensitive substring of the window title. */
	title?: string;
	/** Process id of the window to capture. More precise than title; can be combined with it. */
	pid?: number;
	/** Downscale to at most this width in pixels. 0 disables resizing. */
	maxWidth?: number;
	/** Where to save the PNG. Defaults to a timestamped file in the temp directory. */
	savePath?: string;
}

/**
 * Platform backend for screen capture.
 *
 * Implementations should fail with descriptive errors that include enough context
 * for the model to recover (e.g. the list of capturable windows when a title
 * matches nothing or several windows).
 */
export interface ScreenCapturer {
	readonly platform: NodeJS.Platform;
	/** List visible, capturable top-level windows, roughly in z-order (front first). */
	listTargets(): Promise<CaptureTarget[]>;
	/** Capture the whole virtual desktop, or a single monitor when `monitor` is given. */
	captureDesktop(options: DesktopCaptureOptions): Promise<CapturedImage>;
	/** Capture a specific window by title substring and/or pid. */
	captureWindow(options: WindowCaptureOptions): Promise<CapturedImage>;
}
