import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as wwResources from '../utils/wwResources.js'
import * as transfer from './transfer.js'

const indexUrl =
  'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json'

async function loadDownloaderResources(
  level,
  versionType = 'default',
  predownload = null,
) {
  const requests = []
  let source = fs
    .readFileSync(new URL('down.js', import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replaceAll('import.meta.url', 'moduleUrl')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
  if (level)
    source = source.replace(
      "const resourceLevel = 'UHD'",
      `const resourceLevel = '${level}'`,
    )
  if (versionType)
    source = source.replace(
      /const versionType = '[^']*'/,
      `const versionType = '${versionType}'`,
    )
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const files = await new AsyncFunction(
    'path',
    'https',
    'fileURLToPath',
    'dirname',
    'moduleUrl',
    'fetch',
    ...Object.keys(wwResources),
    ...Object.keys(transfer),
    source + '\nreturn await loadResources()',
  )(
    path,
    https,
    fileURLToPath,
    path.dirname,
    import.meta.url,
    async (url) => {
      requests.push(url)
      if (url === indexUrl) {
        return {
          ok: true,
          json: async () => ({
            cdnList: [{ url: 'https://cdn.example/' }],
            predownload,
            bundles: {
              UHD: { resourcePacks: ['common', 'uhd'] },
              HD: { resourcePacks: ['common', 'hd'] },
              SD: { resourcePacks: ['common', 'sd'] },
            },
            resourcePacks: Object.fromEntries(
              ['common', 'uhd', 'hd', 'sd'].map((name) => [
                name,
                {
                  indexFile: `${name}/index.json`,
                  baseUrl: `${name}/zip/`,
                },
              ]),
            ),
          }),
        }
      }
      const name = new URL(url).pathname.split('/')[1]
      return {
        ok: true,
        json: async () => ({
          resource: [{ dest: `Client/${name}.pak`, size: 1, md5: 'test' }],
        }),
      }
    },
    ...Object.values(wwResources),
    ...Object.values(transfer),
  )
  return { files, requests }
}

test('downloader defaults to UHD and uses each pack download base', async () => {
  const { files, requests } = await loadDownloaderResources()
  assert.deepEqual(requests, [
    indexUrl,
    'https://cdn.example/common/index.json',
    'https://cdn.example/uhd/index.json',
  ])
  assert.deepEqual(
    files.map((file) => file.url),
    [
      'https://cdn.example/common/zip/Client/common.pak',
      'https://cdn.example/uhd/zip/Client/uhd.pak',
    ],
  )
})

test('downloader selects HD or SD without loading other quality packs', async () => {
  for (const level of ['HD', 'SD']) {
    const { files } = await loadDownloaderResources(level)
    assert.deepEqual(
      files.map((file) => file.dest),
      ['Client/common.pak', `Client/${level.toLowerCase()}.pak`],
    )
  }
})

test('invalid downloader resource level fails before fetching pack manifests', async () => {
  await assert.rejects(loadDownloaderResources('INVALID'), /资源等级/)
})

test('pre downloads the selected upcoming bundle using the default CDN', async () => {
  for (const level of ['UHD', 'HD', 'SD']) {
    const { files, requests } = await loadDownloaderResources(level, 'pre', {
      bundles: { [level]: { resourcePacks: ['common', level.toLowerCase()] } },
      resourcePacks: Object.fromEntries(
        ['common', level.toLowerCase()].map((name) => [
          name,
          {
            indexFile: `pre/${name}/index.json`,
            baseUrl: `pre/${name}/zip/`,
          },
        ]),
      ),
    })
    assert.deepEqual(requests, [
      indexUrl,
      'https://cdn.example/pre/common/index.json',
      `https://cdn.example/pre/${level.toLowerCase()}/index.json`,
    ])
    assert.ok(
      files.every((file) => file.url.startsWith('https://cdn.example/pre/')),
    )
  }
})

test('pre uses its own CDN when provided and inherits default bundle definitions', async () => {
  const { requests } = await loadDownloaderResources('UHD', 'pre', {
    cdnList: [{ url: 'https://pre.example/' }],
    resourcePacks: Object.fromEntries(
      ['common', 'uhd'].map((name) => [
        name,
        {
          indexFile: `${name}/index.json`,
          baseUrl: `${name}/zip/`,
        },
      ]),
    ),
  })
  assert.deepEqual(requests, [
    indexUrl,
    'https://pre.example/common/index.json',
    'https://pre.example/uhd/index.json',
  ])
})

test('pre refuses unavailable predownloads instead of downloading the release', async () => {
  await assert.rejects(loadDownloaderResources('UHD', 'pre'), /预下载.*开放/)
  await assert.rejects(
    loadDownloaderResources('UHD', 'pre', {}),
    /预下载.*开放/,
  )
})

test('invalid version type is rejected', async () => {
  await assert.rejects(
    loadDownloaderResources('UHD', 'invalid'),
    /default\/pre/,
  )
})

function loadDownloaderRuntime(fileSystem = fs, options = {}) {
  let now = 0
  const output = []
  const logs = []
  const process = Object.assign(new EventEmitter(), {
    argv: ['node', 'down.js', ...(options.argv || [])],
    env: options.env || {},
    stdout: { isTTY: true, write: (value) => output.push(value) },
  })
  const source = fs
    .readFileSync(new URL('down.js', import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replaceAll('import.meta.url', 'moduleUrl')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
    .replace(
      "const targetDir = path.join(__dirname, 'ww')",
      options.targetDir
        ? `const targetDir = ${JSON.stringify(options.targetDir)}`
        : "const targetDir = path.join(__dirname, 'ww')",
    )
  const runtime = new Function(
    'fs',
    'path',
    'https',
    'fileURLToPath',
    'dirname',
    'moduleUrl',
    'process',
    'Date',
    'crypto',
    'console',
    ...Object.keys(wwResources),
    ...Object.keys(transfer),
    source +
      `\nreturn {
        ProgressManager, runWithConcurrency, handleFile, downloadFile,
        parseConcurrencyArg, main,
        getManager() { return progressManager },
        setResources(value) { loadResources = value },
        setManager(value) { progressManager = value },
        setHandler(value) { handleFile = value },
        setDownload(value) { downloadFile = value },
        setMD5(value) { getFileMD5 = value },
      }`,
  )(
    fileSystem,
    path,
    options.transport || https,
    fileURLToPath,
    path.dirname,
    import.meta.url,
    process,
    class extends Date {
      static now() {
        return now
      }
    },
    crypto,
    {
      log: (...values) => logs.push(values.join(' ')),
      error: (...values) => logs.push(values.join(' ')),
    },
    ...Object.values(wwResources),
    ...Object.values(transfer),
  )
  return {
    ...runtime,
    process,
    output,
    logs,
    setTime: (value) => (now = value),
  }
}

test('overall progress and ETA use bytes and current network speed, excluding verification', () => {
  const { ProgressManager, setTime, output } = loadDownloaderRuntime()
  const progress = new ProgressManager(3, 2, 1000)
  progress.updateSlot(0, { index: 0, phase: 'skip', total: 200 })
  progress.markComplete(true)
  progress.clearSlot(0)
  setTime(1000)
  progress.updateDownloaded(1, 200, true)
  assert.deepEqual(progress.getOverallProgress(), {
    percent: 40,
    speed: 200,
    eta: 3,
  })
  // 正在校验的已有文件不能当作网络下载，也不能使总进度虚增。
  progress.updateSlot(1, {
    index: 2,
    name: 'existing.pak',
    phase: 'verify',
    percent: 90,
    speed: 9000,
    current: 540,
    total: 600,
    elapsed: 1,
    eta: 1,
  })
  output.length = 0
  progress.forceRender()
  assert.match(output.join(''), /40\.0%/)
  assert.match(output.join(''), /400 B\/1000 B/)
  assert.match(output.join(''), /00:01\/00:03/)
  setTime(2000)
  assert.equal(progress.getOverallProgress().speed, 0)
  assert.equal(progress.getOverallProgress().eta, Infinity)
})

test('progress header and worker rows align with borders and reserve every rendered line', () => {
  const { ProgressManager, setTime, output } = loadDownloaderRuntime()
  const progress = new ProgressManager(924, 2, 110 * 1024 ** 3)
  progress.updateDownloaded(0, 50 * 1024 ** 3, true)
  progress.completed = 800
  progress.succeeded = 800
  setTime(7200000)
  progress.updateSlot(0, {
    index: 800,
    name: 'Client-WindowsNoEditor.pak',
    phase: 'download',
    percent: 45.5,
    speed: 1024 ** 2,
    current: 50 * 1024 ** 3,
    total: 110 * 1024 ** 3,
    elapsed: 7200,
    eta: 3600,
  })
  output.length = 0
  progress.forceRender()
  const rendered = output.at(-1)
  const rows = rendered.split('\n').filter((line) => line.includes('║'))
  for (const row of rows) assert.equal(progress.getDisplayWidth(row), 156, row)
  const header = rows.find((row) => row.includes('总进度'))
  const worker = rows.find((row) => /线程\s*1/.test(row))
  for (const value of ['45.5%', '50.00 GB/110.00 GB']) {
    assert.equal(
      progress.getDisplayWidth(header.slice(0, header.indexOf(value))),
      progress.getDisplayWidth(worker.slice(0, worker.indexOf(value))),
      value,
    )
  }
  assert.equal(rendered.split('\n').length - 1, progress.headerLines + 2)
  assert.equal(output[0], `\x1b[${progress.headerLines + 2}A`)
})

test('worker status icons preserve their original spacing before filenames', () => {
  const { ProgressManager, output } = loadDownloaderRuntime()
  const progress = new ProgressManager(1, 1, 10)
  const name = 'status-test.pak'
  for (const [phase, expected] of [
    ['download', '⬇️  '],
    ['verify', '🔍 '],
    ['done', '✅  '],
    ['error', '❌  '],
    ['skip', '⏭️  '],
    ['waiting', '⏳  '],
  ]) {
    progress.updateSlot(0, {
      index: 0,
      name,
      phase,
      percent: 50,
      speed: 5,
      current: 5,
      total: 10,
      elapsed: 1,
      eta: 1,
    })
    output.length = 0
    progress.forceRender()
    const row = output
      .at(-1)
      .split('\n')
      .find((line) => line.includes(name))
    const start = row.indexOf(expected.trimEnd())
    assert.equal(row.slice(start, row.indexOf(name)), expected, phase)
  }
})

test('retries reset byte progress and completed or skipped files are counted once', () => {
  const { ProgressManager, setTime } = loadDownloaderRuntime()
  const progress = new ProgressManager(2, 1, 1000)
  progress.isTTY = false
  assert.equal(progress.getOverallProgress().eta, Infinity)
  progress.updateDownloaded(0, 300, true)
  progress.updateDownloaded(0, 0, true)
  progress.updateDownloaded(0, 100, true)
  setTime(1000)
  assert.deepEqual(progress.getOverallProgress(), {
    percent: 10,
    speed: 400,
    eta: 2.25,
  })
  progress.updateSlot(0, { index: 0, phase: 'done', total: 400 })
  progress.clearSlot(0)
  progress.updateSlot(0, { index: 1, phase: 'skip', total: 600 })
  progress.updateSlot(0, { index: 1, phase: 'skip', total: 600 })
  assert.equal(progress.getOverallProgress().percent, 100)
  assert.equal(progress.getOverallProgress().eta, 0)
  progress.updateSlot(0, { index: 1, phase: 'error', current: 0, total: 600 })
  assert.equal(progress.getOverallProgress().percent, 40)
})

test('download callbacks count every chunk through throttling and retry, but not MD5 reads', async () => {
  let exists = false
  let size = 0
  const {
    ProgressManager,
    handleFile,
    setManager,
    setDownload,
    setMD5,
    setTime,
  } = loadDownloaderRuntime({
    mkdirSync() {},
    existsSync: () => exists,
    statSync: () => ({ size }),
    unlinkSync: () => (exists = false),
  })
  const progress = new ProgressManager(1, 1, 400)
  progress.isTTY = false
  setManager(progress)
  let attempt = 0
  setDownload(async (_url, _dest, onProgress) => {
    attempt++
    exists = true
    size = 100
    setTime(attempt * 10)
    onProgress(100)
    assert.equal(progress.getOverallProgress().percent, 25)
    if (attempt === 1) throw new Error('connection reset')
    size = 250
    onProgress(250)
    assert.equal(progress.getOverallProgress().percent, 62.5)
    size = 400
    onProgress(400)
    assert.equal(progress.getOverallProgress().percent, 100)
  })
  setMD5(async (_dest, onProgress) => {
    onProgress(300)
    assert.equal(progress.getOverallProgress().percent, 100)
    return 'valid-md5'
  })
  assert.equal(
    await handleFile(
      {
        dest: 'test.pak',
        url: 'https://cdn.example/test.pak',
        size: 400,
        md5: 'valid-md5',
      },
      0,
      1,
      0,
    ),
    true,
  )
  assert.equal(progress.succeeded, 1)
  setTime(1000)
  assert.deepEqual(progress.getOverallProgress(), {
    percent: 100,
    speed: 500,
    eta: 0,
  })
})

test('scheduler starts larger files first and refills available workers', async () => {
  const { ProgressManager, runWithConcurrency, setManager, setHandler } =
    loadDownloaderRuntime()
  const data = [
    { dest: 'small', size: 20 },
    { dest: 'large', size: 900 },
    { dest: 'tiny', size: 1 },
    { dest: 'medium', size: 400 },
  ]
  const progress = new ProgressManager(data.length, 2, 1321)
  progress.isTTY = false
  setManager(progress)
  const started = []
  const finish = new Map()
  setHandler(
    (file) =>
      new Promise((resolve) => {
        started.push(file.dest)
        finish.set(file.dest, () => {
          progress.markComplete(true)
          resolve()
        })
      }),
  )
  const running = runWithConcurrency(data, 2)
  assert.deepEqual(started, ['large', 'medium'])
  finish.get('medium')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['large', 'medium', 'small'])
  finish.get('small')()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ['large', 'medium', 'small', 'tiny'])
  finish.get('tiny')()
  finish.get('large')()
  await running
  assert.deepEqual(
    data.map((file) => file.dest),
    ['small', 'large', 'tiny', 'medium'],
  )
})

test('the total download thread budget is clamped to 4 through 16', () => {
  for (const [options, expected] of [
    [{ argv: ['-c', '1'] }, 4],
    [{ argv: ['--concurrency=99'] }, 16],
    [{ env: { DOWNLOAD_CONCURRENCY: '8' } }, 8],
  ]) {
    assert.equal(
      loadDownloaderRuntime(fs, options).parseConcurrencyArg(),
      expected,
    )
  }
})

async function createDownloadServer(t, content, handler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-download-'))
  const server = http.createServer((req, res) => handler(req, res, content))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return {
    directory,
    url: `http://127.0.0.1:${server.address().port}/file.pak`,
    destination: path.join(directory, 'file.pak'),
  }
}

function sendDownloadRange(req, res, content, delay = 20) {
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '')
  const start = range ? Number(range[1]) : 0
  const end = range ? Number(range[2]) : content.length - 1
  res.writeHead(range ? 206 : 200, {
    'Content-Length': end - start + 1,
    ...(range && {
      'Content-Range': `bytes ${start}-${end}/${content.length}`,
    }),
  })
  res.flushHeaders()
  setTimeout(() => res.end(content.subarray(start, end + 1)), delay)
}

