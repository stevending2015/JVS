/**
 * Public domain types for the birthday service.
 */

import type { CalendarFields } from '../../calendar/types.js';

/** Gender of the recorded person; drives which relationships are offered. */
export type Gender = 'male' | 'female' | 'other' | 'unspecified';

export interface BirthdayInput {
  name: string;
  gender?: Gender;
  calendarSystem: string;
  fields: CalendarFields;
  birthTimezone: string;
  relation?: string;
  note?: string;
}

export interface BirthdayRecord {
  id: number;
  name: string;
  gender?: Gender;
  calendarSystem: string;
  fields: CalendarFields;
  birthTimezone: string;
  gregorianLocalDate: string;
  birthdayStartUtc: string;
  shichen?: string;
  zodiacSign?: string;
  /** Chinese zodiac animal (生肖), derived from the lunar year. */
  shengxiao?: string;
  wuxingSummary?: string;
  annualDegradation?: string;
  relation?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}
