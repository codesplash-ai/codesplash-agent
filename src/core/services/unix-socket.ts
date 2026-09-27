import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi"
import { configureNonblockingDescriptor } from "../session/secure-path.ts"

/** Owned nonblocking POSIX descriptor. Bun 1.3's Unix-socket end() closes the read side as well. */
const load = () =>
  dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    socket: { args: ["i32", "i32", "i32"], returns: "i32" },
    connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
    send: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
    recv: { args: ["i32", "ptr", "u64", "i32"], returns: "i64" },
    shutdown: { args: ["i32", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
    [process.platform === "darwin" ? "__error" : "__errno_location"]: { args: [], returns: "ptr" },
  } as const)
let library: ReturnType<typeof load> | undefined
export class UnixSocket {
  #fd = -1
  #last = Date.now()
  readonly #api: ReturnType<typeof load>["symbols"]
  readonly #mac = process.platform === "darwin"
  constructor(
    readonly signal: AbortSignal,
    readonly idleMs: number,
  ) {
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("Relay supports macOS and Linux")
    library ??= load()
    this.#api = library.symbols
  }
  #errno() {
    const address = this.#api[this.#mac ? "__error" : "__errno_location"]!() as Pointer
    return new Int32Array(toArrayBuffer(address, 0, 4))[0]!
  }
  #check() {
    this.signal.throwIfAborted()
    if (this.#fd < 0) throw new Error("Relay socket closed")
    if (Date.now() - this.#last > this.idleMs) throw new Error("Relay idle timeout")
  }
  async #wait() {
    this.#check()
    await new Promise((done) => setTimeout(done, 5))
    this.#check()
  }
  #retry() {
    const error = this.#errno()
    if (![4, this.#mac ? 35 : 11].includes(error)) throw new Error(`Relay socket failed (${error})`)
  }
  async connect(path: string) {
    this.#fd = this.#api.socket!(1, 1, 0) as number
    if (this.#fd < 0) throw new Error("Cannot create relay socket")
    configureNonblockingDescriptor(this.#fd)
    const encoded = Buffer.from(`${path}\0`),
      address = Buffer.alloc(2 + encoded.length)
    if (this.#mac) {
      address[0] = address.length
      address[1] = 1
    } else address.writeUInt16LE(1)
    encoded.copy(address, 2)
    // Local AF_UNIX connect either succeeds or refuses. A full listen queue is not retried against a possibly replaced pathname.
    if ((this.#api.connect!(this.#fd, ptr(address), address.length) as number) !== 0)
      throw new Error(`Relay connection failed (${this.#errno()})`)
    this.#last = Date.now()
  }
  async send(data: Buffer) {
    for (let offset = 0; offset < data.length; ) {
      this.#check()
      const chunk = data.subarray(offset)
      const n = Number(this.#api.send!(this.#fd, ptr(chunk), chunk.length, this.#mac ? 0x80000 : 0x4000))
      if (n < 0) {
        this.#retry()
        await this.#wait()
      } else if (!n) throw new Error("Relay write made no progress")
      else {
        offset += n
        this.#last = Date.now()
      }
    }
  }
  async receive() {
    const data = Buffer.alloc(16384)
    for (;;) {
      this.#check()
      const n = Number(this.#api.recv!(this.#fd, ptr(data), data.length, 0))
      if (n >= 0) {
        this.#last = Date.now()
        return n ? data.subarray(0, n) : undefined
      }
      this.#retry()
      await this.#wait()
    }
  }
  end() {
    this.#check()
    if ((this.#api.shutdown!(this.#fd, 1) as number) !== 0) throw new Error("Relay half-close failed")
  }
  close() {
    if (this.#fd >= 0) {
      this.#api.close!(this.#fd)
      this.#fd = -1
    }
  }
}
