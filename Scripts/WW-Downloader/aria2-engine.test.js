import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, mock } from 'node:test'
import https from 'node:https'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

const officialBinary = path.join(
  os.tmpdir(),
  'ww-aria2-evaluation',
  'aria2c.exe',
)

async function isolatedEngine(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ww-engine-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.writeFile(path.join(directory, 'package.json'), '{"type":"module"}')
  const source = fileURLToPath(new URL('./aria2-engine.js', import.meta.url))
  const target = path.join(directory, 'aria2-engine.js')
  await fs.copyFile(source, target)
  return { directory, ...(await import(pathToFileURL(target))) }
}

async function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    t.after(() => {
      if (old === undefined) delete process.env[key]
      else process.env[key] = old
    })
  }
}

test('an invalid explicit executable fails without downloading a fallback', async (t) => {
  await env(t, { ARIA2C_PATH: process.execPath })
  const { ensureAria2, directory } = await isolatedEngine(t)
  await assert.rejects(ensureAria2(), /ARIA2C_PATH|aria2/i)
  assert.equal((await fs.readdir(directory)).includes('.aria2'), false)
})

test('a pre-aborted request never provisions a cache', async (t) => {
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  await assert.rejects(ensureAria2({ signal: AbortSignal.abort() }), {
    name: 'AbortError',
  })
  assert.equal((await fs.readdir(directory)).includes('.aria2'), false)
})

test('a corrupted cached executable is rejected before execution or network', async (t) => {
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  const cache = path.join(directory, '.aria2', '1.37.0')
  await fs.mkdir(cache, { recursive: true })
  await fs.writeFile(path.join(cache, 'aria2c.exe'), 'untrusted')
  await assert.rejects(ensureAria2(), /SHA-?256|checksum|hash/i)
})

test('a trusted explicit aria2 executable is preferred', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows official fixture')
  try {
    await fs.access(officialBinary)
  } catch {
    return t.skip('Optional official fixture absent')
  }
  await env(t, { ARIA2C_PATH: officialBinary, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  assert.equal(await ensureAria2(), officialBinary)
  assert.equal((await fs.readdir(directory)).includes('.aria2'), false)
})

test('a verified local cache works with no PATH install', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows official fixture')
  try {
    await fs.access(officialBinary)
  } catch {
    return t.skip('Optional official fixture absent')
  }
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  const cache = path.join(directory, '.aria2', '1.37.0')
  await fs.mkdir(cache, { recursive: true })
  await fs.copyFile(officialBinary, path.join(cache, 'aria2c.exe'))
  assert.equal(await ensureAria2(), path.join(cache, 'aria2c.exe'))
})

test('a downloaded archive with the wrong hash leaves no extracted cache', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    return t.skip('Windows x64 provisioning')
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  const network = mock.method(https, 'get', (url, options, callback) => {
    const request = new EventEmitter()
    request.setTimeout = () => request
    const response = Readable.from([Buffer.from('not the official archive')])
    response.statusCode = 200
    response.headers = {}
    queueMicrotask(() => callback(response))
    return request
  })
  t.after(() => network.mock.restore())
  await assert.rejects(ensureAria2(), /SHA-?256/i)
  assert.deepEqual(
    await fs.readdir(path.join(directory, '.aria2', '1.37.0')),
    [],
  )
})

test('cancelling provisioning closes its download and removes temporary files', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    return t.skip('Windows x64 provisioning')
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  const controller = new AbortController()
  const network = mock.method(https, 'get', (url, options, callback) => {
    const request = new EventEmitter()
    request.setTimeout = () => request
    options.signal.addEventListener(
      'abort',
      () => {
        request.emit('error', new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
    queueMicrotask(() => controller.abort())
    return request
  })
  t.after(() => network.mock.restore())
  await assert.rejects(ensureAria2({ signal: controller.signal }), {
    name: 'AbortError',
  })
  assert.deepEqual(
    await fs.readdir(path.join(directory, '.aria2', '1.37.0')),
    [],
  )
})

test('PATH discovery uses an existing aria2 installation before the cache', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows official fixture')
  try {
    await fs.access(officialBinary)
  } catch {
    return t.skip('Optional official fixture absent')
  }
  const { ensureAria2, directory } = await isolatedEngine(t)
  const bin = path.join(directory, 'trusted bin')
  await fs.mkdir(bin)
  await fs.copyFile(officialBinary, path.join(bin, 'aria2c.exe'))
  await env(t, { ARIA2C_PATH: undefined, PATH: bin })
  assert.equal(await ensureAria2(), 'aria2c')
  assert.equal((await fs.readdir(directory)).includes('.aria2'), false)
})

test('concurrent provisioning verifies and extracts one official archive atomically', async (t) => {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    return t.skip('Windows x64 provisioning')
  const archive = path.join(os.tmpdir(), 'ww-aria2-official-check.zip')
  let zip
  try {
    zip = await fs.readFile(archive)
  } catch {
    return t.skip('Optional official archive fixture absent')
  }
  await env(t, { ARIA2C_PATH: undefined, PATH: '' })
  const { ensureAria2, directory } = await isolatedEngine(t)
  let downloads = 0
  const network = mock.method(https, 'get', (url, options, callback) => {
    downloads++
    const request = new EventEmitter()
    request.setTimeout = () => request
    const response = Readable.from([zip])
    response.statusCode = 200
    response.headers = {}
    setImmediate(() => callback(response))
    return request
  })
  t.after(() => network.mock.restore())
  const expected = path.join(directory, '.aria2', '1.37.0', 'aria2c.exe')
  assert.deepEqual(await Promise.all([ensureAria2(), ensureAria2()]), [
    expected,
    expected,
  ])
  assert.equal(downloads, 1)
  assert.deepEqual(await fs.readdir(path.dirname(expected)), ['aria2c.exe'])
  assert.equal(await ensureAria2(), expected)
})
