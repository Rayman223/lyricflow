// A temporary mirror measures soft wraps, tabs and trailing newlines using the
// textarea's actual typography. Nothing is persisted or sent over the network.
export function textareaCaret(textarea: HTMLTextAreaElement) {
    const mirror = document.createElement('div')
    const style = getComputedStyle(textarea)
    for (const property of style)
        mirror.style.setProperty(property, style.getPropertyValue(property))
    Object.assign(mirror.style, {
        position: 'fixed',
        visibility: 'hidden',
        pointerEvents: 'none',
        left: '0',
        top: '0',
        width: `${textarea.clientWidth}px`,
        height: 'auto',
        minHeight: '0',
        maxHeight: 'none',
        margin: '0',
        border: '0',
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        overflow: 'hidden',
    })
    const position =
        textarea.selectionDirection === 'backward' ? textarea.selectionStart : textarea.selectionEnd
    mirror.textContent = textarea.value.slice(0, position)
    const marker = document.createElement('span')
    marker.textContent = textarea.value.slice(position) || '.'
    mirror.append(marker)
    document.body.append(mirror)
    try {
        const origin = mirror.getBoundingClientRect()
        const caret = marker.getClientRects()[0]!
        const rect = textarea.getBoundingClientRect()
        return {
            left: rect.left + textarea.clientLeft + caret.left - origin.left - textarea.scrollLeft,
            top: rect.top + textarea.clientTop + caret.top - origin.top - textarea.scrollTop,
            bottom: rect.top + textarea.clientTop + caret.bottom - origin.top - textarea.scrollTop,
        }
    } finally {
        mirror.remove()
    }
}
