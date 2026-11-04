/** Navigation direction for page enter transitions (see page-transition.tsx). */
let nextDirection: 1 | -1 = 1

export function markNavBack() {
  nextDirection = -1
}

export function markNavForward() {
  nextDirection = 1
}

export function takeNavDirection(): 1 | -1 {
  const d = nextDirection
  nextDirection = 1
  return d
}
