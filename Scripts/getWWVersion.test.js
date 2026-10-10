import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const appUrl =
  'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/app/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/index.json'
const gameUrl =
  'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json'
const cdnList = [{ url: 'https://cdn.example/' }]
const launcher = {
  default: {
    cdnList,
    resource: { version: '3.0.1.0', path: 'launcher.zip', size: 465198503 },
    changelog: { 'zh-Hans': '优化了部分功能' },
  },
}
const pack = (name, version = '3.7.0') => ({
  version,
  indexFile: `${name}/indexFile.json`,
  baseUrl: 'zip/',
})
const game = {
  cdnList,
  resourcePacks: {
    common: pack('common'),
    sd: pack('sd'),
    hd: pack('hd'),
    uhd: pack('uhd'),
  },
  bundles: { HD: { resourcePacks: ['common', 'hd'] } },
  config: {},
  predownload: null,
}

// 执行真实脚本，仅替换文件、网络和推送边界，避免改动版本缓存或发出消息。
async function runScript(name, args, remote, initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles))
  const requests = []
  const pushes = []
  let exitCode = 0
  const source = fs
    .readFileSync(new URL(name, import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replace(/^(getWin\w+Version\(\))$/m, 'await $1')
  const fakeFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error(`Missing file: ${file}`)
      return files.get(file)
    },
    writeFileSync: (file, data) => files.set(file, data),
    existsSync: (file) => files.has(file),
    mkdirSync() {},
  }
  const exit = new Error('exit')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  try {
    await new AsyncFunction(
      'fs',
      'push',
      'fetchWithRetry',
      'process',
      'console',
      source,
    )(
      fakeFs,
      {
        pushWinLauncher: async (...data) => pushes.push(data),
        pushWinGame: async (...data) => pushes.push(data),
      },
      async (url) => {
        requests.push(url)
        assert.ok(Object.hasOwn(remote, url), `Unexpected request: ${url}`)
        if (remote[url] instanceof Error) throw remote[url]
        return { ok: true, json: async () => structuredClone(remote[url]) }
      },
      {
        argv: ['node', name, ...args],
        exit(code) {
          exitCode = code
          throw exit
        },
      },
      { log() {}, error() {} },
    )
  } catch (error) {
    if (error !== exit) throw error
  }
  return { files, requests, pushes, exitCode }
}

const exeApi =
  'https://download.kurogames.com/mc_WnGtDn85y8lJB4mTmYHYuNjIl9n6YGVm/official/cn/zh-Hans/pc_app.json'