test('a single file uses multiple range requests and assembles the original bytes', async (t) => {
  const content = Buffer.from(
    Array.from({ length: 4 * 1024 ** 2 }, (_, i) => i % 251),
  )
  let active = 0
  let maximumActive = 0
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      res.on('close', () => active--)
      sendDownloadRange(req, res, body)
    },
  )
  const { downloadFile } = loadDownloaderRuntime(fs, {
    transport: http,
    argv: ['-c', '16'],
  })
  await downloadFile(url, destination, () => {}, {
    size: content.length,
    md5: 'fixture-identity',
  })
  assert.deepEqual(fs.readFileSync(destination), content)
  assert.ok(maximumActive >= 4, `only ${maximumActive} simultaneous requests`)
  assert.ok(maximumActive <= 16, `${maximumActive} requests exceeded the limit`)
})

test('thread allocation follows remaining sizes and redistributes spare capacity', () => {
  assert.deepEqual(
    transfer.allocateThreads(
      [
        { remaining: 900, capacity: 16 },
        { remaining: 100, capacity: 16 },
      ],
      16,
    ),
    [14, 2],
  )
  assert.deepEqual(
    transfer.allocateThreads(
      [
        { remaining: 900, capacity: 1 },
        { remaining: 100, capacity: 16 },
      ],
      16,
    ),
    [1, 15],
  )
  assert.deepEqual(
    transfer.allocateThreads(
      [
        { remaining: 0, capacity: 0 },
        { remaining: 100, capacity: 16 },
      ],
      4,
    ),
    [0, 4],
  )
})

