import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import fileSystem from 'node:fs'
import { readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { DownloadScheduler } from './transfer.js'
import { readAria2Progress } from './aria2-resume.js'

const MiB = 1024 ** 2
const digest = (data) => crypto.createHash('md5').update(data).digest('hex')

async function fixture(
  t,
  {
    ignoreRange = false,
    corrupt = false,
    slowLarge = false,
    interval = 3,
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-transfer-'))
  const content = crypto.randomBytes(12 * MiB)
  const requests = []
  const responses = new Set()
  const snapshots = []
  let peak = 0
  let transferred = 0
  const server = http.createServer((req, res) => {
    res.requestUrl = req.url
    responses.add(res)
    // 被 aria2 取消的探测 socket 可能已销毁，但 response.close 要晚一轮事件。
    // 只计仍能传输的连接，不能把关闭中的事务误算为额外下载线程。
    const live = [...responses].filter(
      (response) =>
        !response.writableEnded &&
        !response.destroyed &&
        !response.socket?.destroyed,
    )
    snapshots.push(live.map((response) => response.requestUrl))
    peak = Math.max(peak, live.length)
    res.on('close', () => responses.delete(res))
    const range =
      !ignoreRange && /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
    const start = range ? Number(range[1]) : 0
    const length = req.url.includes('small') ? MiB : content.length
    const end = range && range[2] ? Number(range[2]) : length - 1
    requests.push({ url: req.url, start, end, range: !!range })
    const headers = {
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
    }
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${length}`
    res.writeHead(range ? 206 : 200, headers)
    let offset = start
    const timer = setInterval(
      () => {
        const next = Math.min(end + 1, offset + 32768)
        const chunk = corrupt
          ? Buffer.alloc(next - offset)
          : content.subarray(offset, next)
        transferred += chunk.length
        res.write(chunk)
        offset = next
        if (offset > end) {
          clearInterval(timer)
          res.end()
        }
      },
      slowLarge && !req.url.includes('small') ? 15 : interval,
    )
    res.on('close', () => clearInterval(timer))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await fs.rm(directory, { recursive: true, force: true })
  })
  return {
    directory,
    content,
    requests,
    snapshots,
    url: `http://127.0.0.1:${server.address().port}/file`,
    get peak() {
      return peak
    },
    get transferred() {
      return transferred
    },
  }
}

test('native multithread download writes one data file without fragment directories or assembly', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(8)
  t.after(() => scheduler.close())
  const destination = path.join(f.directory, 'game.pak')
  let inspected = false
  let assembled = false
  const verification = []
  const result = await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onProgress(current) {
      if (current > MiB && current < f.content.length) {
        inspected = true
        const files = readdirSync(f.directory)
        assert.ok(files.includes('game.pak.download'))
        assert.ok(
          files.every(
            (name) => !name.endsWith('.parts') && !name.endsWith('.assembling'),
          ),
        )
      }
    },
    onAssembleProgress() {
      assembled = true
    },
    onVerifyProgress(current) {
      verification.push(current)
    },
  })
  assert.equal(inspected, true)
  assert.equal(assembled, false)
  assert.equal(result.verified, true)
  assert.deepEqual(await fs.readFile(destination), f.content)
  assert.deepEqual(await fs.readdir(f.directory), ['game.pak'])
  assert.ok(f.peak >= 4, `only ${f.peak} concurrent requests`)
  assert.ok(f.peak <= 8, `oversubscribed ${f.peak}`)
  assert.equal(verification[0], 0)
  assert.equal(verification.at(-1), f.content.length)
  if (process.platform === 'win32') {
    const attributes = Number(
      execFileSync(
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `[int](Get-Item -LiteralPath '${destination.replaceAll("'", "''")}').Attributes`,
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    )
    assert.ok(
      attributes & 512,
      'native Windows downloads must use sparse files',
    )
  }
})

test('interruption persists native control and a fresh engine resumes missing bytes only', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  const controller = new AbortController()
  let network = 0
  let previous = 0
  const first = new DownloadScheduler(4)
  t.after(() => first.close())
  await assert.rejects(
    first.download(f.url, destination, {
      size: f.content.length,
      md5: digest(f.content),
      signal: controller.signal,
      onProgress(current, fromNetwork) {
        if (fromNetwork) network += Math.max(0, current - previous)
        previous = current
        if (current > 2 * MiB) controller.abort(new Error('test interrupt'))
      },
    }),
    /test interrupt/,
  )
  await first.close()
  const saved = await readAria2Progress(destination + '.download.aria2')
  assert.ok(saved.completedLength >= 2 * MiB)
  assert.ok(saved.completedLength < f.content.length)
  assert.ok(
    network >= saved.completedLength,
    'final network bytes before pause were lost',
  )
  assert.equal(
    await fs.stat(destination).then(
      () => true,
      () => false,
    ),
    false,
  )
  assert.deepEqual((await fs.readdir(f.directory)).sort(), [
    'game.pak.download',
    'game.pak.download.aria2',
    'game.pak.download.json',
  ])
  const before = f.transferred
  const reports = []
  const second = new DownloadScheduler(4)
  t.after(() => second.close())
  await second.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onProgress(current, network) {
      reports.push({ current, network })
    },
  })
  assert.deepEqual(reports[0], {
    current: saved.completedLength,
    network: false,
  })
  assert.ok(f.transferred - before < f.content.length - MiB)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('a transient RPC timeout does not stop a healthy native download', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  await scheduler.initialize()
  const realFetch = globalThis.fetch
  let interrupted = 0
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (
      url === scheduler.client.endpoint &&
      JSON.parse(options.body).method === 'aria2.tellStatus' &&
      interrupted < 2
    ) {
      const name = ['TimeoutError', 'AbortError'][interrupted++]
      return Promise.reject(new DOMException('RPC temporarily busy', name))
    }
    return realFetch(url, options)
  })
  const destination = path.join(f.directory, 'game.pak')
  const result = await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
  })
  assert.equal(interrupted, 2)
  assert.equal(result.verified, true)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('an ambiguous addUri timeout stops the old engine before a safe retry', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  await scheduler.initialize()
  const oldClient = scheduler.client
  const realFetch = globalThis.fetch
  let interrupted = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await realFetch(url, options)
    if (
      url === oldClient.endpoint &&
      JSON.parse(options.body).method === 'aria2.addUri' &&
      !interrupted
    ) {
      interrupted = true
      await response.arrayBuffer()
      throw new DOMException(
        'accepted request lost its response',
        'TimeoutError',
      )
    }
    return response
  })
  const destination = path.join(f.directory, 'game.pak')
  const options = { size: f.content.length, md5: digest(f.content) }
  await assert.rejects(
    scheduler.download(f.url, destination, options),
    /RPC addUri.*accepted request lost its response/,
  )
  assert.notEqual(oldClient.child.exitCode, null, 'old engine is still running')
  await scheduler.download(f.url, destination, options)
  assert.notEqual(scheduler.client, oldClient)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('an accepted addUri with a reset response body stops its engine before retrying', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  await scheduler.initialize()
  const oldClient = scheduler.client
  const realFetch = globalThis.fetch
  let interrupted = false
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await realFetch(url, options)
    if (
      url === oldClient.endpoint &&
      JSON.parse(options.body).method === 'aria2.addUri' &&
      !interrupted
    ) {
      interrupted = true
      await response.arrayBuffer()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(
              new TypeError('terminated', {
                cause: { code: 'UND_ERR_SOCKET' },
              }),
            )
          },
        }),
      )
    }
    return response
  })
  const destination = path.join(f.directory, 'game.pak')
  const options = { size: f.content.length, md5: digest(f.content) }
  await assert.rejects(
    scheduler.download(f.url, destination, options),
    /RPC addUri.*UND_ERR_SOCKET/,
  )
  assert.ok(
    oldClient.child.exitCode !== null || oldClient.child.signalCode !== null,
  )
  await scheduler.download(f.url, destination, options)
  assert.notEqual(scheduler.client, oldClient)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('a failed native engine can be replaced and its unfinished download resumed', async (t) => {
  const f = await fixture(t, { slowLarge: true })
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const destination = path.join(f.directory, 'game.pak')
  let stoppedClient
  await assert.rejects(
    scheduler.download(f.url, destination, {
      size: f.content.length,
      md5: digest(f.content),
      onProgress(current) {
        if (current > 2 * MiB && !stoppedClient)
          readAria2Progress(destination + '.download.aria2')
            .then((saved) => {
              if (saved?.completedLength >= MiB && !stoppedClient) {
                stoppedClient = scheduler.client
                stoppedClient.child.kill()
              }
            })
            .catch(() => {})
      },
    }),
    /aria2|fetch|ECONN/i,
  )
  await stoppedClient.exited
  assert.match(stoppedClient.error.message, /SIGTERM/)
  let recovered = 0
  await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onProgress(current, network) {
      if (!network) recovered = Math.max(recovered, current)
    },
  })
  assert.notEqual(scheduler.client, stoppedClient)
  assert.ok(recovered >= MiB, 'native resume state was discarded')
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('parallel file retries survive a shared engine exit without rejecting the replacement jobs', async (t) => {
  const f = await fixture(t, { slowLarge: true })
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  let killed = false
  await Promise.all(
    [0, 1].map(async (i) => {
      const destination = path.join(f.directory, `${i}.pak`)
      const options = {
        size: f.content.length,
        md5: digest(f.content),
        onProgress(current) {
          if (current > MiB && !killed) {
            killed = true
            scheduler.client.child.kill()
          }
        },
      }
      await scheduler
        .download(f.url, destination, options)
        .catch(() => scheduler.download(f.url, destination, options))
      assert.deepEqual(await fs.readFile(destination), f.content)
    }),
  )
  assert.equal(killed, true)
})

