import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { migrateLegacy, readAria2Progress } from './aria2-resume.js'

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-resume-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'payload.bin')
}

// Independent fixture for the documented network-endian HTTP control format.
function control({ total = 1088576, pieces = 0x80, inflight = [] } = {}) {
  const chunks = []
  const u32 = (value) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(value)
    chunks.push(buffer)
  }
  chunks.push(Buffer.from([0, 1]))
  u32(0)
  u32(0)
  u32(1048576)
  const lengths = Buffer.alloc(16)
  lengths.writeBigUInt64BE(BigInt(total))
  chunks.push(lengths)
  u32(1)
  chunks.push(Buffer.from([pieces]))
  u32(inflight.length)
  for (const { index, length, bitmap } of inflight) {
    u32(index)
    u32(length)
    u32(bitmap.length)
    chunks.push(Buffer.from(bitmap))
  }
  return Buffer.concat(chunks)
}

test('missing native control has no reported progress', async (t) => {
  assert.equal(await readAria2Progress(await fixture(t)), null)
})

test('native progress counts full pieces and short final blocks exactly', async (t) => {
  const destination = await fixture(t)
  await fs.writeFile(
    destination,
    control({ inflight: [{ index: 1, length: 40000, bitmap: [0xa0] }] }),
  )
  assert.deepEqual(await readAria2Progress(destination), {
    completedLength: 1072192,
    totalLength: 1088576,
    pieceLength: 1048576,
  })
})

test('native progress rejects truncated and duplicate piece records', async (t) => {
  const destination = await fixture(t)
  const part = { index: 1, length: 40000, bitmap: [0x80] }
  for (const invalid of [
    control().subarray(0, 30),
    control({ inflight: [part, part] }),
    control({ inflight: [{ ...part, index: 0, length: 1048576 }] }),
  ]) {
    await fs.writeFile(destination, invalid)
    await assert.rejects(readAria2Progress(destination), /aria2|control/i)
  }
})

test('native progress rejects unsafe lengths and inconsistent bitmaps', async (t) => {
  const destination = await fixture(t)
  const unsafe = control()
  unsafe.writeBigUInt64BE(9007199254740992n, 14)
  const zeroPiece = control()
  zeroPiece.writeUInt32BE(0, 10)
  for (const invalid of [
    unsafe,
    zeroPiece,
    control({ inflight: [{ index: 1, length: 39999, bitmap: [0x80] }] }),
    control({ inflight: [{ index: 1, length: 40000, bitmap: [] }] }),
  ]) {
    await fs.writeFile(destination, invalid)
    await assert.rejects(readAria2Progress(destination), /aria2|control/i)
  }
})

async function legacy(
  destination,
  size,
  partSize,
  fragments,
  identity = 'checksum',
) {
  await fs.mkdir(destination + '.parts')
  await fs.writeFile(
    path.join(destination + '.parts', 'manifest.json'),
    JSON.stringify({ version: 1, size, partSize, identity }),
  )
  for (const [start, length] of fragments) {
    await fs.writeFile(
      path.join(destination + '.parts', `${start}.part`),
      Buffer.alloc(length, (start / 10000 + 1) % 256),
    )
  }
}

test('legacy fragments copy at offsets and union adjacent coverage into complete blocks', async (t) => {
  const destination = await fixture(t)
  await legacy(destination, 50000, 10000, [
    [0, 10000],
    [10000, 10000],
    [20000, 5000],
    [30000, 10000],
    [40000, 10000],
  ])
  const progress = []
  assert.deepEqual(
    await migrateLegacy(destination, {
      size: 50000,
      md5: 'checksum',
      onProgress: (bytes, network) => progress.push([bytes, network]),
    }),
    { migrated: true, completedLength: 33616 },
  )
  const target = await fs.readFile(destination + '.download')
  assert.equal(target.length, 50000)
  assert.equal(target[10000], 2)
  assert.equal(target[25000], 0)
  assert.equal(target[40000], 5)
  assert.deepEqual(progress.at(-1), [45000, false])
  assert.equal(
    (await readAria2Progress(destination + '.download.aria2')).completedLength,
    33616,
  )
  assert.equal(
    (await fs.stat(path.join(destination + '.parts', '0.part'))).size,
    10000,
  )
})

test('a contiguous legacy prefix retains the original and marks only whole blocks', async (t) => {
  const destination = await fixture(t)
  await fs.writeFile(destination, Buffer.alloc(33000, 7))
  assert.deepEqual(
    await migrateLegacy(destination, {
      size: 60000,
      url: 'https://example.test/a',
    }),
    {
      migrated: true,
      completedLength: 32768,
    },
  )
  assert.deepEqual(await fs.readFile(destination), Buffer.alloc(33000, 7))
  assert.equal((await fs.readFile(destination + '.download'))[32999], 7)
})

test('mismatched manifests never fall back to importing an unverified prefix', async (t) => {
  const destination = await fixture(t)
  await legacy(destination, 50000, 10000, [[0, 10000]], 'wrong')
  await fs.writeFile(destination, Buffer.alloc(20000))
  assert.deepEqual(
    await migrateLegacy(destination, { size: 50000, md5: 'checksum' }),
    {
      migrated: false,
      completedLength: 0,
    },
  )
  await assert.rejects(fs.stat(destination + '.download'), { code: 'ENOENT' })
})

test('a null legacy manifest is not imported or used to replace original data', async (t) => {
  const destination = await fixture(t)
  await fs.mkdir(destination + '.parts')
  await fs.writeFile(path.join(destination + '.parts', 'manifest.json'), 'null')
  await fs.writeFile(destination, Buffer.alloc(20000, 9))
  assert.deepEqual(await migrateLegacy(destination, { size: 50000 }), {
    migrated: false,
    completedLength: 0,
  })
  assert.deepEqual(await fs.readFile(destination), Buffer.alloc(20000, 9))
})

