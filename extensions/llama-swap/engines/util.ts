/** Shared formatting helpers for engine diagnostics and summaries. */

export const DASH = "\u2014";

/** Join non-empty fragments with a middle dot. */
export function joinParts(...parts: (string | undefined | false)[]): string {
  return parts.filter(Boolean).join(" \u00B7 ");
}

/** Format a seconds value as `1.23s`. */
export function secs(value: number | undefined): string {
  return value != null ? `${value.toFixed(2)}s` : DASH;
}

/** Format a milliseconds value as seconds (`1234` → `1.23s`). */
export function msAsSecs(ms: number | undefined): string {
  return ms != null ? `${(ms / 1000).toFixed(2)}s` : DASH;
}

/** Format a throughput value as `77.5 tok/s`. */
export function rate(value: number | undefined): string {
  return value != null && Number.isFinite(value) ? `${value.toFixed(1)} tok/s` : DASH;
}

/** Accepted / drafted as a percentage, preferring the server-provided rate. */
export function acceptance(
  accepted: number | undefined,
  drafted: number | undefined,
  explicitRate?: number,
): string {
  if (explicitRate != null) return `${(explicitRate * 100).toFixed(1)}%`;
  if (drafted) return `${(((accepted ?? 0) / drafted) * 100).toFixed(1)}%`;
  return DASH;
}

/** Shared speculative-decoding line; only fields the engine reports are shown. */
export function speculativeLine(
  rounds: number | undefined,
  drafted: number | undefined,
  accepted: number | undefined,
  explicitRate: number | undefined,
  tokensPerRound: number | undefined,
): string {
  return joinParts(
    "speculative",
    rounds != null ? `${rounds} rounds` : undefined,
    `${drafted ?? 0} drafted`,
    `${accepted ?? 0} accepted (${acceptance(accepted, drafted, explicitRate)})`,
    tokensPerRound != null ? `${tokensPerRound.toFixed(2)} tok/round` : undefined,
  );
}

/** `label` padded to the diagnostics column width. */
export function line(label: string, value: string): string {
  return `${label.padEnd(12)}${value}`;
}