test(
  'multiple files share the global limit and the large tail receives idle threads',
  { timeout: 15000 },
  async (t) => {
    const large = Buffer.alloc(4 * 1024 ** 2, 19)
    const small = Buffer.alloc(512 * 1024, 73)
    const active = { large: 0, small: 0 }
    const snapshots = []
    const probes = new Map()
    const heldLargeResponses = []
    let largeReleased = false
    let smallSent = 0
    let smallFinished = false
    const { url, directory } = await createDownloadServer(
      t,
      large,
      (req, res) => {
        const name = req.url === '/small' ? 'small' : 'large'
        const content = name === 'small' ? small : large
        active[name]++
        snapshots.push({ ...active, smallFinished })
        res.on('finish', () => {
          active[name]--
          if (name === 'small') {
            const [, start, end] = /^bytes=(\d+)-(\d+)$/
              .exec(req.headers.range)
              .map(Number)
            smallSent += end - start + 1
            smallFinished = smallSent === small.length
          }
        })
        const send = () => {
          if (name === 'large' && !largeReleased) {
            const [, start, end] = /^bytes=(\d+)-(\d+)$/
              .exec(req.headers.range)
              .map(Number)
            res.writeHead(206, {
              'Content-Length': end - start + 1,
              'Content-Range': `bytes ${start}-${end}/${content.length}`,
            })
            res.flushHeaders()
            heldLargeResponses.push(() =>
              res.end(content.subarray(start, end + 1)),
            )
            // 等小文件结束、第四个大文件请求真正到达后再放行，避免依赖毫秒级时序。
            if (smallFinished && active.large === 4) {
              largeReleased = true
              for (const finish of heldLargeResponses) finish()
            }
          } else {
            sendDownloadRange(req, res, content)
          }
        }
        if (!probes.has(name)) {
          probes.set(name, send)
          if (probes.size === 2) for (const send of probes.values()) send()
        } else {
          send()
        }
      },
    )
    const scheduler = new transfer.DownloadScheduler(4)
    await Promise.all([
      scheduler.download(
        new URL('/large', url).href,
        path.join(directory, 'large.pak'),
        { size: large.length, md5: 'large' },
      ),
      scheduler.download(
        new URL('/small', url).href,
        path.join(directory, 'small.pak'),
        { size: small.length, md5: 'small' },
      ),
    ])
    assert.equal(smallSent, small.length)
    assert.ok(snapshots.every((value) => value.large + value.small <= 4))
    assert.ok(snapshots.some((value) => value.large === 3 && value.small === 1))
    assert.ok(
      snapshots.some((value) => value.smallFinished && value.large === 4),
    )
    assert.deepEqual(fs.readFileSync(path.join(directory, 'large.pak')), large)
    assert.deepEqual(fs.readFileSync(path.join(directory, 'small.pak')), small)
  },
)

