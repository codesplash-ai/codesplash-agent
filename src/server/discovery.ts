import { createSocket } from "node:dgram"
import { hostname } from "node:os"

function name(value: string) {
  const labels = value.replace(/\.$/, "").split(".")
  if (labels.some((v) => !v || Buffer.byteLength(v) > 63)) throw new Error("Invalid DNS name")
  return Buffer.concat([
    ...labels.map((v) => Buffer.concat([Buffer.from([Buffer.byteLength(v)]), Buffer.from(v)])),
    Buffer.from([0]),
  ])
}
function record(owner: string, type: number, data: Buffer, ttl: number) {
  const h = Buffer.alloc(10)
  h.writeUInt16BE(type)
  h.writeUInt16BE(type === 12 ? 1 : 0x8001, 2)
  h.writeUInt32BE(ttl, 4)
  h.writeUInt16BE(data.length, 8)
  return Buffer.concat([name(owner), h, data])
}
export function advertisement(port: number, address: string, instance: string, ttl = 120) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^(\d{1,3}\.){3}\d{1,3}$/.test(address) ||
    address.split(".").some((v) => Number(v) > 255)
  )
    throw new Error("mDNS requires a concrete IPv4 address and port")
  const service = "_codesplash._tcp.local",
    host = `${instance}.local`,
    full = `${instance}.${service}`,
    srv = Buffer.alloc(6)
  srv.writeUInt16BE(port, 4)
  const txt = ["version=1", "auth=required", "path=/"].map((v) =>
    Buffer.concat([Buffer.from([v.length]), Buffer.from(v)]),
  )
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(4, 6)
  return Buffer.concat([
    header,
    record(service, 12, name(full), ttl),
    record(full, 33, Buffer.concat([srv, name(host)]), ttl),
    record(full, 16, Buffer.concat(txt), ttl),
    record(host, 1, Buffer.from(address.split(".").map(Number)), ttl),
  ])
}
export async function advertise(port: number, address: string) {
  const instance = `codesplash-${hostname()
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .slice(0, 32)}-${port}`
  const packet = advertisement(port, address, instance),
    socket = createSocket({ type: "udp4", reuseAddr: true })
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject)
    socket.bind(5353, () => {
      socket.off("error", reject)
      resolve()
    })
  })
  socket.on("error", () => {})
  socket.addMembership("224.0.0.251", address)
  socket.setMulticastTTL(255)
  socket.setMulticastInterface(address)
  const send = () => socket.send(packet, 5353, "224.0.0.251")
  let last = 0
  socket.on("message", (message) => {
    if (
      message.length >= 12 &&
      message.length <= 9000 &&
      !(message.readUInt16BE(2) & 0x8000) &&
      message.includes(Buffer.from("_codesplash")) &&
      Date.now() - last > 1000
    ) {
      last = Date.now()
      send()
    }
  })
  send()
  const timer = setInterval(send, 60000)
  timer.unref()
  return {
    async close() {
      clearInterval(timer)
      await new Promise<void>((resolve) =>
        socket.send(advertisement(port, address, instance, 0), 5353, "224.0.0.251", () => resolve()),
      )
      socket.close()
    },
  }
}
