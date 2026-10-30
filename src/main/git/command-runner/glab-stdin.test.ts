import { describe, expect, it, vi } from 'vitest'

vi.mock('./wsl-command-resolution', () => ({
  resolveCommand: (_command: string, args: string[], cwd?: string) => ({
    binary: process.execPath,
    args: [
      '-e',
      `let input = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => { input += chunk })
      process.stdin.on('end', () => {
        const body = input ? JSON.parse(input) : null
        process.stdout.write(JSON.stringify({
          url: body?.url ?? null,
          hasToken: body?.token === 'synthetic-hook-secret',
          secretInArgv: process.argv.some(value => value.includes('synthetic-hook-secret')),
          inputBytes: Buffer.byteLength(input)
        }))
      })`,
      '--',
      ...args
    ],
    cwd,
    wsl: null
  }),
  resolveDefaultWslCli: () => null
}))

import { glabExecFileAsync } from './glab-exec-file'

describe('glab request body transport', () => {
  it('delivers a webhook secret over stdin to the real child, never in argv', async () => {
    const payload = JSON.stringify({
      url: 'http://192.0.2.1:7421/webhooks/gitlab/test-binding',
      token: 'synthetic-hook-secret'
    })
    const result = await glabExecFileAsync(
      ['api', '--method', 'POST', 'projects/3/hooks', '--input', '-'],
      { cwd: process.cwd(), stdin: payload, idempotent: false, timeout: 5000 }
    )
    const body: unknown = JSON.parse(result.stdout)
    expect(body).toEqual({
      url: 'http://192.0.2.1:7421/webhooks/gitlab/test-binding',
      hasToken: true,
      secretInArgv: false,
      inputBytes: Buffer.byteLength(payload)
    })
  })

  it('ends empty stdin so a JSON-body command can complete', async () => {
    const result = await glabExecFileAsync(['api', 'user'], {
      cwd: process.cwd(),
      stdin: '',
      timeout: 5000
    })
    const body: unknown = JSON.parse(result.stdout)
    expect(body).toEqual({ url: null, hasToken: false, secretInArgv: false, inputBytes: 0 })
  })
})
