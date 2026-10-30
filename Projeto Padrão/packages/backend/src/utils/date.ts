import { format, parseISO, startOfDay, endOfDay, addMinutes, isWithinInterval, setHours, setMinutes, getDay, differenceInMinutes } from 'date-fns';
import { utcToZonedTime, zonedTimeToUtc, format as formatTz } from 'date-fns-tz';
import type { WorkingHours, TimeSlot } from '../types/database';

export const TIMEZONE = 'America/Sao_Paulo';
export const DATE_FORMAT = 'dd/MM/yyyy';
export const TIME_FORMAT = 'HH:mm';
export const DATETIME_FORMAT = "dd/MM/yyyy 'às' HH:mm";

export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return formatTz(d, DATE_FORMAT, { timeZone: TIMEZONE });
}

export function formatTime(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return formatTz(d, TIME_FORMAT, { timeZone: TIMEZONE });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return formatTz(d, DATETIME_FORMAT, { timeZone: TIMEZONE });
}

export function toUtc(date: Date | string): Date {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return zonedTimeToUtc(d, TIMEZONE);
}

export function fromUtc(date: Date | string): Date {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return utcToZonedTime(d, TIMEZONE);
}

export function getDayOfWeek(date: Date | string): number {
  const d = typeof date === 'string' ? parseISO(date) : date;
  return getDay(d);
}

export function generateTimeSlots(
  workingHours: WorkingHours,
  slotDurationMinutes: number,
  existingAppointments: Array<{ starts_at: string; ends_at: string }> = [],
  preparationMinutes: number = 0
): Array<{ start: string; end: string; available: boolean }> {
  if (workingHours.is_closed) return [];

  const slots: Array<{ start: string; end: string; available: boolean }> = [];
  const [openHour, openMinute] = workingHours.open_time.split(':').map(Number);
  const [closeHour, closeMinute] = workingHours.close_time.split(':').map(Number);

  let currentMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;

  while (currentMinutes + slotDurationMinutes <= closeMinutes) {
    const slotStart = currentMinutes;
    const slotEnd = currentMinutes + slotDurationMinutes;

    // Check if slot is during a break
    const isBreak = workingHours.breaks?.some(breakTime => {
      const [breakStartHour, breakStartMinute] = breakTime.start.split(':').map(Number);
      const [breakEndHour, breakEndMinute] = breakTime.end.split(':').map(Number);
      const breakStartMinutes = breakStartHour * 60 + breakStartMinute;
      const breakEndMinutes = breakEndHour * 60 + breakEndMinute;
      return slotStart >= breakStartMinutes && slotEnd <= breakEndMinutes;
    }) ?? false;

    // Check if slot conflicts with existing appointments
    const hasConflict = existingAppointments.some(appt => {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(appt.ends_at);
      const apptStartMinutes = apptStart.getHours() * 60 + apptStart.getMinutes();
      const apptEndMinutes = apptEnd.getHours() * 60 + apptEnd.getMinutes();

      // Add preparation time to appointment
      const prepStartMinutes = apptStartMinutes - preparationMinutes;

      return slotStart < apptEndMinutes && slotEnd > prepStartMinutes;
    });

    const startStr = `${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}`;
    const endStr = `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`;

    slots.push({
      start: startStr,
      end: endStr,
      available: !isBreak && !hasConflict,
    });

    currentMinutes += slotDurationMinutes;
  }

  return slots;
}

export function getWorkingHoursForDate(workingHours: WorkingHours[], date: Date | string): WorkingHours | undefined {
  const dayOfWeek = getDayOfWeek(date);
  return workingHours.find(wh => wh.day_of_week === dayOfWeek);
}

export function isSlotAvailable(
  slotStart: string,
  slotEnd: string,
  workingHours: WorkingHours,
  existingAppointments: Array<{ starts_at: string; ends_at: string }>,
  preparationMinutes: number = 0
): boolean {
  if (workingHours.is_closed) return false;

  const [startHour, startMinute] = slotStart.split(':').map(Number);
  const [endHour, endMinute] = slotEnd.split(':').map(Number);
  const slotStartMinutes = startHour * 60 + startMinute;
  const slotEndMinutes = endHour * 60 + endMinute;

  const [openHour, openMinute] = workingHours.open_time.split(':').map(Number);
  const [closeHour, closeMinute] = workingHours.close_time.split(':').map(Number);
  const openMinutes = openHour * 60 + openMinute;
  const closeMinutes = closeHour * 60 + closeMinute;

  // Check if within working hours
  if (slotStartMinutes < openMinutes || slotEndMinutes > closeMinutes) {
    return false;
  }

  // Check breaks
  const isBreak = workingHours.breaks?.some(breakTime => {
    const [breakStartHour, breakStartMinute] = breakTime.start.split(':').map(Number);
    const [breakEndHour, breakEndMinute] = breakTime.end.split(':').map(Number);
    const breakStartMinutes = breakStartHour * 60 + breakStartMinute;
    const breakEndMinutes = breakEndHour * 60 + breakEndMinute;
    return slotStartMinutes >= breakStartMinutes && slotEndMinutes <= breakEndMinutes;
  }) ?? false;

  if (isBreak) return false;

  // Check conflicts
  const hasConflict = existingAppointments.some(appt => {
    const apptStart = new Date(appt.starts_at);
    const apptEnd = new Date(appt.ends_at);
    const apptStartMinutes = apptStart.getHours() * 60 + apptStart.getMinutes();
    const apptEndMinutes = apptEnd.getHours() * 60 + apptEnd.getMinutes();

    const prepStartMinutes = apptStartMinutes - preparationMinutes;

    return slotStartMinutes < apptEndMinutes && slotEndMinutes > prepStartMinutes;
  });

  return !hasConflict;
}

export function addTimezoneOffset(date: Date): Date {
  return utcToZonedTime(date, TIMEZONE);
}

export function removeTimezoneOffset(date: Date): Date {
  return zonedTimeToUtc(date, TIMEZONE);
}

export function getWeekRange(date: Date | string): { start: Date; end: Date } {
  const d = typeof date === 'string' ? parseISO(date) : date;
  const day = getDay(d);
  const start = startOfDay(addMinutes(d, -day * 24 * 60));
  const end = endOfDay(addMinutes(start, 6 * 24 * 60));
  return { start, end };
}

export function getMonthRange(date: Date | string): { start: Date; end: Date } {
  const d = typeof date === 'string' ? parseISO(date) : date;
  const start = startOfDay(new Date(d.getFullYear(), d.getMonth(), 1));
  const end = endOfDay(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  return { start, end };
}