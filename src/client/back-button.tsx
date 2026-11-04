'use client'

import type { ButtonHTMLAttributes, SVGProps } from 'react'

/** Lucide `chevron-left` — https://lucide.dev/icons/chevron-left */
export function ChevronLeftIcon({ size = 22, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

type BackButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label?: string
}

/** Square back control; icon is centered with grid (not text arrow metrics). */
export function BackButton({ label = 'Back', className, children, ...props }: BackButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={
        className ??
        'grid size-9 flex-none place-items-center rounded-xl border border-line bg-panel text-white'
      }
      {...props}
    >
      {children ?? <ChevronLeftIcon />}
    </button>
  )
}
