// Error surface for workflow loading, prompt rendering, and config validation (SPEC §5.5, §6).
export type JazzbandErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "template_parse_error"
  | "template_render_error"
  | "config_validation_error";

export class JazzbandError extends Error {
  readonly code: JazzbandErrorCode;

  constructor(code: JazzbandErrorCode, message: string) {
    super(message);
    this.name = "JazzbandError";
    this.code = code;
  }
}
