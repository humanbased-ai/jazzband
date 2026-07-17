// Runtime events emitted upstream to the orchestrator (SPEC §10.4).

export type RuntimeEventName =
  | "session_started"
  | "startup_failed"
  | "turn_completed"
  | "turn_failed"
  | "turn_cancelled"
  | "turn_ended_with_error"
  | "turn_input_required"
  | "approval_auto_approved"
  | "unsupported_tool_call"
  | "notification"
  | "other_message"
  | "malformed";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RuntimeEvent {
  event: RuntimeEventName;
  timestamp: string;
  codexAppServerPid: string | null;
  usage?: TokenUsage;
  payload?: Record<string, unknown>;
}

export type EventSink = (event: RuntimeEvent) => void;

export interface MakeEventOptions {
  pid?: string | null;
  usage?: TokenUsage;
  payload?: Record<string, unknown>;
  /** Injectable clock; defaults to the wall clock in UTC ISO-8601. */
  now?: () => string;
}

export function makeEvent(event: RuntimeEventName, options: MakeEventOptions = {}): RuntimeEvent {
  const base: RuntimeEvent = {
    event,
    timestamp: (options.now ?? (() => new Date().toISOString()))(),
    codexAppServerPid: options.pid ?? null,
  };
  if (options.usage) base.usage = options.usage;
  if (options.payload) base.payload = options.payload;
  return base;
}
