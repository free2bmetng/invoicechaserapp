// Pure time logic for the send window and for planned times. Bounds are whole
// hours in the client's timezone. The start is inclusive and the end exclusive.
import { DateTime } from "luxon";
import { InvalidTimezoneError, ValidationError } from "./errors";

export const DEFAULT_WINDOW_START = 9;
export const DEFAULT_WINDOW_END = 17;

function assertBounds(startHour: number, endHour: number): void {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) {
    throw new ValidationError("Window hours must be whole numbers.");
  }
  if (startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new ValidationError(`Invalid send window ${startHour}-${endHour}.`);
  }
}

function zoned(instant: Date, timezone: string): DateTime {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  if (!dt.isValid) throw new InvalidTimezoneError(timezone);
  return dt;
}

export function assertValidZone(timezone: string): void {
  if (!DateTime.utc().setZone(timezone).isValid) throw new InvalidTimezoneError(timezone);
}

// True when the instant falls in [startHour:00, endHour:00) local time.
export function isInsideWindow(
  instant: Date,
  timezone: string,
  startHour: number,
  endHour: number,
): boolean {
  assertBounds(startHour, endHour);
  const dt = zoned(instant, timezone);
  const minute = dt.hour * 60 + dt.minute;
  return minute >= startHour * 60 && minute < endHour * 60;
}

// The first instant at which the window is open. Returns the instant itself
// when it is already inside the window.
export function nextWindowOpening(
  instant: Date,
  timezone: string,
  startHour: number,
  endHour: number = DEFAULT_WINDOW_END,
): Date {
  assertBounds(startHour, endHour);
  if (isInsideWindow(instant, timezone, startHour, endHour)) return new Date(instant.getTime());
  const local = zoned(instant, timezone);
  let opening = local.set({ hour: startHour, minute: 0, second: 0, millisecond: 0 });
  if (opening.toMillis() <= instant.getTime()) opening = opening.plus({ days: 1 });
  return opening.toJSDate();
}

// Planned time for a step: the due date plus the offset, at the window start in
// the given timezone. The window itself is applied later, at dispatch.
export function plannedAtFor(
  dueDate: string,
  offsetDays: number,
  timezone: string,
  startHour: number,
): Date {
  if (!Number.isInteger(offsetDays)) throw new ValidationError("Offsets must be whole days.");
  const due = DateTime.fromISO(dueDate, { zone: timezone });
  if (!due.isValid) throw new InvalidTimezoneError(timezone);
  return due
    .plus({ days: offsetDays })
    .set({ hour: startHour, minute: 0, second: 0, millisecond: 0 })
    .toJSDate();
}

// Midnight that starts the local calendar day containing the instant.
export function startOfLocalDay(instant: Date, timezone: string): Date {
  return zoned(instant, timezone).startOf("day").toJSDate();
}

// Midnight that starts the next local calendar day.
export function startOfNextLocalDay(instant: Date, timezone: string): Date {
  return zoned(instant, timezone).startOf("day").plus({ days: 1 }).toJSDate();
}

export function localDateString(instant: Date, timezone: string): string {
  return zoned(instant, timezone).toISODate() ?? "";
}
