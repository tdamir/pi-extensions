/**
 * Shared types for command definitions.
 *
 * Command modules export a plain `CommandDefinition` (data, no side effects);
 * `index.ts` is the single place that calls `pi.registerCommand`.
 */

import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";

/** A command definition, minus the source info pi attaches at registration. */
export type CommandDefinition = Omit<RegisteredCommand, "sourceInfo">;
