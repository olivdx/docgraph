import { CODE_ALPHABET } from './constants'

export function randomCode(len: number, rng: () => number): string {
  let s = ''
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)]
  return s
}
