import { hub } from '../../core/calendar/instance.js';
import type { Person } from '../../core/person/types.js';
import { PersonRepository } from '../../core/person/repository.js';

/** Human-readable birthday as entered, e.g. 中国农历 8月15日. */
export function formatLunar(person: Person): string {
  const calendar = hub.listCalendars().find((c) => c.id === person.calendar_system);
  const fields = PersonRepository.fieldsOf(person);
  const month = Number(fields.month);
  const day = Number(fields.day);
  const name = calendar?.name ?? person.calendar_system ?? '未知历法';
  if (!Number.isFinite(month) || !Number.isFinite(day)) return name;
  const leap = fields.isLeapMonth === true ? '闰' : '';
  return `${name} ${leap}${month}月${day}日`;
}