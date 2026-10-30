import http from 'node:http'
import net from 'node:net'
import { WEBHOOK_TOKEN } from './forge-inbox-webhook-test-harness'
import { HOOK_PATH } from './forge-inbox-owner-fixture-binding'

export function hookHeaders(
  id: string,
  token = WEBHOOK_TOKEN,
  event = 'Merge Request Hook'
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-gitlab-token': token,
    'x-gitlab-event': event,
    'webhook-id': id,
    'x-gitlab-webhook-uuid': 'cfg-1',
    'x-gitlab-event-uuid': `evt-${id}`
  }
}

export function postHook(
  port: number,
  body: unknown,
  id: string,
  token = WEBHOOK_TOKEN,
  event = 'Merge Request Hook'
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: HOOK_PATH,
        method: 'POST',
        headers: hookHeaders(id, token, event),
        agent: false
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        )
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

/**
 * Opens an authenticated hook request whose body never arrives. Resolves only once the server
 * has answered `100 Continue`, so the request is provably in flight.
 */
export async function holdRequestMidBody(
  port: number,
  id: string,
  body = ' '.repeat(1000)
): Promise<{ release: () => void; finish: () => Promise<string> }> {
  const socket = net.connect({ host: '127.0.0.1', port })
  socket.on('error', () => undefined)
  const headers = Object.entries({
    ...hookHeaders(id),
    host: 'forge-test',
    expect: '100-continue',
    'content-length': String(Buffer.byteLength(body))
  })
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => socket.write(`POST ${HOOK_PATH} HTTP/1.1\r\n${headers}\r\n\r\n`))
    socket.on('data', (chunk: Buffer) => {
      if (chunk.toString('latin1').startsWith('HTTP/1.1 100')) {
        resolve()
      }
    })
    socket.once('close', () => reject(new Error('closed before 100 Continue')))
  })
  return {
    release: () => socket.destroy(),
    finish: () =>
      new Promise<string>((resolve) => {
        let response = ''
        socket.on('data', (chunk: Buffer) => {
          response += chunk.toString('utf8')
        })
        socket.once('close', () => resolve(response))
        socket.write(body)
      })
  }
}
