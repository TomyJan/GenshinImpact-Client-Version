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
import { readAria2Progress } from './aria2-resume.js'

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
        close() { return downloadScheduler.close() },
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

test('100.0 percent reserves the same columns as lower progress in header and worker rows', () => {
  const { ProgressManager, setTime, output } = loadDownloaderRuntime()
  const progress = new ProgressManager(2, 2, 2000)
  setTime(1000)
  progress.updateDownloaded(0, 1000, true)
  for (const [index, percent] of [99.9, 100].entries()) {
    progress.updateSlot(index, {
      index,
      name: `${index}.pak`,
      phase: 'download',
      percent,
      speed: 1024 ** 2,
      current: 1000,
      total: 1000,
      elapsed: 1,
      eta: 1,
    })
  }
  progress.forceRender()
  const rows = output
    .at(-1)
    .split('\n')
    .filter((line) => line.includes('║') && !line.includes('空闲'))
  const speedColumns = rows.map((row) => {
    const speed = row.match(/(?:1000 B\/s|1\.0 MB\/s)/)
    assert.ok(speed, row)
    return progress.getDisplayWidth(row.slice(0, speed.index))
  })
  assert.equal(new Set(speedColumns).size, 1, rows.join('\n'))
  for (const row of rows) assert.equal(progress.getDisplayWidth(row), 156, row)
  assert.match(rows.at(-1), /100\.0%/)
})

test('downloaded-file verification is visible immediately and renders its final chunk despite throttling', async () => {
  let exists = false
  const runtime = loadDownloaderRuntime({
    mkdirSync() {},
    existsSync: () => exists,
    statSync: () => ({ size: 400 }),
  })
  const progress = new runtime.ProgressManager(1, 1, 400)
  runtime.setManager(progress)
  runtime.setTime(1000)
  progress.forceRender()
  runtime.setDownload(async (_url, _dest, onProgress) => {
    exists = true
    runtime.setTime(1001)
    onProgress(400)
  })
  const verificationFrames = []
  runtime.setMD5(async (_dest, onProgress) => {
    verificationFrames.push(runtime.output.at(-1))
    runtime.setTime(1200)
    onProgress(200)
    verificationFrames.push(runtime.output.at(-1))
    runtime.setTime(1201)
    onProgress(400)
    verificationFrames.push(runtime.output.at(-1))
    return 'verified'
  })
  assert.equal(
    await runtime.handleFile(
      {
        dest: 'scan.pak',
        url: 'https://unused.invalid/file',
        size: 400,
        md5: 'verified',
      },
      0,
      1,
      0,
    ),
    true,
  )
  assert.match(verificationFrames[0], /🔍 .*0\.0%/)
  assert.match(verificationFrames[1], /🔍 .*50\.0%/)
  assert.match(verificationFrames[2], /🔍 .*100\.0%/)
  assert.equal(progress.transferredBytes, 400)
})

test('parallel checksum callbacks keep scan progress visible after download reaches 100 percent', async () => {
  const runtime = loadDownloaderRuntime({
    mkdirSync() {},
    existsSync: () => false,
    statSync: () => ({ size: 400 }),
  })
  const manager = new runtime.ProgressManager(1, 1, 400)
  runtime.setManager(manager)
  const frames = []
  runtime.setMD5(() => {
    throw new Error('duplicate MD5 scan')
  })
  runtime.setDownload(async (_url, _destination, onProgress, options) => {
    onProgress(400)
    for (const [time, verifiedLength] of [
      [1000, '0'],
      [1200, '200'],
      [1201, '400'],
    ]) {
      runtime.setTime(time)
      options.onVerifyProgress(Number(verifiedLength))
      frames.push(runtime.output.at(-1))
    }
    return { verified: true }
  })
  assert.equal(
    await runtime.handleFile(
      {
        dest: 'scan.pak',
        url: 'https://unused.invalid',
        size: 400,
        md5: 'verified',
      },
      0,
      1,
      0,
    ),
    true,
  )
  assert.match(frames[0], /🔍 .*0\.0%/)
  assert.match(frames[1], /🔍 .*50\.0%/)
  assert.match(frames[2], /🔍 .*100\.0%/)
  assert.equal(manager.transferredBytes, 400)
})

