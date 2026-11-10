import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const pieceLength = 1024 * 1024
const blockLength = 16 * 1024

function invalidControl() {
  return new Error('Invalid aria2 HTTP control file')
}

const hasBit = (bitmap, index) =>
  Boolean(bitmap[index >> 3] & (0x80 >> (index & 7)))
const setBit = (bitmap, index) => (bitmap[index >> 3] |= 0x80 >> (index & 7))

export async function readAria2Progress(controlPath) {
  let data
  try {
    data = await fs.readFile(controlPath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  let offset = 0
  const take = (length) => {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > data.length
    )
      throw invalidControl()
    const result = data.subarray(offset, offset + length)
    offset += length
    return result
  }
  const u32 = () => take(4).readUInt32BE()
  if (take(2).readUInt16BE() !== 1 || u32() !== 0 || u32() !== 0)
    throw invalidControl()
  const length = u32()
  const total = take(8).readBigUInt64BE()
  take(8) // HTTP has no uploaded data.
  if (!length || total > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidControl()
  const totalLength = Number(total)
  const pieceCount = Math.ceil(totalLength / length)
  const bitmapLength = u32()
  if (bitmapLength !== Math.ceil(pieceCount / 8)) throw invalidControl()
  const bitmap = take(bitmapLength)
  let completedLength = 0
  for (let index = 0; index < pieceCount; index++) {
    if (hasBit(bitmap, index))
      completedLength += Math.min(length, totalLength - index * length)
  }
  const count = u32()
  if (count > pieceCount || count > Math.floor((data.length - offset) / 12))
    throw invalidControl()
  const seen = new Set()
  for (let entry = 0; entry < count; entry++) {
    const index = u32()
    const partialLength = u32()
    const partialBitmapLength = u32()
    if (
      index >= pieceCount ||
      seen.has(index) ||
      hasBit(bitmap, index) ||
      partialLength !== Math.min(length, totalLength - index * length) ||
      partialBitmapLength !==
        Math.ceil(Math.ceil(partialLength / blockLength) / 8)
    )
      throw invalidControl()
    seen.add(index)
    const partial = take(partialBitmapLength)
    for (
      let block = 0;
      block < Math.ceil(partialLength / blockLength);
      block++
    ) {
      if (hasBit(partial, block))
        completedLength += Math.min(
          blockLength,
          partialLength - block * blockLength,
        )
    }
  }
  if (offset !== data.length || completedLength > totalLength)
    throw invalidControl()
  return { completedLength, totalLength, pieceLength: length }
}

async function statOrNull(filename) {
  try {
    return await fs.stat(filename)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function legacySegments(destination, { size, md5, url, signal }) {
  const directory = destination + '.parts'
  if (await statOrNull(directory)) {
    let manifest
    try {
      manifest = JSON.parse(
        await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'),
      )
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
      throw error
    }
    if (
      manifest?.version !== 1 ||
      manifest.size !== size ||
      manifest.identity !== (md5 || url) ||
      !Number.isSafeInteger(manifest.partSize) ||
      manifest.partSize <= 0
    )
      return null
    const segments = []
    for (const name of await fs.readdir(directory)) {
      signal?.throwIfAborted()
      if (!/^(0|[1-9]\d*)\.part$/.test(name)) continue
      const start = Number(name.slice(0, -5))
      if (
        !Number.isSafeInteger(start) ||
        start >= size ||
        start % manifest.partSize !== 0
      )
        continue
      const filename = path.join(directory, name)
      const stat = await statOrNull(filename)
      if (
        !stat?.isFile() ||
        stat.size <= 0 ||
        stat.size > Math.min(manifest.partSize, size - start)
      )
        continue
      segments.push({ filename, start, length: stat.size })
    }
    return segments.sort((a, b) => a.start - b.start)
  }
  const stat = await statOrNull(destination)
  return stat?.isFile() && stat.size > 0 && stat.size < size
    ? [{ filename: destination, start: 0, length: stat.size }]
    : null
}

function createControl(size, segments) {
  const ranges = []
  for (const segment of segments) {
    const end = segment.start + segment.length
    const last = ranges.at(-1)
    if (last && last.end >= segment.start) last.end = Math.max(last.end, end)
    else ranges.push({ start: segment.start, end })
  }
  const pieces = Math.ceil(size / pieceLength)
  const bitmap = Buffer.alloc(Math.ceil(pieces / 8))
  const partials = []
  let rangeIndex = 0
  let completedLength = 0
  for (let index = 0; index < pieces; index++) {
    const start = index * pieceLength
    const length = Math.min(pieceLength, size - start)
    const blocks = Math.ceil(length / blockLength)
    const partial = Buffer.alloc(Math.ceil(blocks / 8))
    let completedBlocks = 0
    for (let block = 0; block < blocks; block++) {
      const blockStart = start + block * blockLength
      const blockSize = Math.min(blockLength, size - blockStart)
      while (rangeIndex < ranges.length && ranges[rangeIndex].end <= blockStart)
        rangeIndex++
      const range = ranges[rangeIndex]
      if (
        range &&
        range.start <= blockStart &&
        range.end >= blockStart + blockSize
      ) {
        setBit(partial, block)
        completedBlocks++
        completedLength += blockSize
      }
    }
    if (completedBlocks === blocks) setBit(bitmap, index)
    else if (completedBlocks) partials.push({ index, length, bitmap: partial })
  }
  const chunks = [Buffer.from([0, 1])]
  const u32 = (value) => {
    const result = Buffer.alloc(4)
    result.writeUInt32BE(value)
    chunks.push(result)
  }
  u32(0)
  u32(0)
  u32(pieceLength)
  const lengths = Buffer.alloc(16)
  lengths.writeBigUInt64BE(BigInt(size))
  chunks.push(lengths)
  u32(bitmap.length)
  chunks.push(bitmap)
  u32(partials.length)
  for (const partial of partials) {
    u32(partial.index)
    u32(partial.length)
    u32(partial.bitmap.length)
    chunks.push(partial.bitmap)
  }
  return { data: Buffer.concat(chunks), completedLength }
}

export async function migrateLegacy(destination, options = {}) {
  const { size, signal, onProgress } = options
  const unchanged = { migrated: false, completedLength: 0 }
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(size) || size <= 0) return unchanged
  const controlPath = destination + '.download.aria2'
  const dataPath = destination + '.download'
  const importPath = dataPath + '.importing'
  if (await statOrNull(controlPath)) {
    await fs.rm(importPath, { force: true })
    return unchanged
  }
  const importing = Boolean(await statOrNull(importPath))
  // aria2 removes its control after completion. Its remaining data must be
  // left for the caller's checksum check, never replaced by legacy fragments.
  if (!importing && (await statOrNull(dataPath))) return unchanged
  const segments = await legacySegments(destination, options)
  if (!segments?.length) return unchanged
  signal?.throwIfAborted()
  if (!importing) {
    const marker = await fs.open(importPath, 'wx')
    try {
      await marker.writeFile('1\n')
      await marker.sync()
    } finally {
      await marker.close()
    }
  }
  signal?.throwIfAborted()
  const output = await fs.open(dataPath, importing ? 'w' : 'wx')
  let copied = 0
  try {
    await output.truncate(size)
    const buffer = Buffer.alloc(1024 * 1024)
    for (const segment of segments) {
      signal?.throwIfAborted()
      const source = await fs.open(segment.filename, 'r')
      try {
        let position = 0
        while (position < segment.length) {
          signal?.throwIfAborted()
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, segment.length - position),
            position,
          )
          if (!bytesRead)
            throw new Error('Legacy download changed while importing')
          let written = 0
          while (written < bytesRead) {
            signal?.throwIfAborted()
            const { bytesWritten } = await output.write(
              buffer,
              written,
              bytesRead - written,
              segment.start + position + written,
            )
            if (!bytesWritten)
              throw new Error('Cannot write imported download data')
            written += bytesWritten
            copied += bytesWritten
            onProgress?.(copied, false)
          }
          position += bytesRead
        }
      } finally {
        await source.close()
      }
    }
    signal?.throwIfAborted()
    await output.sync()
  } finally {
    await output.close()
  }
  signal?.throwIfAborted()
  const { data, completedLength } = createControl(size, segments)
  const temporary = controlPath + `.${randomUUID()}.tmp`
  try {
    const control = await fs.open(temporary, 'wx')
    try {
      await control.writeFile(data)
      await control.sync()
    } finally {
      await control.close()
    }
    signal?.throwIfAborted()
    await fs.rename(temporary, controlPath)
  } finally {
    await fs.rm(temporary, { force: true })
  }
  await fs.rm(importPath, { force: true })
  return { migrated: true, completedLength }
}
