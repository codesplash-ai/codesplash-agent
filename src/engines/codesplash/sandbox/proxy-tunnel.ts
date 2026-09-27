import { connect, type Socket } from "node:net"
import { connect as secureConnect } from "node:tls"
import { networkTLS } from "../../../core/network.ts"

/** CONNECT to the already-vetted IP, so an upstream proxy cannot re-resolve the target hostname. */
export async function connectThroughProxy(
  address: string,
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<Socket> {
  const proxy = env.CODESPLASH_PROXY ? new URL(env.CODESPLASH_PROXY) : undefined
  const socket =
    proxy?.protocol === "https:"
      ? secureConnect({
          host: proxy.hostname,
          port: Number(proxy.port || 443),
          servername: proxy.hostname,
          ...networkTLS(env),
        })
      : connect({ host: proxy?.hostname ?? address, port: proxy ? Number(proxy.port || 80) : port })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error("Proxy connection timed out"))
      }, 10000)
      const fail = () => {
        clearTimeout(timer)
        reject(new Error("Proxy connection failed"))
      }
      socket.once("error", fail)
      socket.once(proxy?.protocol === "https:" ? "secureConnect" : "connect", () => {
        clearTimeout(timer)
        socket.removeListener("error", fail)
        resolve()
      })
    })
    if (!proxy) return socket
    const target = `${address.includes(":") ? `[${address}]` : address}:${port}`
    const auth =
      proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : ""
    await new Promise<void>((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const timer = setTimeout(() => fail(), 10000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeListener("data", data)
        socket.removeListener("error", fail)
        socket.removeListener("end", fail)
      }
      const fail = () => {
        cleanup()
        reject(new Error("Upstream proxy refused the tunnel"))
      }
      const data = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > 16384) return fail()
        const at = buffer.indexOf("\r\n\r\n")
        if (at < 0) return
        if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(buffer.toString("latin1", 0, at))) return fail()
        socket.pause()
        cleanup()
        if (buffer.length > at + 4) socket.unshift(buffer.subarray(at + 4))
        resolve()
      }
      socket.on("data", data)
      socket.once("error", fail)
      socket.once("end", fail)
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`)
    })
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}