test('multiple native jobs share the global connection budget and survive reallocation', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(6)
  t.after(() => scheduler.close())
  await Promise.all(
    [0, 1, 2, 3].map((i) =>
      scheduler.download(
        f.url + `?file=${i}`,
        path.join(f.directory, `${i}.pak`),
        { size: f.content.length, md5: digest(f.content) },
      ),
    ),
  )
  assert.ok(f.peak <= 6, `oversubscribed ${f.peak}`)
  assert.ok(f.peak >= 4)
  for (let i = 0; i < 4; i++)
    assert.equal(
      digest(await fs.readFile(path.join(f.directory, `${i}.pak`))),
      digest(f.content),
    )
})

test('completed downloads are hashed concurrently without occupying the native engine', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(8)
  t.after(() => scheduler.close())
  const streams = new Set()
  const held = new Set()
  let peak = 0
  const read = fileSystem.createReadStream
  t.mock.method(fileSystem, 'createReadStream', (filename, options) => {
    const stream = read(filename, options)
    if (!String(filename).endsWith('.download')) return stream
    streams.add(stream)
    peak = Math.max(peak, streams.size)
    stream.once('close', () => streams.delete(stream))
    // Emulate a slow disk read; a second checksum must start before it finishes.
    stream.once('data', () => {
      if (streams.size < 2) {
        stream.pause()
        held.add(stream)
        const timer = setTimeout(() => stream.resume(), 1000)
        stream.once('close', () => clearTimeout(timer))
      }
    })
    if (streams.size >= 2) for (const other of held) other.resume()
    return stream
  })
  await Promise.all(
    [0, 1, 2, 3].map((i) =>
      scheduler.download(f.url + `?file=${i}`, path.join(f.directory, `${i}`), {
        size: f.content.length,
        md5: digest(f.content),
      }),
    ),
  )
  assert.ok(peak >= 2, `only ${peak} concurrent local checksum reads`)
  for (let i = 0; i < 4; i++)
    assert.deepEqual(
      await fs.readFile(path.join(f.directory, `${i}`)),
      f.content,
    )
})