test('restarting after an interruption resumes partial ranges without counting them as network bytes', async (t) => {
  const content = Buffer.alloc(4 * 1024 ** 2, 37)
  const controller = new AbortController()
  const resumedRequests = []
  let restarting = false
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      if (restarting) {
        resumedRequests.push(req.headers.range)
        sendDownloadRange(req, res, body)
        return
      }
      const [, start, end] = /^bytes=(\d+)-(\d+)$/
        .exec(req.headers.range)
        .map(Number)
      res.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
      })
      res.flushHeaders()
      res.write(body.subarray(start, start + 65536))
      const timer = setTimeout(
        () => res.end(body.subarray(start + 65536, end + 1)),
        500,
      )
      res.on('close', () => clearTimeout(timer))
    },
  )
  await assert.rejects(
    new transfer.DownloadScheduler(16).download(url, destination, {
      size: content.length,
      md5: 'resume-fixture',
      signal: controller.signal,
      onProgress(current, fromNetwork) {
        if (fromNetwork && current >= 65536)
          controller.abort(new Error('test interruption'))
      },
    }),
    /test interruption/,
  )
  const partialBytes = fs
    .readdirSync(destination + '.parts')
    .filter((name) => name.endsWith('.part'))
    .reduce(
      (sum, name) =>
        sum + fs.statSync(path.join(destination + '.parts', name)).size,
      0,
    )
  assert.ok(partialBytes > 0 && partialBytes < content.length)
  const progress = []
  restarting = true
  await new transfer.DownloadScheduler(4).download(url, destination, {
    size: content.length,
    md5: 'resume-fixture',
    onProgress: (current, fromNetwork) =>
      progress.push({ current, fromNetwork }),
  })
  assert.deepEqual(progress[0], { current: partialBytes, fromNetwork: false })
  const requestedBytes = resumedRequests.reduce((sum, value) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(value).map(Number)
    return sum + end - start + 1
  }, 0)
  assert.equal(requestedBytes, content.length - partialBytes)
  assert.equal(progress.at(-1).current, content.length)
  assert.ok(progress.slice(1).every((value) => value.fromNetwork))
  assert.deepEqual(fs.readFileSync(destination), content)
  assert.equal(fs.existsSync(destination + '.parts'), false)
  assert.equal(fs.existsSync(destination + '.assembling'), false)
})

