import type { CSSProperties } from 'react'

// Approved reference (cell 30): X = two 4px rounded bars, 22px long, at ±45°;
// O = 16px inner ring with a 4px border. Everything scales with `size` and is
// centered in a `size`×`size` box.

const thick = (k: number) => Math.max(2, Math.round(4 * k))

const box = (size: number): CSSProperties => ({
  position: 'relative',
  display: 'inline-grid',
  placeItems: 'center',
  width: size,
  height: size,
  flex: 'none',
})

export function XMark({ size }: { size: number }) {
  const k = size / 30
  const t = thick(k)
  const bar = (deg: number): CSSProperties => ({
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: 22 * k,
    height: t,
    borderRadius: t / 2,
    background: 'var(--x)',
    transform: `translate(-50%, -50%) rotate(${deg}deg)`,
  })
  return (
    <span style={box(size)} aria-label="X" role="img">
      <span style={bar(45)} />
      <span style={bar(-45)} />
    </span>
  )
}

export function OMark({ size }: { size: number }) {
  const k = size / 30
  const t = thick(k)
  // Outer diameter 24 at cell 30; keep its parity equal to the box so the ring sits on whole pixels.
  let outer = Math.round(24 * k)
  if ((size - outer) % 2 !== 0) outer -= 1
  return (
    <span style={box(size)} aria-label="O" role="img">
      <span
        style={{
          boxSizing: 'border-box',
          width: outer,
          height: outer,
          border: `${t}px solid var(--o)`,
          borderRadius: '50%',
        }}
      />
    </span>
  )
}

export function Mark({ side, size }: { side: 'X' | 'O'; size: number }) {
  return side === 'X' ? <XMark size={size} /> : <OMark size={size} />
}
