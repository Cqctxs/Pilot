export const PILOT_ERROR_CODES = [
  // Caller mistakes
  "INVALID_ARGUMENT",
  "UNKNOWN_PILOT",
  "UNSUPPORTED_CAPABILITY",
  "NO_PILOTS_ENABLED",
  // Runtime failures against a live site
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "BLOCKED",
  "INVALID_SOURCE_RESPONSE",
  // The recipe no longer matches the site
  "PILOT_BROKEN",
  // Compiler failures
  "AI_NOT_CONFIGURED",
  "AI_REQUEST_FAILED",
  "INVALID_RECIPE",
  "VALIDATION_FAILED",
  "OBSERVATION_FAILED",
  // Catch-alls
  "INTERNAL_ERROR",
  "NOT_IMPLEMENTED",
] as const;

export type PilotErrorCode = (typeof PILOT_ERROR_CODES)[number];

export interface PilotError {
  code: PilotErrorCode;
  message: string;
  pilotId?: string;
  /** Present on RATE_LIMITED when the site tells us how long to wait. */
  retryAfterSeconds?: number;
}

export class PilotException extends Error {
  readonly error: PilotError;

  constructor(error: PilotError) {
    super(error.message);
    this.name = "PilotException";
    this.error = error;
  }
}

export function pilotError(code: PilotErrorCode, message: string, extra?: Partial<PilotError>): PilotException {
  return new PilotException({ code, message, ...extra });
}

export function toPilotError(cause: unknown): PilotError {
  if (cause instanceof PilotException) return cause.error;
  return {
    code: "INTERNAL_ERROR",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

export function notImplemented(moduleName: string): PilotException {
  return pilotError("NOT_IMPLEMENTED", `${moduleName} is not implemented yet`);
}
