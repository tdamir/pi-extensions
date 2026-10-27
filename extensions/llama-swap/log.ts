/**
 * In interactive mode, console output written while the extension factory
 * runs is rendered as messages in the TUI. Since the factory re-runs on
 * every new session, resume, and /reload, unconditional logging there floods
 * the screen. Info logs are therefore gated behind PI_LLAMA_SWAP_DEBUG; only
 * real failures still print.
 */
export const DEBUG_LOG =
  process.env.PI_LLAMA_SWAP_DEBUG === "1" || process.env.PI_LLAMA_SWAP_DEBUG === "true";

export function debugLog(...args: unknown[]): void {
  if (DEBUG_LOG) console.log(...args);
}