test('legacy partial target files resume from their existing continuous prefix', async (t) => {
  const content = Buffer.alloc(2 * 1024 ** 2, 61)
  const requests = []
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      requests.push(req.headers.range)
      sendDownloadRange(req, res, body)
    },
  )
  const prefixSize = 700000
  fs.writeFileSync(destination, content.subarray(0, prefixSize))
  await new transfer.DownloadScheduler(8).download(url, destination, {
    size: content.length,
    md5: 'legacy-fixture',
  })
  const requestedBytes = requests.reduce((sum, value) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(value).map(Number)
    assert.ok(start >= prefixSize)
    return sum + end - start + 1
  }, 0)
  assert.equal(requestedBytes, content.length - prefixSize)
  assert.deepEqual(fs.readFileSync(destination), content)
})

test('HTTP 200 fallback restarts safely without appending a full response to resumed bytes', async (t) => {
  const content = Buffer.alloc(1024 ** 2, 47)
  let requests = 0
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (_req, res, body) => {
      requests++
      res.writeHead(200, { 'Content-Length': body.length })
      res.end(body)
    },
  )
  fs.writeFileSync(destination, content.subarray(0, 400000))
  await new transfer.DownloadScheduler(16).download(url, destination, {
    size: content.length,
    md5: 'fallback-fixture',
  })
  assert.equal(requests, 1)
  assert.deepEqual(fs.readFileSync(destination), content)
})

