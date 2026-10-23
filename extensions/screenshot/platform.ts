import { LinuxCapturer } from "./capture/linux/linux-capturer";
import { WindowsCapturer } from "./capture/windows/windows-capturer";
import type { ScreenCapturer } from "./types";

/**
 * Pick the capture backend for the current platform.
 *
 * Adding a platform means adding a case here and a `ScreenCapturer` implementation
 * under `capture/<platform>/`; nothing else changes.
 *
 * Throws for unsupported platforms — the tools surface that as a failed tool result.
 */
export function getCapturer(): ScreenCapturer {
	switch (process.platform) {
		case "win32":
			return new WindowsCapturer();
		case "linux":
			return new LinuxCapturer();
		default:
			throw new Error(
				`Screen capture is not supported on ${process.platform}. Supported platforms: windows (implemented), linux (planned).`,
			);
	}
}
