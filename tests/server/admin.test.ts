import { describe, expect, it } from 'vitest'
import { isAdmin } from '@/src/server/admin'

describe('isAdmin', () => {
  it('is true only for ids listed in ADMIN_TELEGRAM_IDS', () => {
    const env = { ADMIN_TELEGRAM_IDS: '111, 222 ,333' }
    expect(isAdmin('111', env)).toBe(true)
    expect(isAdmin('222', env)).toBe(true)
    expect(isAdmin('444', env)).toBe(false)
    expect(isAdmin('11', env)).toBe(false)
  })
  it('nobody is an admin when the list is missing or empty', () => {
    expect(isAdmin('111', {})).toBe(false)
    expect(isAdmin('', { ADMIN_TELEGRAM_IDS: '' })).toBe(false)
    expect(isAdmin('', { ADMIN_TELEGRAM_IDS: ' , ' })).toBe(false)
  })
})
