/**
 * Typed errors used by the calendar engine. Consumers can `instanceof`-check
 * to decide whether to surface a UI message or trigger a fallback adapter.
 */

export class CalendarError extends Error {
  readonly code: string;
  constructor(message: string, code = 'CALENDAR_ERROR') {
    super(message);
    this.name = 'CalendarError';
    this.code = code;
  }
}

export class AdapterNotFoundError extends CalendarError {
  constructor(adapterId: string) {
    super(`No calendar adapter registered for id "${adapterId}"`, 'ADAPTER_NOT_FOUND');
    this.name = 'AdapterNotFoundError';
  }
}

export class InvalidDateError extends CalendarError {
  constructor(adapterId: string, message: string) {
    super(`[${adapterId}] ${message}`, 'INVALID_DATE');
    this.name = 'InvalidDateError';
  }
}

export class TimezoneError extends CalendarError {
  constructor(message: string) {
    super(message, 'TIMEZONE_ERROR');
    this.name = 'TimezoneError';
  }
}
