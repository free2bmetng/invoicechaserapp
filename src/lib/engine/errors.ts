// Typed engine errors. Callers map them to user-facing messages; nothing here
// carries secrets or client data.
export type EngineErrorCode = "not_found" | "invalid_state" | "validation" | "invalid_timezone";

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class NotFoundError extends EngineError {
  constructor(what: string) {
    super("not_found", `${what} was not found.`);
  }
}

export class InvalidStateError extends EngineError {
  constructor(message: string) {
    super("invalid_state", message);
  }
}

export class ValidationError extends EngineError {
  readonly errors: string[];

  constructor(errors: string | string[]) {
    const list = Array.isArray(errors) ? errors : [errors];
    super("validation", list.join(" "));
    this.errors = list;
  }
}

export class InvalidTimezoneError extends EngineError {
  constructor(timezone: string) {
    super("invalid_timezone", `Unknown timezone "${timezone}".`);
  }
}
