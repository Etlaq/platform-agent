export type ZipStreamFile = {
  relPath: string
  mtimeMs: number
}

type ZipChunk = Uint8Array | ArrayBuffer | ArrayBufferView

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32Init() {
  return 0xffffffff
}

function crc32Update(crc: number, chunk: Uint8Array) {
  let c = crc >>> 0
  for (let i = 0; i < chunk.length; i++) {
    c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  }
  return c >>> 0
}

function crc32Final(crc: number) {
  return (crc ^ 0xffffffff) >>> 0
}

function dosTimeDate(mtimeMs: number) {
  const d = new Date(mtimeMs)
  const year = Math.max(1980, d.getFullYear())
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hours = d.getHours()
  const minutes = d.getMinutes()
  const seconds = Math.floor(d.getSeconds() / 2)
  const time = ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f)
  const date = (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f)
  return { time, date }
}

function u16(n: number) {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}

function u32(n: number) {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function localHeader(nameBytes: Uint8Array, time: number, date: number) {
  const gpFlags = 0x0808 // data descriptor + UTF-8
  return concatBytes([
    u32(0x04034b50),
    u16(20),
    u16(gpFlags),
    u16(0),
    u16(time),
    u16(date),
    u32(0),
    u32(0),
    u32(0),
    u16(nameBytes.length),
    u16(0),
    nameBytes,
  ])
}

function dataDescriptor(crc: number, compSize: number, uncompSize: number) {
  return concatBytes([u32(0x08074b50), u32(crc), u32(compSize), u32(uncompSize)])
}

function centralHeader(params: {
  nameBytes: Uint8Array
  time: number
  date: number
  crc: number
  compSize: number
  uncompSize: number
  localOffset: number
}) {
  const gpFlags = 0x0808 // data descriptor + UTF-8
  return concatBytes([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(gpFlags),
    u16(0),
    u16(params.time),
    u16(params.date),
    u32(params.crc),
    u32(params.compSize),
    u32(params.uncompSize),
    u16(params.nameBytes.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(params.localOffset),
    params.nameBytes,
  ])
}

function endOfCentralDir(params: { entries: number; cdSize: number; cdOffset: number }) {
  return concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(params.entries),
    u16(params.entries),
    u32(params.cdSize),
    u32(params.cdOffset),
    u16(0),
  ])
}

function toUint8Array(chunk: ZipChunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return new Uint8Array(chunk)
}

export function createStoredZipStream<T extends ZipStreamFile>(
  files: T[],
  readChunks: (file: T) => AsyncIterable<ZipChunk> | Promise<AsyncIterable<ZipChunk>>
) {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0
      const central: Uint8Array[] = []
      const entries: Array<{ nameBytes: Uint8Array; time: number; date: number; crc: number; size: number; localOffset: number }> = []

      const enqueue = (b: Uint8Array) => {
        controller.enqueue(b)
        offset += b.length
      }

      try {
        for (const f of files) {
          const nameBytes = encoder.encode(f.relPath)
          const { time, date } = dosTimeDate(f.mtimeMs)
          const localOffset = offset
          enqueue(localHeader(nameBytes, time, date))

          let crc = crc32Init()
          let written = 0
          const chunks = await readChunks(f)
          for await (const rawChunk of chunks) {
            const chunk = toUint8Array(rawChunk)
            written += chunk.length
            crc = crc32Update(crc, chunk)
            enqueue(chunk)
          }

          const finalCrc = crc32Final(crc)
          enqueue(dataDescriptor(finalCrc, written, written))
          entries.push({ nameBytes, time, date, crc: finalCrc, size: written, localOffset })
        }

        const cdOffset = offset
        for (const e of entries) {
          central.push(
            centralHeader({
              nameBytes: e.nameBytes,
              time: e.time,
              date: e.date,
              crc: e.crc,
              compSize: e.size,
              uncompSize: e.size,
              localOffset: e.localOffset,
            })
          )
        }

        let cdSize = 0
        for (const c of central) cdSize += c.length
        for (const c of central) enqueue(c)
        enqueue(endOfCentralDir({ entries: entries.length, cdSize, cdOffset }))
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

export async function* readWebStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}