test('small files fill the configured connection budget beyond four file slots', async (t) => {
  const f = await fixture(t, { interval: 15 })
  const scheduler = new DownloadScheduler(8)
  t.after(() => scheduler.close())
  const small = f.content.subarray(0, MiB)
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      scheduler.download(
        f.url + `?small=${i}`,
        path.join(f.directory, `${i}`),
        { size: small.length, md5: digest(small) },
      ),
    ),
  )
  assert.ok(f.peak > 4, `only ${f.peak} simultaneous file downloads`)
  assert.ok(f.peak <= 8, `oversubscribed ${f.peak}`)
  for (let i = 0; i < 8; i++)
    assert.deepEqual(await fs.readFile(path.join(f.directory, `${i}`)), small)
})

test('checksum failure is reported and never publishes a completed destination', async (t) => {
  const f = await fixture(t, { corrupt: true })
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const destination = path.join(f.directory, 'game.pak')
  let retained = 0
  await assert.rejects(
    scheduler.download(f.url, destination, {
      size: f.content.length,
      md5: digest(f.content),
      onProgress(current) {
        retained = current
      },
    }),
    /校验|checksum/i,
  )
  assert.equal(retained, 0, 'deleted corrupt data still counted as retained')
  assert.equal(
    await fs.stat(destination).then(
      () => true,
      () => false,
    ),
    false,
  )
})

