import type http from 'node:http'
import { FORGE_WEBHOOK_MAX_BODY_BYTES } from './forge-inbox-webhook-queue'

/** Buffers a body up to the cap; an oversize body gets one 413 and is drained, then dropped. */
export function readWebhookBody(
  req: http.IncomingMessage,
  reply: (status: number, code: string, keepOpen?: boolean) => void,
  onBody: (body: Buffer) => void
): void {
  const chunks: Buffer[] = []
  let size = 0
  let overflowed = false
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > FORGE_WEBHOOK_MAX_BODY_BYTES) {
      if (!overflowed) {
        overflowed = true
        chunks.length = 0
        // Closing now would reset the connection and can discard the 413 the client has not read.
        reply(413, 'body-too-large', true)
      }
      if (size > 2 * FORGE_WEBHOOK_MAX_BODY_BYTES) {
        req.socket.destroy()
      }
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (!overflowed) {
      onBody(Buffer.concat(chunks))
    }
  })
}
