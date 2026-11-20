type DateValue = string | Date

function pad(value: number) {
    return String(value).padStart(2, '0')
}

// Local getters use the device timezone, including daylight saving transitions.
export function formatDate(value: DateValue): string {
    const date = value instanceof Date ? value : new Date(value)
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${String(date.getFullYear()).padStart(4, '0')}`
}

export function formatTime(value: DateValue): string {
    const date = value instanceof Date ? value : new Date(value)
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDateTime(value: DateValue): string {
    const date = value instanceof Date ? value : new Date(value)
    return `${formatDate(date)}, ${formatTime(date)}`
}
