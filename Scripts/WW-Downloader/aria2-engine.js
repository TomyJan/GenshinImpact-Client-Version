import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import https from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const execute = promisify(execFile)
const version = '1.37.0'
const archiveRoot = `aria2-${version}-win-64bit-build1`
const archiveUrl = `https://github.com/aria2/aria2/releases/download/release-${version}/${archiveRoot}.zip`
const archiveHash =
  '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288'
const binaryHash =
  'be2099c214f63a3cb4954b09a0becd6e2e34660b886d4c898d260febfe9d70c2'
const cacheDirectory = fileURLToPath(
  new URL(`./.aria2/${version}/`, import.meta.url),
)
const cachedExecutable = path.join(cacheDirectory, 'aria2c.exe')
let provisioning

async function validateExecutable(executable, signal) {
  signal?.throwIfAborted()
  const { stdout } = await execute(executable, ['--version'], {
    signal,
    timeout: 10000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  if (!/^aria2 version \d+\.\d+/m.test(stdout))
    throw new Error('Executable is not aria2')
  return executable
}

async function verifyHash(filename, expected, signal) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename, { signal }))
    hash.update(chunk)
  if (hash.digest('hex') !== expected)
    throw new Error(`aria2 SHA-256 mismatch: ${filename}`)
}

async function downloadArchive(url, destination, signal, redirects = 0) {
  signal.throwIfAborted()
  if (new URL(url).protocol !== 'https:')
    throw new Error('aria2 provisioning requires HTTPS')
  const response = await new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { signal, headers: { 'User-Agent': 'WW-Downloader' } },
      resolve,
    )
    request.setTimeout(30000, () =>
      request.destroy(new Error('aria2 download timed out')),
    )
    request.on('error', reject)
  })
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy()
    if (redirects >= 5 || !response.headers.location)
      throw new Error('Invalid aria2 download redirect')
    return downloadArchive(
      new URL(response.headers.location, url).href,
      destination,
      signal,
      redirects + 1,
    )
  }
  if (response.statusCode !== 200) {
    response.destroy()
    throw new Error(`aria2 download HTTP ${response.statusCode}`)
  }
  const limit = 32 * 1024 * 1024
  let length = 0
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      length += chunk.length
      callback(
        length > limit ? new Error('aria2 archive exceeds 32 MiB limit') : null,
        chunk,
      )
    },
  })
  await pipeline(
    response,
    limiter,
    createWriteStream(destination, { flags: 'wx' }),
    { signal },
  )
}

async function provision(signal, onMessage) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(
      'Install aria2 and add aria2c to PATH, or set ARIA2C_PATH; automatic provisioning supports Windows x64',
    )
  await fs.mkdir(cacheDirectory, { recursive: true })
  const temporary = await fs.mkdtemp(path.join(cacheDirectory, '.provision-'))
  const archive = path.join(temporary, 'aria2.zip')
  const executable = path.join(temporary, 'aria2c.exe')
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error('aria2 provisioning timed out')),
    120000,
  )
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    onMessage?.(`Downloading official aria2 ${version} to the project cache`)
    await downloadArchive(archiveUrl, archive, controller.signal)
    await verifyHash(archive, archiveHash, controller.signal)
    // tar writes exactly this archive member to stdout; no archive paths are extracted.
    const { stdout } = await execute(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
      ['-xOf', archive, `${archiveRoot}/aria2c.exe`],
      {
        encoding: 'buffer',
        maxBuffer: 16 * 1024 * 1024,
        signal: controller.signal,
        timeout: 30000,
        windowsHide: true,
      },
    )
    await fs.writeFile(executable, stdout, { flag: 'wx' })
    await verifyHash(executable, binaryHash, controller.signal)
    await validateExecutable(executable, controller.signal)
    controller.signal.throwIfAborted()
    await fs.rename(executable, cachedExecutable)
    return cachedExecutable
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

function joinProvisioning(signal, onMessage) {
  signal?.throwIfAborted()
  if (!provisioning) {
    const controller = new AbortController()
    const entry = { controller, users: 0 }
    entry.promise = provision(controller.signal, onMessage).finally(() => {
      if (provisioning === entry) provisioning = undefined
    })
    provisioning = entry
  }
  const entry = provisioning
  entry.users++
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (callback, value) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      entry.users--
      if (!entry.users) entry.controller.abort()
      callback(value)
    }
    const abort = () => {
      const reason = signal.reason || new DOMException('Aborted', 'AbortError')
      // The final subscriber waits for cleanup before observing cancellation.
      if (entry.users === 1) {
        entry.controller.abort(reason)
        entry.promise.then(
          () => finish(reject, reason),
          () => finish(reject, reason),
        )
      } else finish(reject, reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
    entry.promise.then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    )
    if (signal?.aborted) abort()
  })
}

export async function ensureAria2({ signal, onMessage } = {}) {
  signal?.throwIfAborted()
  if (process.env.ARIA2C_PATH) {
    try {
      return await validateExecutable(process.env.ARIA2C_PATH, signal)
    } catch (error) {
      signal?.throwIfAborted()
      throw new Error(`Invalid ARIA2C_PATH: ${error.message}`, { cause: error })
    }
  }
  try {
    return await validateExecutable('aria2c', signal)
  } catch {
    signal?.throwIfAborted()
  }
  try {
    await verifyHash(cachedExecutable, binaryHash, signal)
    return await validateExecutable(cachedExecutable, signal)
  } catch (error) {
    signal?.throwIfAborted()
    if (error.code !== 'ENOENT') throw error
  }
  return joinProvisioning(signal, onMessage)
}