test('worker status icons preserve their original spacing before filenames', () => {
  const { ProgressManager, output } = loadDownloaderRuntime()
  const progress = new ProgressManager(1, 1, 10)
  const name = 'status-test.pak'
  for (const [phase, expected] of [
    ['download', '⬇️  '],
    ['migrate', '🧩 '],
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

test('main uses the configured file concurrency instead of a four-file cap', async () => {
  const runtime = loadDownloaderRuntime(fs, { argv: ['-c', '8'] })
  runtime.setResources(async () =>
    Array.from({ length: 8 }, (_, i) => ({ dest: `${i}.pak`, size: 1 })),
  )
  const pending = []
  let peak = 0
  runtime.setHandler(
    () =>
      new Promise((resolve) => {
        pending.push(resolve)
        peak = Math.max(peak, pending.length)
        setImmediate(() => {
          pending.splice(pending.indexOf(resolve), 1)
          resolve()
        })
      }),
  )
  await runtime.main()
  assert.equal(peak, 8)
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

test('the file handler renders native verification without assembly or a second checksum scan', async (t) => {
  const content = Buffer.alloc(1024 ** 2, 31)
  const { url, directory } = await createDownloadServer(
    t,
    content,
    (req, res, body) => sendDownloadRange(req, res, body),
  )
  const runtime = loadDownloaderRuntime(fs, { targetDir: directory })
  const progress = new runtime.ProgressManager(1, 1, content.length)
  t.after(() => runtime.close())
  runtime.setMD5(() => {
    throw new Error('duplicate verification')
  })
  const states = []
  const updateSlot = progress.updateSlot.bind(progress)
  progress.updateSlot = (slot, state, ...args) => {
    states.push({ phase: state.phase, current: state.current })
    updateSlot(slot, state, ...args)
  }
  runtime.setManager(progress)
  assert.equal(
    await runtime.handleFile(
      {
        dest: 'stages.pak',
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
  const phases = states
    .map((state) => state.phase)
    .filter((phase, index, all) => phase !== all[index - 1])
  assert.deepEqual(phases, ['download', 'verify', 'done'])
  assert.doesNotMatch(runtime.output.join(''), /🧩/)
  assert.match(runtime.output.join(''), /🔍/)
  assert.equal(progress.downloadedBytes, content.length)
  assert.equal(progress.transferredBytes, content.length)
  assert.deepEqual(fs.readFileSync(path.join(directory, 'stages.pak')), content)
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
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Number(range[2]) : body.length - 1
      res.writeHead(range ? 206 : 200, {
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
  t.after(() => runtime.close())
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
  { timeout: 15000 },
  async (t) => {
    const content = Buffer.alloc(1024 ** 2, 47)
    const requests = []
    const { url, directory } = await createDownloadServer(
      t,
      content,
      (req, res, body) => {
        requests.push(req.url)
        const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '')
        let offset = range ? Number(range[1]) : 0
        const end = range?.[2] ? Number(range[2]) : body.length - 1
        res.writeHead(range ? 206 : 200, {
          'Content-Length': end - offset + 1,
          ...(range
            ? { 'Content-Range': `bytes ${offset}-${end}/${body.length}` }
            : {}),
        })
        const timer = setInterval(() => {
          const next = Math.min(end + 1, offset + 16384)
          res.write(body.subarray(offset, next))
          offset = next
          if (offset > end) {
            clearInterval(timer)
            res.end()
          }
        }, 20)
        res.on('close', () => clearInterval(timer))
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
      if (args[2] && args[1] > 65536 && !interrupted) {
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
    const controls = fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.download.aria2'))
    const saved = await Promise.all(
      controls.map((name) => readAria2Progress(path.join(directory, name))),
    )
    const retained = saved.reduce(
      (sum, value) => sum + value.completedLength,
      0,
    )
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
