import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as wwResources from '../utils/wwResources.js'

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

function loadDownloaderRuntime(fileSystem = fs) {
  let now = 0
  const output = []
  const source = fs
    .readFileSync(new URL('down.js', import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replaceAll('import.meta.url', 'moduleUrl')
    .replace(/main\(\)\.catch\([\s\S]*$/, '')
  const runtime = new Function(
    'fs',
    'path',
    'https',
    'fileURLToPath',
    'dirname',
    'moduleUrl',
    'process',
    'Date',
    source +
      `\nreturn {
        ProgressManager, runWithConcurrency, handleFile,
        setManager(value) { progressManager = value },
        setHandler(value) { handleFile = value },
        setDownload(value) { downloadFile = value },
        setMD5(value) { getFileMD5 = value },
      }`,
  )(
    fileSystem,
    path,
    https,
    fileURLToPath,
    path.dirname,
    import.meta.url,
    {
      argv: ['node', 'down.js'],
      env: {},
      stdout: { isTTY: true, write: (value) => output.push(value) },
    },
    class extends Date {
      static now() {
        return now
      }
    },
  )
  return { ...runtime, output, setTime: (value) => (now = value) }
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
  await Promise.resolve()
  assert.deepEqual(started, ['large', 'medium', 'small'])
  finish.get('small')()
  await Promise.resolve()
  assert.deepEqual(started, ['large', 'medium', 'small', 'tiny'])
  finish.get('tiny')()
  finish.get('large')()
  await running
  assert.deepEqual(
    data.map((file) => file.dest),
    ['small', 'large', 'tiny', 'medium'],
  )
})