test('oversized legacy fragments are ignored without changing source data', async (t) => {
  const destination = await fixture(t)
  await legacy(destination, 20000, 10000, [
    [0, 10001],
    [10000, 10000],
  ])
  assert.deepEqual(
    await migrateLegacy(destination, { size: 20000, md5: 'checksum' }),
    {
      migrated: true,
      completedLength: 3616,
    },
  )
  assert.equal(
    (await fs.stat(path.join(destination + '.parts', '0.part'))).size,
    10001,
  )
})

test('an existing native control prevents repeat migration', async (t) => {
  const destination = await fixture(t)
  await fs.writeFile(destination, Buffer.alloc(33000))
  await fs.writeFile(destination + '.download.aria2', Buffer.from('existing'))
  await fs.writeFile(destination + '.download.importing', '')
  assert.deepEqual(await migrateLegacy(destination, { size: 60000 }), {
    migrated: false,
    completedLength: 0,
  })
  assert.equal(
    await fs.readFile(destination + '.download.aria2', 'utf8'),
    'existing',
  )
  await assert.rejects(fs.stat(destination + '.download.importing'), {
    code: 'ENOENT',
  })
})

test('native data without an import marker is preserved even when legacy fragments remain', async (t) => {
  const destination = await fixture(t)
  await legacy(destination, 50000, 10000, [[0, 10000]])
  const nativeData = Buffer.alloc(50000, 31)
  await fs.writeFile(destination + '.download', nativeData)
  assert.deepEqual(
    await migrateLegacy(destination, { size: 50000, md5: 'checksum' }),
    {
      migrated: false,
      completedLength: 0,
    },
  )
  assert.deepEqual(await fs.readFile(destination + '.download'), nativeData)
  await assert.rejects(fs.stat(destination + '.download.aria2'), {
    code: 'ENOENT',
  })
  await assert.rejects(fs.stat(destination + '.download.importing'), {
    code: 'ENOENT',
  })
})

test('an interrupted import marker permits rebuilding only the imported native data', async (t) => {
  const destination = await fixture(t)
  await fs.writeFile(destination, Buffer.alloc(33000, 7))
  await fs.writeFile(destination + '.download', Buffer.alloc(60000, 99))
  await fs.writeFile(destination + '.download.importing', '')
  assert.deepEqual(await migrateLegacy(destination, { size: 60000 }), {
    migrated: true,
    completedLength: 32768,
  })
  assert.deepEqual(
    (await fs.readFile(destination + '.download')).subarray(0, 33000),
    Buffer.alloc(33000, 7),
  )
  assert.deepEqual(await fs.readFile(destination), Buffer.alloc(33000, 7))
  await assert.rejects(fs.stat(destination + '.download.importing'), {
    code: 'ENOENT',
  })
})

test('cancellation preserves original fragments and does not publish control', async (t) => {
  const destination = await fixture(t)
  await legacy(destination, 50000, 10000, [
    [0, 10000],
    [10000, 10000],
  ])
  const controller = new AbortController()
  await assert.rejects(
    migrateLegacy(destination, {
      size: 50000,
      md5: 'checksum',
      signal: controller.signal,
      onProgress: () => controller.abort(),
    }),
    { name: 'AbortError' },
  )
  assert.equal(
    (await fs.stat(path.join(destination + '.parts', '0.part'))).size,
    10000,
  )
  await assert.rejects(fs.stat(destination + '.download.aria2'), {
    code: 'ENOENT',
  })
  assert.equal(
    (await fs.stat(destination + '.download.importing')).isFile(),
    true,
  )
  assert.equal(
    (await fs.readdir(path.dirname(destination))).some((name) =>
      name.endsWith('.tmp'),
    ),
    false,
  )
})

test('real aria2 accepts migrated blocks and downloads only their missing suffix', async (t) => {
  const executable =
    process.env.ARIA2C_PATH ||
    path.join(os.tmpdir(), 'ww-aria2-evaluation', 'aria2c.exe')
  try {
    await fs.access(executable)
  } catch {
    return t.skip('Optional aria2 fixture absent')
  }
  const destination = await fixture(t)
  const payload = Buffer.alloc(100000)
  for (let index = 0; index < payload.length; index++)
    payload[index] = index % 251
  await fs.writeFile(destination, payload.subarray(0, 33000))
  await migrateLegacy(destination, { size: payload.length })
  const ranges = []
  const server = http.createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Number(match[2]) : payload.length - 1
    ranges.push(start)
    response.writeHead(match ? 206 : 200, {
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      ...(match
        ? { 'Content-Range': `bytes ${start}-${end}/${payload.length}` }
        : {}),
    })
    response.end(payload.subarray(start, end + 1))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  await promisify(execFile)(
    executable,
    [
      '--no-conf=true',
      '--allow-overwrite=true',
      '--auto-file-renaming=false',
      '--continue=true',
      '--file-allocation=none',
      '--console-log-level=error',
      '--summary-interval=0',
      '--max-connection-per-server=1',
      '--split=1',
      '--dir',
      path.dirname(destination),
      '--out',
      path.basename(destination) + '.download',
      `http://127.0.0.1:${server.address().port}/payload`,
    ],
    { timeout: 15000, windowsHide: true },
  )
  assert.deepEqual(await fs.readFile(destination + '.download'), payload)
  assert.ok(
    ranges.includes(32768),
    `aria2 requested byte offsets ${JSON.stringify(ranges)}`,
  )
  assert.deepEqual(await fs.readFile(destination), payload.subarray(0, 33000))
})