test('HTTP servers without Range support still produce a correct single file', async (t) => {
  const f = await fixture(t, { ignoreRange: true })
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const destination = path.join(f.directory, 'game.pak')
  await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
  })
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('a completed native file survives the rename window without another download or transfer count', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  await fs.writeFile(destination, f.content.subarray(0, 65536))
  await fs.writeFile(destination + '.download', f.content)
  await fs.writeFile(
    destination + '.download.json',
    JSON.stringify({
      version: 1,
      size: f.content.length,
      identity: digest(f.content),
    }),
  )
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  let previous = 0
  let network = 0
  await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onProgress(current, fromNetwork) {
      if (fromNetwork) network += Math.max(0, current - previous)
      previous = current
    },
  })
  assert.deepEqual(await fs.readFile(destination), f.content)
  assert.equal(f.requests.length, 0)
  assert.ok(f.transferred < MiB, 'completed data was downloaded again')
  assert.equal(network, 0)
})

test('a changed checksum at the same URL cannot reuse native data from the previous version', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  await fs.writeFile(
    destination + '.download',
    Buffer.alloc(f.content.length, 1),
  )
  await fs.writeFile(
    destination + '.download.json',
    JSON.stringify({
      version: 1,
      size: f.content.length,
      identity: '00000000000000000000000000000000',
    }),
  )
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const local = []
  await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onProgress(current, network) {
      if (!network) local.push(current)
    },
  })
  assert.equal(local[0], 0)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test('legacy fragment import is visible, preserves sources until verification and resumes without assembly', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  const parts = destination + '.parts'
  await fs.mkdir(parts)
  await fs.writeFile(
    path.join(parts, 'manifest.json'),
    JSON.stringify({
      version: 1,
      size: f.content.length,
      identity: digest(f.content),
      partSize: MiB,
    }),
  )
  await fs.writeFile(path.join(parts, '0.part'), f.content.subarray(0, MiB))
  await fs.writeFile(
    path.join(parts, `${4 * MiB}.part`),
    f.content.subarray(4 * MiB, 5 * MiB),
  )
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  let migrated = 0
  let verified = false
  let firstLocal
  await scheduler.download(f.url, destination, {
    size: f.content.length,
    md5: digest(f.content),
    onMigrationProgress(current) {
      migrated = current
    },
    onProgress(current, network) {
      if (!network && firstLocal === undefined) firstLocal = current
      if (!verified)
        assert.ok(readdirSync(f.directory).includes('game.pak.parts'))
    },
    onVerifyProgress() {
      verified = true
    },
  })
  assert.equal(migrated, 2 * MiB)
  assert.equal(firstLocal, 2 * MiB)
  assert.ok(f.transferred < f.content.length - MiB)
  assert.deepEqual(await fs.readFile(destination), f.content)
  assert.deepEqual(await fs.readdir(f.directory), ['game.pak'])
})

test('unexpected native engine exit rejects active jobs and leaves resumable files', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  let killed = false
  await assert.rejects(
    scheduler.download(f.url, destination, {
      size: f.content.length,
      md5: digest(f.content),
      onProgress(current) {
        if (current > MiB && !killed) {
          killed = true
          scheduler.client.child.kill()
        }
      },
    }),
    /aria2|fetch|ECONN/i,
  )
  assert.ok(killed)
  assert.ok((await fs.readdir(f.directory)).includes('game.pak.download'))
  assert.equal(
    await fs.stat(destination).then(
      () => true,
      () => false,
    ),
    false,
  )
})

