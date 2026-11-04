'use client'

import { PageTransition } from './page-transition'

export function AppShell({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>
}
