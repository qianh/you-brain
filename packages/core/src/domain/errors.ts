export type YouBrainErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_ACCOUNT_UNAVAILABLE"
  | "DRIVE_ROOT_REQUIRED"
  | "DRIVE_ROOT_CONFLICT"
  | "PUBLISH_PATH_REQUIRED"
  | "SOURCE_UNAVAILABLE"
  | "SESSION_NOT_FOUND"
  | "PLATFORM_UNSUPPORTED"
  | "SECRET_STORE_UNAVAILABLE"
  | "CONFIRMATION_REQUIRED"
  | "INDEX_STALE"
  | "UPLOAD_BUSY"
  | "INVALID_INPUT"
  | "UPLOAD_FAILED"
  | "CLIENT_VERSION_UNSUPPORTED"
  | "DEVICE_ID_IMMUTABLE"
  | "CONFIG_INVALID";

export class YouBrainError extends Error {
  constructor(
    readonly code: YouBrainErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "YouBrainError";
  }
}
