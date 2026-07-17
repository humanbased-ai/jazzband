// Tracker error categories (SPEC §11.4).
export type LinearErrorCode =
  | "unsupported_tracker_kind"
  | "missing_tracker_api_key"
  | "missing_tracker_project_slug"
  | "linear_api_request"
  | "linear_api_status"
  | "linear_graphql_errors"
  | "linear_unknown_payload"
  | "linear_missing_end_cursor";

export class LinearError extends Error {
  readonly code: LinearErrorCode;

  constructor(code: LinearErrorCode, message: string) {
    super(message);
    this.name = "LinearError";
    this.code = code;
  }
}
