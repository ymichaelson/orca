import net from 'node:net'
import process from 'node:process'

// Config validation rejects port 0, so tests need a concrete free port. Each worker process scans
// its own pid-derived slice below the OS ephemeral range, which removes cross-file probe races.
const PORT_SLICE_BASE = 20_000 + (process.pid % 1000) * 10
let nextSlot = 0

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = PORT_SLICE_BASE + (nextSlot++ % 10)
    if (await canBind(port)) {
      return port
    }
  }
  throw new Error('no free test port in this process slice')
}

export async function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const holder = net.createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
  const address = holder.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no holder address')
  }
  return {
    port: address.port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve()))
  }
}

export function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
  })
}

export function openIdleSocket(
  port: number
): Promise<{ socket: net.Socket; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      let isClosed = false
      socket.on('error', () => undefined)
      socket.once('close', () => {
        isClosed = true
      })
      resolve({ socket, closed: () => isClosed })
    })
    socket.once('error', reject)
  })
}
