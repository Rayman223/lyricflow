import { afterEach, expect, it, vi } from 'vitest'
import { formatDate, formatDateTime, formatTime } from './dates'

afterEach(() => vi.unstubAllEnvs())

it.each([
    ['UTC', '2026-01-02T00:04:05Z', '02/01/2026', '00:04:05'],
    ['Europe/Brussels', '2026-01-02T23:04:05Z', '03/01/2026', '00:04:05'],
    ['America/New_York', '2026-01-01T00:04:05Z', '31/12/2025', '19:04:05'],
    ['Asia/Kathmandu', '2026-01-02T23:04:05Z', '03/01/2026', '04:49:05'],
    ['Europe/Brussels', '2026-03-29T00:59:59Z', '29/03/2026', '01:59:59'],
    ['Europe/Brussels', '2026-03-29T01:00:00Z', '29/03/2026', '03:00:00'],
    ['Europe/Brussels', '2026-10-25T00:59:59Z', '25/10/2026', '02:59:59'],
    ['Europe/Brussels', '2026-10-25T01:00:00Z', '25/10/2026', '02:00:00'],
    ['UTC', '2028-02-29T13:04:05+02:00', '29/02/2028', '11:04:05'],
])('formats %s / %s in local time', (timezone, input, date, time) => {
    vi.stubEnv('TZ', timezone)
    expect(formatDate(input)).toBe(date)
    expect(formatTime(input)).toBe(time)
    expect(formatDateTime(input)).toBe(`${date}, ${time}`)
    expect(formatDateTime(new Date(input))).toBe(`${date}, ${time}`)
})