test('CN official launcher uses the app index and matching official EXE', async () => {
  const result = await runScript('getWWWinLauncherVersion.js', ['cn'], {
    [appUrl]: launcher,
    [exeApi]: { version: '3.0.1', primary: 'https://example.com/setup.exe' },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.pushes.length, 1)
  const [, server, data, , gray] = result.pushes[0]
  assert.equal(server, 'CN')
  assert.equal(gray, false)
  assert.equal(data.new.version, '3.0.1.0')
  assert.equal(data.new.url, 'https://example.com/setup.exe')
  assert.ok(result.files.has('./Scripts/data/WW/latest_Win_Launcher_CN.json'))
})

test('unchanged official launcher does not push again', async () => {
  const result = await runScript(
    'getWWWinLauncherVersion.js',
    ['cn'],
    { [appUrl]: launcher },
    {
      './Scripts/data/WW/latest_Win_Launcher_CN.json': JSON.stringify(launcher),
    },
  )
  assert.equal(result.pushes.length, 0)
  assert.equal(result.exitCode, 0)
})

test('CN official game archives packs and counts only common + HD resources', async () => {
  const result = await runScript('getWWWinGameVersion.js', ['cn'], {
    [gameUrl]: game,
    'https://cdn.example/common/indexFile.json': {
      resource: [{ dest: 'client.exe', size: 10 }],
    },
    'https://cdn.example/hd/indexFile.json': {
      resource: [{ dest: 'hd.pak', size: 20 }],
    },
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.pushes.length, 1)
  assert.equal(result.pushes[0][1], 'CN')
  assert.equal(result.pushes[0][4], false)
  const data = result.pushes[0][2]
  assert.equal(data.default.version, '3.7.0')
  assert.equal(data.default.resourceLevel, 'HD')
  assert.deepEqual(data.resourcePacks, game.resourcePacks)
  const resources = JSON.parse(
    result.files.get('./Scripts/data/WW/latest_Win_Game_CN_Res.json'),
  )
  assert.deepEqual(
    resources.resource.map((file) => file.dest),
    ['client.exe', 'hd.pak'],
  )
})

test('legacy OS gray responses still unwrap data', async () => {
  for (const name of ['getWWWinLauncherVersion.js', 'getWWWinGameVersion.js']) {
    const source = fs.readFileSync(new URL(name, import.meta.url), 'utf8')
    const url = source.match(/OS_NEW:\s*'([^']+)'/)[1]
    const isLauncher = name.includes('Launcher')
    const data = isLauncher ? launcher : { default: { version: '3.7.0' } }
    const cache = `./Scripts/data/WW/latest_Win_${isLauncher ? 'Launcher' : 'Game'}_OS_NEW.json`
    const result = await runScript(
      name,
      ['os', 'new'],
      { [url]: { data } },
      { [cache]: JSON.stringify(data) },
    )
    assert.equal(result.exitCode, 0)
    assert.equal(result.pushes.length, 0)
  }
})

test('same-version resource migration pushes once and retries failed manifests', async () => {
  const cache = './Scripts/data/WW/latest_Win_Game_CN.json'
  const old = JSON.stringify({ default: { version: '3.7.0' } })
  const remote = {
    [gameUrl]: game,
    'https://cdn.example/common/indexFile.json': { resource: [] },
    'https://cdn.example/hd/indexFile.json': new Error('network unavailable'),
  }
  const failed = await runScript('getWWWinGameVersion.js', ['cn'], remote, {
    [cache]: old,
  })
  assert.notEqual(failed.exitCode, 0)
  assert.equal(failed.files.get(cache), old)
  assert.equal(failed.pushes.length, 0)

  remote['https://cdn.example/hd/indexFile.json'] = { resource: [] }
  const migrated = await runScript('getWWWinGameVersion.js', ['cn'], remote, {
    [cache]: old,
  })
  assert.equal(migrated.pushes.length, 1)
  const unchanged = await runScript(
    'getWWWinGameVersion.js',
    ['cn'],
    remote,
    Object.fromEntries(migrated.files),
  )
  assert.equal(unchanged.pushes.length, 0)
  assert.deepEqual(unchanged.requests, [gameUrl])
})

test('official game message names the HD level and is not labeled gray', async () => {
  const initialFiles = {
    './Scripts/data/WW/latest_Win_Game_CN.json': JSON.stringify({
      default: { version: '3.7.0' },
    }),
    './Scripts/data/WW/latest_Win_Game_CN_Res.json': JSON.stringify({
      resource: [{ dest: 'old.pak', size: 10 }],
    }),
    './Scripts/data/WW/latest_Win_Game_OS.json': '{}',
  }
  const result = await runScript(
    'getWWWinGameVersion.js',
    ['cn'],
    {
      [gameUrl]: game,
      'https://cdn.example/common/indexFile.json': {
        resource: [{ dest: 'client.exe', size: 10 }],
      },
      'https://cdn.example/hd/indexFile.json': {
        resource: [{ dest: 'hd.pak', size: 20 }],
      },
    },
    initialFiles,
  )
  const source = fs
    .readFileSync(new URL('push/push.js', import.meta.url), 'utf8')
    .replace(/^import .+\r?\n/gm, '')
    .replace('export default new Push()', 'return new Push()')
  let message
  const exit = new Error('exit')
  const push = new Function(
    'fs',
    'path',
    'fetchWithRetry',
    'process',
    'console',
    source,
  )(
    {
      readFileSync: (file) => {
        assert.ok(result.files.has(file), `Missing file: ${file}`)
        return result.files.get(file)
      },
      readdirSync: (dir) =>
        [...result.files.keys()]
          .filter((file) => file.startsWith(dir))
          .map((file) => file.slice(dir.length)),
      statSync: () => ({ mtime: 0 }),
    },
    path,
    async (url) => {
      message = new URL(url).searchParams.get('text')
      return { ok: true, json: async () => ({ ok: true }) }
    },
    {
      env: { TGBotToken: 'test', TGMsgID: 'test' },
      exit(code) {
        assert.equal(code, 0)
        throw exit
      },
    },
    { log() {}, error() {} },
  )
  await assert.rejects(push.pushWinGame(...result.pushes[0]), (e) => e === exit)
  assert.match(message, /^鸣潮 Win CN REL 更新/)
  assert.match(message, /资源等级: HD/)
  assert.match(message, /文件数: `1` \\=\\> `2`/)
  assert.doesNotMatch(message, /灰度|undefined|NaN/)
})