test('invalid Content-Range is rejected before writing response bytes', async (t) => {
  const content = Buffer.alloc(1024 ** 2, 29)
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/
        .exec(req.headers.range)
        .map(Number)
      res.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start + 1}-${end}/${body.length}`,
      })
      res.end(body.subarray(start, end + 1))
    },
  )
  await assert.rejects(
    new transfer.DownloadScheduler(16).download(url, destination, {
      size: content.length,
      md5: 'range-fixture',
    }),
    /Content-Range/,
  )
  assert.equal(fs.existsSync(destination), false)
  assert.deepEqual(
    fs
      .readdirSync(destination + '.parts')
      .filter((name) => name.endsWith('.part')),
    [],
  )
})

test('a changed manifest checksum discards old-version partial data at the same URL', async (t) => {
  const oldContent = Buffer.alloc(1024 ** 2, 11)
  const newContent = Buffer.alloc(1024 ** 2, 23)
  const controller = new AbortController()
  let updated = false
  const requested = []
  const { url, destination } = await createDownloadServer(
    t,
    oldContent,
    (req, res, body) => {
      if (updated) {
        requested.push(req.headers.range)
        sendDownloadRange(req, res, newContent)
      } else {
        sendDownloadRange(req, res, body)
      }
    },
  )
  await assert.rejects(
    new transfer.DownloadScheduler(4).download(url, destination, {
      size: oldContent.length,
      md5: 'old-version',
      signal: controller.signal,
      onProgress(current, network) {
        if (network && current > 0)
          controller.abort(new Error('old version stopped'))
      },
    }),
    /old version stopped/,
  )
  updated = true
  await new transfer.DownloadScheduler(4).download(url, destination, {
    size: newContent.length,
    md5: 'new-version',
  })
  const requestedBytes = requested.reduce((sum, value) => {
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(value).map(Number)
    return sum + end - start + 1
  }, 0)
  assert.equal(requestedBytes, newContent.length)
  assert.deepEqual(fs.readFileSync(destination), newContent)
})

test('the file handler resumes after a dropped connection and verifies the final MD5', async (t) => {
  const content = Buffer.alloc(2 * 1024 ** 2, 83)
  let dropped = false
  const { url, destination, directory } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      if (dropped) {
        sendDownloadRange(req, res, body)
        return
      }
      dropped = true
      const [, start, end] = /^bytes=(\d+)-(\d+)$/
        .exec(req.headers.range)
        .map(Number)
      res.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
      })
      res.write(body.subarray(start, start + 32768))
      const timer = setTimeout(() => res.destroy(), 30)
      res.on('close', () => clearTimeout(timer))
    },
  )
  const runtime = loadDownloaderRuntime(fs, {
    targetDir: directory,
    argv: ['-c', '4'],
  })
  const progress = new runtime.ProgressManager(1, 1, content.length)
  progress.isTTY = false
  runtime.setManager(progress)
  assert.equal(
    await runtime.handleFile(
      {
        dest: path.basename(destination),
        url,
        size: content.length,
        md5: crypto.createHash('md5').update(content).digest('hex'),
      },
      0,
      1,
      0,
    ),
    true,
  )
  assert.deepEqual(fs.readFileSync(destination), content)
  assert.equal(progress.succeeded, 1)
  assert.equal(progress.downloadedBytes, content.length)
  assert.equal(progress.transferredBytes, content.length)
})

test(
  'a file preparation failure is reported and does not leave the file scheduler waiting',
  { timeout: 1000 },
  async () => {
    const runtime = loadDownloaderRuntime()
    const progress = new runtime.ProgressManager(2, 1, 2)
    progress.isTTY = false
    runtime.setManager(progress)
    runtime.setHandler(async (file) => {
      if (file.dest === 'unwritable') throw new Error('disk unavailable')
      progress.markComplete(true)
    })
    await runtime.runWithConcurrency(
      [
        { dest: 'unwritable', size: 1 },
        { dest: 'valid', size: 1 },
      ],
      1,
    )
    assert.equal(progress.completed, 2)
    assert.equal(progress.failed, 1)
    assert.equal(progress.succeeded, 1)
    assert.match(progress.failedFiles[0].reason, /disk unavailable/)
  },
)

test('the final summary separates downloads, skips, verified data and actual transfer with complete failures', () => {
  const { ProgressManager, logs, setTime } = loadDownloaderRuntime()
  const progress = new ProgressManager(3, 2, 1000)
  progress.isTTY = false
  progress.updateSlot(0, { index: 0, phase: 'skip', total: 200 })
  progress.markComplete(true)
  progress.updateDownloaded(1, 400, true)
  progress.updateSlot(0, { index: 1, phase: 'done', total: 400 })
  progress.markComplete(true)
  progress.updateDownloaded(2, 100, true)
  const failedPath =
    'Client/Content/Paks/' + 'long-package-name-'.repeat(5) + '.pak'
  const reason =
    'connection closed while downloading ' + 'long-detail-'.repeat(8)
  progress.updateSlot(1, { index: 2, phase: 'error', current: 100, total: 400 })
  progress.markComplete(false, {
    index: 2,
    name: 'failed.pak',
    path: failedPath,
    reason,
  })
  setTime(2000)
  progress.finish()
  const summary = logs.join('\n')
  assert.match(summary, /下载结束.*部分失败/)
  assert.match(summary, /总计 3.*下载成功 1.*校验跳过 1.*失败 1/)
  assert.match(summary, /校验完成.*600 B.*1000 B.*60\.0%/)
  assert.match(summary, /本次传输.*500 B/)
  assert.match(summary, /平均速度.*250 B\/s/)
  assert.match(summary, /总用时.*00:02/)
  assert.match(summary, /保存目录/)
  assert.ok(summary.includes(failedPath))
  assert.ok(summary.includes(reason))
})

test('a fully cached run reports zero downloads and zero network speed', () => {
  const { ProgressManager, logs, setTime } = loadDownloaderRuntime()
  const progress = new ProgressManager(1, 1, 400)
  progress.isTTY = false
  progress.updateSlot(0, { index: 0, phase: 'skip', total: 400 })
  progress.updateSlot(0, { index: 0, phase: 'skip', total: 400 })
  progress.markComplete(true)
  setTime(1000)
  progress.finish()
  const summary = logs.join('\n')
  assert.match(summary, /总计 1.*下载成功 0.*校验跳过 1.*失败 0/)
  assert.match(summary, /校验完成.*400 B.*400 B.*100\.0%/)
  assert.match(summary, /本次传输.*0 B/)
  assert.match(summary, /平均速度.*0 B\/s/)
  assert.doesNotMatch(summary, /Infinity|NaN|失败文件/)
})

test(
  'Ctrl+C stops queued files, closes transfers and prints one resumable interruption summary',
  { timeout: 5000 },
  async (t) => {
    const content = Buffer.alloc(1024 ** 2, 47)
    const requests = []
    const { url, directory } = await createDownloadServer(
      t,
      content,
      (req, res, body) => {
        requests.push(req.url)
        sendDownloadRange(req, res, body)
      },
    )
    const runtime = loadDownloaderRuntime(fs, { targetDir: directory })
    runtime.process.stdout.isTTY = false
    runtime.setResources(async () =>
      Array.from({ length: 5 }, (_, index) => ({
        dest: `${index}.pak`,
        url: new URL(`/${index}.pak`, url).href,
        size: content.length,
        md5: crypto.createHash('md5').update(content).digest('hex'),
      })),
    )
    let interrupted = false
    const updateDownloaded = runtime.ProgressManager.prototype.updateDownloaded
    runtime.ProgressManager.prototype.updateDownloaded = function (...args) {
      updateDownloaded.apply(this, args)
      if (args[2] && !interrupted) {
        interrupted = true
        runtime.setTime(2000)
        runtime.process.emit('SIGINT')
        runtime.process.emit('SIGINT')
      }
    }
    await runtime.main()
    const progress = runtime.getManager()
    const summary = runtime.logs.join('\n')
    assert.equal(summary.match(/下载已中断/g)?.length, 1)
    assert.match(summary, /SIGINT/)
    assert.match(summary, /总计 5.*失败 0.*未完成 5/)
    assert.match(summary, /已保留进度/)
    assert.match(summary, /本次传输/)
    assert.match(summary, /总用时.*00:02/)
    assert.match(summary, /重新运行.*续传/)
    assert.equal(runtime.process.exitCode, 130)
    assert.equal(progress.failed, 0)
    assert.equal(progress.completed, 0)
    assert.ok(
      !requests.includes('/4.pak'),
      'queued file was started after interruption',
    )
    const retained = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.parts'))
      .reduce((sum, name) => {
        const parts = path.join(directory, name)
        return (
          sum +
          fs
            .readdirSync(parts)
            .filter((part) => part.endsWith('.part'))
            .reduce(
              (size, part) => size + fs.statSync(path.join(parts, part)).size,
              0,
            )
        )
      }, 0)
    assert.ok(retained > 0 && retained < content.length * 5)
    assert.equal(progress.downloadedBytes, retained)
    assert.equal(runtime.process.listenerCount('SIGINT'), 0)
    assert.equal(runtime.process.listenerCount('SIGTERM'), 0)
  },
)

test('SIGTERM during resource loading exits cleanly without inventing download statistics', async () => {
  const runtime = loadDownloaderRuntime()
  runtime.setResources(async (signal) => {
    runtime.process.emit('SIGTERM')
    signal?.throwIfAborted()
    return []
  })
  await runtime.main()
  const summary = runtime.logs.join('\n')
  assert.match(summary, /已中断.*SIGTERM/)
  assert.match(summary, /尚未开始下载/)
  assert.doesNotMatch(summary, /下载完成|文件统计|无法加载资源列表/)
  assert.equal(runtime.process.exitCode, 143)
  assert.equal(runtime.getManager(), null)
  assert.equal(runtime.process.listenerCount('SIGINT'), 0)
  assert.equal(runtime.process.listenerCount('SIGTERM'), 0)
})

test('interrupting a resume scan still reports the partial bytes it has identified', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-scan-interrupt-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const parts = path.join(directory, 'file.pak.parts')
  fs.mkdirSync(parts)
  fs.writeFileSync(
    path.join(parts, 'manifest.json'),
    JSON.stringify({
      version: 1,
      size: 1024 ** 2,
      identity: 'scan-fixture',
      partSize: 256 * 1024,
    }),
  )
  fs.writeFileSync(path.join(parts, '0.part'), Buffer.alloc(65536))
  fs.writeFileSync(path.join(parts, '262144.part'), Buffer.alloc(65536))
  const runtime = loadDownloaderRuntime(fs, { targetDir: directory })
  runtime.process.stdout.isTTY = false
  runtime.setResources(async () => [
    {
      dest: 'file.pak',
      url: 'http://unused.invalid/file',
      size: 1024 ** 2,
      md5: 'scan-fixture',
    },
  ])
  const stat = fs.promises.stat
  t.mock.method(fs.promises, 'stat', async function (name, ...args) {
    const result = await stat.call(this, name, ...args)
    if (name === path.join(parts, '262144.part')) runtime.process.emit('SIGINT')
    return result
  })
  await runtime.main()
  assert.equal(runtime.getManager().downloadedBytes, 131072)
  assert.equal(runtime.getManager().transferredBytes, 0)
  assert.match(runtime.logs.join('\n'), /已保留进度.*128\.00 KB/)
  assert.equal(runtime.process.exitCode, 130)
})

test('interrupting legacy-prefix migration reports saved bytes and keeps the original prefix', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ww-migrate-interrupt-'),
  )
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const destination = path.join(directory, 'file.pak')
  const prefix = Buffer.alloc(300 * 1024, 19)
  fs.writeFileSync(destination, prefix)
  const runtime = loadDownloaderRuntime(fs, { targetDir: directory })
  runtime.process.stdout.isTTY = false
  runtime.setResources(async () => [
    {
      dest: 'file.pak',
      url: 'http://unused.invalid/file',
      size: 1024 ** 2,
      md5: 'migrate-fixture',
    },
  ])
  const createWriteStream = fs.createWriteStream
  t.mock.method(fs, 'createWriteStream', function (name, options) {
    const stream = createWriteStream.call(this, name, {
      ...options,
      highWaterMark: 1,
    })
    stream.once('drain', () => runtime.process.emit('SIGINT'))
    return stream
  })
  await runtime.main()
  const retained = fs.statSync(path.join(destination + '.parts', '0.part')).size
  assert.ok(retained > 0 && retained < prefix.length)
  assert.equal(runtime.getManager().downloadedBytes, retained)
  assert.equal(runtime.getManager().transferredBytes, 0)
  assert.equal(runtime.getManager().failed, 0)
  assert.equal(runtime.process.exitCode, 130)
  assert.deepEqual(fs.readFileSync(destination), prefix)
})

for (const cached of [true, false]) {
  test(`interrupting ${cached ? 'existing' : 'downloaded'}-file verification closes the reader and never deletes or retries the target`, async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'ww-verify-interrupt-'),
    )
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
    const content = Buffer.alloc(1024 ** 2, 89)
    const destination = path.join(directory, 'cached.pak')
    if (cached) fs.writeFileSync(destination, content)
    let closed = false
    const runtime = loadDownloaderRuntime(
      {
        ...fs,
        createReadStream(...args) {
          const stream = fs.createReadStream(...args)
          stream.once('data', () => runtime.process.emit('SIGINT'))
          stream.once('close', () => {
            closed = true
          })
          return stream
        },
      },
      { targetDir: directory },
    )
    runtime.process.stdout.isTTY = false
    runtime.setResources(async () => [
      {
        dest: 'cached.pak',
        url: 'http://unused.invalid/file',
        size: content.length,
        md5: crypto.createHash('md5').update(content).digest('hex'),
      },
    ])
    let downloadCalls = 0
    runtime.setDownload(async (_url, dest, onProgress) => {
      downloadCalls++
      assert.equal(cached, false, 'existing target must not be downloaded')
      fs.writeFileSync(dest, content)
      onProgress(content.length, true)
    })
    await runtime.main()
    assert.match(runtime.logs.join('\n'), /下载已中断/)
    assert.equal(closed, true)
    assert.equal(downloadCalls, cached ? 0 : 1)
    assert.equal(runtime.getManager().failed, 0)
    assert.equal(runtime.process.exitCode, 130)
    assert.deepEqual(fs.readFileSync(destination), content)
  })
}

test('interruption during assembly retains complete parts and can finish without more requests', async (t) => {
  const content = Buffer.alloc(1024 ** 2, 97)
  let requests = 0
  const { url, destination } = await createDownloadServer(
    t,
    content,
    (req, res, body) => {
      requests++
      sendDownloadRange(req, res, body)
    },
  )
  const controller = new AbortController()
  const open = fs.promises.open
  t.mock.method(fs.promises, 'open', async function (name, ...args) {
    const handle = await open.call(this, name, ...args)
    if (name === destination + '.assembling')
      controller.abort(new Error('assembly interrupted'))
    return handle
  })
  await assert.rejects(
    new transfer.DownloadScheduler(4).download(url, destination, {
      size: content.length,
      md5: 'assembly-fixture',
      signal: controller.signal,
    }),
    /assembly interrupted|aborted/,
  )
  assert.equal(fs.existsSync(destination), false)
  assert.equal(fs.existsSync(destination + '.parts'), true)
  const requestsBeforeResume = requests
  await new transfer.DownloadScheduler(4).download(url, destination, {
    size: content.length,
    md5: 'assembly-fixture',
  })
  assert.equal(requests, requestsBeforeResume)
  assert.deepEqual(fs.readFileSync(destination), content)
})
