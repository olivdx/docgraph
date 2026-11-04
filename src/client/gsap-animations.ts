import gsap from 'gsap'

export type ResultAnimKind = 'win' | 'lose'

const STAGGER =
  '.result-stagger, .result-next-box, button.result-stagger-btn, .result-link-btn'

/** Page enter — matches theme-preview in-app forward/back slide. */
export function animatePageEnter(el: HTMLElement, forward: boolean) {
  gsap.killTweensOf(el)
  gsap.fromTo(
    el,
    {
      x: forward ? '100%' : '-32%',
      opacity: forward ? 0.75 : 0.9,
    },
    {
      x: 0,
      opacity: 1,
      duration: 0.36,
      ease: 'power2.out',
      clearProps: 'transform',
    },
  )
}

export function animateResultOverlayIn(
  scrim: HTMLElement,
  modal: HTMLElement,
  kind: ResultAnimKind,
  backdrop?: HTMLElement | null,
) {
  gsap.killTweensOf([scrim, modal, backdrop, modal.querySelectorAll('*')].filter(Boolean))
  gsap.set(scrim, { opacity: 0 })
  gsap.set(modal, { opacity: 0, scale: 0.88, y: 22 })
  if (backdrop) gsap.set(backdrop, { scale: 1, filter: 'blur(0px)', opacity: 1 })

  const emoji = modal.querySelector('.result-emoji')
  const staggerEls = modal.querySelectorAll(STAGGER)

  const tl = gsap.timeline()
  tl.to(scrim, { opacity: 1, duration: 0.28, ease: 'power2.out' })
  if (backdrop) {
    tl.to(
      backdrop,
      { scale: 0.97, filter: 'blur(3px)', opacity: 0.55, duration: 0.35, ease: 'power2.out' },
      0,
    )
  }
  tl.to(modal, { opacity: 1, scale: 1, y: 0, duration: 0.48, ease: 'back.out(1.35)' }, 0.06)
  if (emoji) {
    tl.fromTo(
      emoji,
      { scale: 0, rotate: kind === 'win' ? -18 : 12 },
      { scale: 1, rotate: 0, duration: 0.55, ease: 'back.out(2.2)' },
      0.12,
    )
  }
  tl.from(staggerEls, { opacity: 0, y: 14, duration: 0.32, stagger: 0.055, ease: 'power2.out' }, 0.2)
  return tl
}

export function animateResultOverlayOut(
  scrim: HTMLElement,
  modal: HTMLElement,
  onComplete: () => void,
) {
  gsap.killTweensOf([scrim, modal, modal.querySelectorAll('*')])
  gsap
    .timeline({ onComplete })
    .to(modal, { opacity: 0, scale: 0.92, y: 16, duration: 0.2, ease: 'power2.in' })
    .to(scrim, { opacity: 0, duration: 0.18, ease: 'power2.in' }, '-=0.06')
}
