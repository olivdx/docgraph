'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Hidden autopilot switch: X turns it on, Z turns it off. There is no button or label for it on
 * purpose. The moves come from the server, which only answers allowed users; when it refuses,
 * `disable()` turns the switch off for the rest of the session.
 */

/** Set once the server has refused this user: X does nothing until a reload. */
let refused = false

const typingInto = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Letter for the key; IMEs (Vietnamese Telex, etc.) may report 'Process', so fall back to the key position. */
const keyLetter = (e: KeyboardEvent) =>
  e.key.length === 1 ? e.key.toLowerCase() : e.code === 'KeyX' ? 'x' : e.code === 'KeyZ' ? 'z' : ''

export function useAutopilot() {
  const [on, setOn] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typingInto(e.target)) return
      const k = keyLetter(e)
      if (k === 'x' && !refused) setOn(true)
      else if (k === 'z') setOn(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const disable = useCallback(() => {
    refused = true
    setOn(false)
  }, [])

  return { on, disable }
}
