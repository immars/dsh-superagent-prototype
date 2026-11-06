/** The panel's words for a Ticket's schedule: the interval as the person asked it. */
import type { TicketRow } from './api.ts'
import type { T } from './text.ts'

export type ScheduleView = NonNullable<TicketRow['schedule']>
/** "every 15 minutes", "every 2 hours", "every 3 days at 09:00", or "every Monday at 09:00". */
export function scheduleInterval(t: T, schedule: ScheduleView): string {
  const count = schedule.every
  switch (schedule.period) {
    case 'minutely': return count === 1 ? t('schedule.minute') : t('schedule.minutes', { count })
    case 'hourly': return count === 1 ? t('schedule.hourly') : t('schedule.hours', { count })
    case 'daily': return count === 1 ? t('schedule.daily', { at: schedule.at ?? '' }) : t('schedule.days', { count, at: schedule.at ?? '' })
    case 'weekly': return count === 1 ? t('schedule.weekly', { at: schedule.at ?? '' }) : t('schedule.weeks', { count, at: schedule.at ?? '' })
  }
}
