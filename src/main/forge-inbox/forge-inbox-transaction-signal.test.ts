import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openForgeInboxDatabase, runForgeTransaction } from './forge-inbox-database'

describe('forge inbox transaction commit tracking', () => {
  let root: string
  let db: ReturnType<typeof openForgeInboxDatabase>['db']

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'forge-tx-'))
    db = openForgeInboxDatabase(join(root, 'forge-inbox.sqlite'), 'host-a').db
  })
  afterEach(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('never leaves the connection inside a transaction when baseline capture fails', () => {
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      if (sql.includes('total_changes')) {
        throw new Error('baseline unavailable')
      }
      return realPrepare(sql)
    }

    expect(() => runForgeTransaction(db, () => 1)).toThrow('baseline unavailable')
    expect(db.isTransaction).toBe(false)

    db.prepare = realPrepare
    expect(runForgeTransaction(db, () => 2)).toBe(2)
  })
})
