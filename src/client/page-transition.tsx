'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { animatePageEnter } from './gsap-animations'
import { markNavBack, takeNavDirection } from './nav-direction'

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const ref = useRef<HTMLDivElement>(null)
  const skipEnter = useRef(true)

  useEffect(() => {
    const onPop = () => markNavBack()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (skipEnter.current) {
      skipEnter.current = false
      return
    }
    const forward = takeNavDirection() >= 0
    animatePageEnter(el, forward)
  }, [pathname])

  return (
    <div ref={ref} className="flex min-h-full flex-1 flex-col overflow-x-clip">
      {children}
    </div>
  )
}
