import type {
	CapturedImage,
	CaptureTarget,
	DesktopCaptureOptions,
	ScreenCapturer,
	WindowCaptureOptions,
} from "../../types";

const NOT_IMPLEMENTED =
	"Linux screen capture is not implemented yet. " +
	"Implement ScreenCapturer in extensions/screenshot/capture/linux/linux-capturer.ts. " +
	"Planned backends: grim (wlroots/Wayland compositors), GNOME Shell screenshot D-Bus API, " +
	"scrot/ImageMagick import + xdotool (X11).";

/**
 * Linux backend placeholder.
 *
 * Implements `ScreenCapturer` so the platform factory and tool wiring are already
 * complete; every method fails with a clear message until the backend lands.
 * The real implementation should pick a backend at runtime: query the session
 * type (`XDG_SESSION_TYPE` / `WAYLAND_DISPLAY`) and delegate to grim, GNOME's
 * screenshot portal, or X11 tools.
 */
export class LinuxCapturer implements ScreenCapturer {
	readonly platform = "linux" as const;

	async listTargets(): Promise<CaptureTarget[]> {
		throw new Error(NOT_IMPLEMENTED);
	}

	async captureDesktop(_options: DesktopCaptureOptions): Promise<CapturedImage> {
		throw new Error(NOT_IMPLEMENTED);
	}

	async captureWindow(_options: WindowCaptureOptions): Promise<CapturedImage> {
		throw new Error(NOT_IMPLEMENTED);
	}
}
