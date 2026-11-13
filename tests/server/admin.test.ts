import { describe, expect, it } from 'vitest'
import { ADMIN_USER_IDS, isAdmin } from '@/src/server/admin'
import { AUTOPILOT_USER_IDS } from '@/src/server/room-service'

describe('isAdmin', () => {
  it('is true only for the hardcoded owner account', () => {
    expect(isAdmin('2131393989')).toBe(true)
    expect(isAdmin('213139398')).toBe(false)
    expect(isAdmin('1')).toBe(false)
    expect(isAdmin('')).toBe(false)
  })
  it('is the same list the hidden Caro autopilot uses', () => {
    expect(AUTOPILOT_USER_IDS).toBe(ADMIN_USER_IDS)
  })
})