test('one destination rename failure does not cancel other native downloads', async (t) => {
  const f = await fixture(t)
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const bad = path.join(f.directory, 'blocked.pak')
  const good = path.join(f.directory, 'good.pak')
  let blocker
  const jobs = [
    scheduler.download(f.url + '?bad', bad, {
      size: f.content.length,
      md5: digest(f.content),
      onProgress(current) {
        if (current > MiB && !blocker) blocker = fs.mkdir(bad)
      },
    }),
    scheduler.download(f.url + '?good', good, {
      size: f.content.length,
      md5: digest(f.content),
    }),
  ]
  const results = await Promise.allSettled(jobs)
  await blocker
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled', results[1].reason?.message)
  assert.deepEqual(await fs.readFile(good), f.content)
})

test('a bad legacy fragment fails checksum once, then retries without importing the corrupt source again', async (t) => {
  const f = await fixture(t)
  const destination = path.join(f.directory, 'game.pak')
  const parts = destination + '.parts'
  await fs.mkdir(parts)
  await fs.writeFile(
    path.join(parts, 'manifest.json'),
    JSON.stringify({
      version: 1,
      size: f.content.length,
      identity: digest(f.content),
      partSize: MiB,
    }),
  )
  await fs.writeFile(path.join(parts, '0.part'), Buffer.alloc(MiB))
  const scheduler = new DownloadScheduler(4)
  t.after(() => scheduler.close())
  const options = { size: f.content.length, md5: digest(f.content) }
  await assert.rejects(scheduler.download(f.url, destination, options), /校验/)
  assert.deepEqual(
    await fs.readFile(path.join(parts, '0.part')),
    Buffer.alloc(MiB),
  )
  await scheduler.download(f.url, destination, options)
  assert.deepEqual(await fs.readFile(destination), f.content)
})

test(
  'engine exit settles every job even if the first native control is corrupt',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t)
    const scheduler = new DownloadScheduler(4)
    t.after(() => scheduler.close())
    const destination = path.join(f.directory, 'first.pak')
    let killed = false
    const results = await Promise.allSettled([
      scheduler.download(f.url + '?first', destination, {
        size: f.content.length,
        md5: digest(f.content),
        onProgress(current) {
          if (current > MiB && !killed) {
            killed = true
            scheduler.client.child.kill()
            writeFileSync(destination + '.download.aria2', 'corrupted control')
          }
        },
      }),
      scheduler.download(
        f.url + '?second',
        path.join(f.directory, 'second.pak'),
        { size: f.content.length, md5: digest(f.content) },
      ),
    ])
    assert.equal(killed, true)
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'rejected'],
    )
    for (const result of results)
      assert.match(result.reason.message, /aria2|fetch|ECONN/i)
  },
)

test('small files keep one connection while the large tail receives their released capacity', async (t) => {
  const f = await fixture(t, { slowLarge: true })
  const scheduler = new DownloadScheduler(6)
  t.after(() => scheduler.close())
  const small = f.content.subarray(0, MiB)
  await Promise.all([
    scheduler.download(f.url + '?large', path.join(f.directory, 'large.pak'), {
      size: f.content.length,
      md5: digest(f.content),
    }),
    scheduler.download(f.url + '?small', path.join(f.directory, 'small.pak'), {
      size: small.length,
      md5: digest(small),
    }),
  ])
  const shared = f.snapshots.filter((urls) =>
    urls.some((url) => url.includes('small')),
  )
  assert.ok(
    shared.some(
      (urls) => urls.filter((url) => url.includes('large')).length >= 4,
    ),
  )
  assert.ok(
    shared.every(
      (urls) => urls.filter((url) => url.includes('small')).length <= 1,
    ),
  )
  assert.ok(
    f.snapshots.some(
      (urls) => urls.length === 6 && urls.every((url) => url.includes('large')),
    ),
    'released connection was not reused by the large file',
  )
  assert.ok(f.peak <= 6, `oversubscribed ${f.peak}`)
  assert.deepEqual(
    await fs.readFile(path.join(f.directory, 'large.pak')),
    f.content,
  )
  assert.deepEqual(
    await fs.readFile(path.join(f.directory, 'small.pak')),
    small,
  )
})
