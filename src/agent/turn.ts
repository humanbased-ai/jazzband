import type { AgentErrorCode } from "./errors.js";
import type { RuntimeEventName } from "./events.js";

// Turn completion conditions (SPEC §10.3).
export type TurnSignal = "completed" | "failed" | "cancelled" | "timeout" | "subprocess_exit";

export interface TurnOutcome {
  ok: boolean;
  signal: TurnSignal;
}

/** Only a protocol completion signal is success; every other terminal signal is failure (§10.3). */
export function classifyTurn(signal: TurnSignal): TurnOutcome {
  return { ok: signal === "completed", signal };
}

/** Map a failing turn signal to a normalized agent error code (SPEC §10.6). */
export function turnErrorCode(signal: Exclude<TurnSignal, "completed">): AgentErrorCode {
  switch (signal) {
    case "failed":
      return "turn_failed";
    case "cancelled":
      return "turn_cancelled";
    case "timeout":
      return "turn_timeout";
    case "subprocess_exit":
      return "port_exit";
  }
}

/** Map a turn signal to the runtime event name emitted upstream (SPEC §10.4). */
export function turnEventName(signal: TurnSignal): RuntimeEventName {
  switch (signal) {
    case "completed":
      return "turn_completed";
    case "failed":
      return "turn_failed";
    case "cancelled":
      return "turn_cancelled";
    case "timeout":
    case "subprocess_exit":
      return "turn_ended_with_error";
  }
}
