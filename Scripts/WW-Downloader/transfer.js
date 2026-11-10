import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { ensureAria2 } from './aria2-engine.js'
import { migrateLegacy, readAria2Progress } from './aria2-resume.js'

const MiB = 1024 ** 2
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function normalizeThreadLimit(value = 16) {
  const count = Number(value)
  return Math.max(
    4,
    Math.min(16, Number.isFinite(count) ? Math.trunc(count) : 16),
  )
}

// 每个文件先保留一个名额，再按剩余字节/已分配线程数分配冗余。
export function allocateThreads(files, limit) {
  const allocation = files.map(() => 0)
  let available = normalizeThreadLimit(limit)
  for (let i = 0; i < files.length && available > 0; i++) {
    if (files[i].remaining > 0 && files[i].capacity > 0) {
      allocation[i]++
      available--
    }
  }
  while (available > 0) {
    let selected = -1
    let best = -1
    for (let i = 0; i < files.length; i++) {
      if (files[i].remaining <= 0 || allocation[i] >= files[i].capacity)
        continue
      const weight = files[i].remaining / allocation[i]
      if (weight > best) {
        selected = i
        best = weight
      }
    }
    if (selected === -1) break
    allocation[selected]++
    available--
  }
  return allocation
}

async function discardNative(destination) {
  for (const suffix of [
    '.download',
    '.download.aria2',
    '.download.json',
    '.download.json.tmp',
    '.download.importing',
  ])
    await fs.promises.rm(destination + suffix, { force: true })
}

export async function discardPartialDownload(destination) {
  await discardNative(destination)
  await fs.promises.rm(destination + '.parts', { recursive: true, force: true })
  await fs.promises.rm(destination + '.assembling', { force: true })
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

// 仅管理本次启动的 aria2 子进程；RPC 只监听本机并使用随机凭据。
class Aria2Client {
  async start(executable, limit, signal) {
    const port = await unusedPort()
    signal?.throwIfAborted()
    this.secret = randomBytes(24).toString('hex')
    this.endpoint = `http://127.0.0.1:${port}/jsonrpc`
    this.child = spawn(
      executable,
      [
        '--no-conf=true',
        '--enable-rpc=true',
        '--rpc-listen-all=false',
        `--rpc-listen-port=${port}`,
        `--rpc-secret=${this.secret}`,
        '--quiet=true',
        '--console-log-level=error',
        '--download-result=hide',
        '--file-allocation=none',
        '--disk-cache=0',
        '--auto-save-interval=1',
        '--max-concurrent-downloads=4',
        '--max-overall-download-limit=0',
        `--stop-with-process=${process.pid}`,
        `--max-connection-per-server=${limit}`,
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    this.exited = new Promise((resolve) => {
      this.child.once('error', (error) => {
        this.error = error
        resolve()
      })
      this.child.once('close', (code) => {
        this.error ||= new Error(`aria2 进程已退出（${code}）`)
        resolve()
      })
    })
    try {
      const deadline = Date.now() + 10000
      while (true) {
        signal?.throwIfAborted()
        if (this.error) throw this.error
        try {
          await this.rpc('getVersion')
          return
        } catch (error) {
          if (Date.now() >= deadline)
            throw new Error('aria2 本地 RPC 启动超时', { cause: error })
          await delay(50)
        }
      }
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async rpc(method, ...params) {
    if (this.error) throw this.error
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ww',
        method: `aria2.${method}`,
        params: [`token:${this.secret}`, ...params],
      }),
      signal: AbortSignal.timeout(3000),
    })
    const data = await response.json()
    if (data.error) throw new Error(`aria2 RPC: ${data.error.message}`)
    if (!response.ok) throw new Error(`aria2 RPC HTTP ${response.status}`)
    return data.result
  }

  async close() {
    if (!this.child) return
    if (!this.error) await this.rpc('forceShutdown').catch(() => {})
    const timer = setTimeout(() => this.child.kill(), 5000)
    try {
      await this.exited
    } finally {
      clearTimeout(timer)
    }
  }
}

async function prepareDownload(url, destination, options) {
  const { size, md5, signal, onMigrationProgress, onProgress } = options
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('无效的文件大小')
  if (!['http:', 'https:'].includes(new URL(url).protocol))
    throw new Error('不支持的下载协议')
  if (md5 && !/^[a-f\d]{32}$/i.test(md5)) throw new Error('无效的 MD5')
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  const metadata = { version: 1, identity: md5 || url, size }
  const metadataPath = destination + '.download.json'
  let existing
  try {
    existing = JSON.parse(await fs.promises.readFile(metadataPath, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  if (
    !existing ||
    existing.version !== 1 ||
    existing.identity !== metadata.identity ||
    existing.size !== size
  ) {
    await discardNative(destination)
    await fs.promises.writeFile(metadataPath + '.tmp', JSON.stringify(metadata))
    await fs.promises.rename(metadataPath + '.tmp', metadataPath)
    // 已知是其他版本时禁止导入无身份信息的旧连续前缀。
    if (!existing)
      await migrateLegacy(destination, {
        ...options,
        url,
        onProgress: onMigrationProgress,
      })
  } else if (!existing.legacyRejected) {
    // 上次导入中断，没有发布控制文件时从保留的旧源安全重做。
    await migrateLegacy(destination, {
      ...options,
      url,
      onProgress: onMigrationProgress,
    })
  }
  signal?.throwIfAborted()
  const saved = await readAria2Progress(destination + '.download.aria2')
  if (saved && saved.totalLength !== size)
    throw new Error('续传控制文件大小与清单不匹配')
  if (!saved) {
    const native = await fs.promises
      .stat(destination + '.download')
      .catch((error) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
    // aria2 完成后会删除控制文件。改名前中断的文件必须先校验，不能按 stat
    // 长度认定完成，也不能重新导入旧碎片覆盖它；此恢复分支只做一次完整读取。
    if (native) {
      let verified = false
      if (native.size === size && md5) {
        const hash = createHash('md5')
        let processed = 0
        options.onVerifyProgress?.(0)
        for await (const chunk of fs.createReadStream(
          destination + '.download',
          { signal },
        )) {
          hash.update(chunk)
          processed += chunk.length
          options.onVerifyProgress?.(processed)
        }
        verified = hash.digest('hex') === md5.toLowerCase()
      }
      signal?.throwIfAborted()
      if (verified) {
        await publishDownload({ destination, options })
        onProgress?.(size, false)
        return { verified: true }
      }
      // 无控制文件的稀疏/不完整文件不能从长度推导断点，安全重下。
      await discardNative(destination)
      await fs.promises.writeFile(metadataPath, JSON.stringify(metadata))
    }
  }
  const downloaded = saved?.completedLength || 0
  onProgress?.(downloaded, false)
  return { url, destination, options, size, downloaded, quota: 0 }
}

async function publishDownload({ destination, options }) {
  await fs.promises.rename(destination + '.download', destination)
  await fs.promises.rm(destination + '.download.aria2', { force: true })
  await fs.promises.rm(destination + '.download.json', { force: true })
  await fs.promises.rm(destination + '.download.importing', { force: true })
  // 完整校验通过之后，才能删除旧实现保留的原始数据。
  if (options.md5) {
    await fs.promises.rm(destination + '.parts', {
      recursive: true,
      force: true,
    })
    await fs.promises.rm(destination + '.assembling', { force: true })
  }
}

export class DownloadScheduler {
  constructor(limit = 16) {
    this.limit = normalizeThreadLimit(limit)
    this.jobs = new Set()
    this.revision = 0
  }

  async initialize({ signal, onMessage } = {}) {
    if (this.closing) throw new Error('下载器已关闭')
    this.initializing ||= (async () => {
      const executable = await ensureAria2({ signal, onMessage })
      this.client = new Aria2Client()
      await this.client.start(executable, this.limit, signal)
    })()
    return this.initializing
  }

  async download(url, destination, options = {}) {
    const job = await prepareDownload(url, destination, options)
    if (job.verified) return job
    await this.initialize({
      signal: options.signal,
      onMessage: options.onMessage,
    })
    options.signal?.throwIfAborted()
    if (this.closing) throw new Error('下载器已关闭')
    return new Promise((resolve, reject) => {
      Object.assign(job, { resolve, reject })
      job.abort = () => {
        job.error ||= options.signal.reason || new Error('下载已取消')
        this.schedule(0)
      }
      options.signal?.addEventListener('abort', job.abort, { once: true })
      this.jobs.add(job)
      this.revision++
      if (options.signal?.aborted) job.abort()
      this.schedule(0)
    })
  }

  schedule(ms = 100) {
    if (this.closing || this.timer || this.ticking) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.ticking = this.tick()
        .catch(async (error) => {
          // RPC/子进程失败必须关闭原生写入后才结束任务。
          await this.client.close()
          for (const job of this.jobs) {
            try {
              const saved = await readAria2Progress(
                job.destination + '.download.aria2',
              )
              if (saved) job.options.onProgress?.(saved.completedLength, false)
            } catch {
              // 控制损坏也必须通知所有任务退出，不能在首项遥测异常处停止。
            } finally {
              this.settle(job, error)
            }
          }
        })
        .finally(() => {
          this.ticking = null
          if (this.jobs.size) this.schedule()
        })
    }, ms)
  }

  settle(job, error, value) {
    this.jobs.delete(job)
    this.revision++
    job.options.signal?.removeEventListener('abort', job.abort)
    if (error) job.reject(error)
    else job.resolve(value)
  }

  async status(job) {
    return this.client.rpc('tellStatus', job.gid, [
      'status',
      'completedLength',
      'totalLength',
      'connections',
      'errorCode',
      'errorMessage',
      'verifiedLength',
      'verifyIntegrityPending',
    ])
  }

  report(job, status) {
    job.connections = Number(status.connections) || 0
    // 刚添加的暂停任务还未载入控制文件，RPC 此时返回 0/0，不能冲掉恢复基线。
    if (!Number(status.totalLength) && job.size) return
    const completed = Math.min(job.size, Number(status.completedLength))
    if (Number.isFinite(completed) && completed !== job.downloaded) {
      if (completed === job.size && job.downloaded < job.size) this.revision++
      job.options.onProgress?.(completed, true)
      job.downloaded = completed
    }
    if (
      status.verifiedLength !== undefined ||
      status.verifyIntegrityPending === 'true'
    ) {
      if (!job.verifying) {
        job.verifying = true
        job.options.onVerifyProgress?.(0)
      }
      job.options.onVerifyProgress?.(Number(status.verifiedLength) || 0)
    }
  }

  async pause(jobs) {
    for (const job of jobs)
      await this.client.rpc('forcePause', job.gid).catch(async (error) => {
        if (
          !['paused', 'complete', 'error', 'removed'].includes(
            (await this.status(job)).status,
          )
        )
          throw error
      })
    const deadline = Date.now() + 10000
    while (true) {
      const statuses = await Promise.all(jobs.map((job) => this.status(job)))
      if (
        statuses.every(
          (s) =>
            ['paused', 'complete', 'error', 'removed'].includes(s.status) &&
            !Number(s.connections),
        )
      )
        return
      if (Date.now() > deadline) throw new Error('aria2 暂停连接超时')
      await delay(30)
    }
  }

  async tick() {
    for (const job of this.jobs) {
      try {
        if (!job.gid && !job.error) {
          const md5 = job.options.md5
          job.gid = await this.client.rpc('addUri', [job.url], {
            dir: path.dirname(job.destination),
            out: path.basename(job.destination) + '.download',
            pause: 'true',
            continue: 'true',
            'auto-file-renaming': 'false',
            'allow-overwrite': 'true',
            'check-integrity': 'true',
            ...(md5 ? { checksum: `md5=${md5}` } : {}),
            split: '1',
            'max-connection-per-server': '1',
            'min-split-size': '1M',
            'piece-length': '1M',
            'max-tries': '3',
            'retry-wait': '1',
            timeout: '30',
            'connect-timeout': '15',
            'http-accept-gzip': 'false',
            'always-resume': 'false',
          })
        }
        if (job.error) {
          if (job.gid) {
            await this.pause([job])
            // 暂停期间仍可能收下最后一批数据，先计入网络量，再按已落盘控制校准。
            this.report(job, await this.status(job))
            const saved = await readAria2Progress(
              job.destination + '.download.aria2',
            )
            job.options.onProgress?.(
              saved?.completedLength ?? job.downloaded,
              false,
            )
            await this.client.rpc('forceRemove', job.gid).catch(() => {})
          }
          this.settle(job, job.error)
          continue
        }
        const status = await this.status(job)
        this.report(job, status)
        if (job.error) continue
        if (status.status === 'error' || status.status === 'removed') {
          if (status.errorCode === '32') {
            await discardNative(job.destination)
            // 源碎片仍保留，但校验失败的旧来源不能在重试时再次导入。
            await fs.promises.writeFile(
              job.destination + '.download.json',
              JSON.stringify({
                version: 1,
                identity: job.options.md5 || job.url,
                size: job.size,
                legacyRejected: true,
              }),
            )
            job.downloaded = 0
            job.options.onProgress?.(0, false)
          }
          this.settle(
            job,
            new Error(
              `aria2 下载失败 (${status.errorCode}): ${status.errorCode === '32' ? 'MD5 校验失败' : status.errorMessage}`,
            ),
          )
          await this.client.rpc('removeDownloadResult', job.gid).catch(() => {})
        } else if (status.status === 'complete') {
          const size = (await fs.promises.stat(job.destination + '.download'))
            .size
          if (size !== job.size) throw new Error('下载文件大小与清单不匹配')
          if (job.options.md5) {
            if (!job.verifying) job.options.onVerifyProgress?.(0)
            job.options.onVerifyProgress?.(job.size)
          }
          if (job.error) continue
          await publishDownload(job)
          this.settle(job, null, { verified: !!job.options.md5 })
          await this.client.rpc('removeDownloadResult', job.gid).catch(() => {})
        }
      } catch (error) {
        // stat/rename/清理等文件局部错误不能取消其他文件；先确认本任务已停写。
        if (job.gid) await this.pause([job])
        this.settle(job, error)
        if (job.gid)
          await this.client.rpc('forceRemove', job.gid).catch(() => {})
      }
    }
    // 完整下载后的原生校验不占网络额度，也不能被配额调整暂停而重新扫描。
    const jobs = [...this.jobs].filter(
      (job) =>
        !job.error &&
        !(job.size > 0 && job.downloaded >= job.size && !job.connections),
    )
    if (!jobs.length) return
    if (
      this.plannedRevision === this.revision &&
      Date.now() - this.lastPlan < 5000
    )
      return
    const revision = this.revision
    const allocation = allocateThreads(
      jobs.map((job, i) => ({
        remaining: Math.max(1, job.size - job.downloaded),
        capacity:
          i < 4
            ? Math.max(
                1,
                Math.min(
                  this.limit,
                  Math.floor((job.size - job.downloaded) / MiB),
                ),
              )
            : 0,
      })),
      this.limit,
    )
    if (jobs.some((job, i) => job.quota !== allocation[i])) {
      // 降额先停连接，再修改 split；避免新旧配额交叠突破全局上限。
      const changed = jobs.filter((job, i) => job.quota !== allocation[i])
      await this.pause(changed)
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]
        if (!changed.includes(job)) continue
        const status = await this.status(job)
        if (status.status !== 'paused') continue
        if (job.quota !== allocation[i] && allocation[i])
          await this.client.rpc('changeOption', job.gid, {
            split: String(allocation[i]),
            'max-connection-per-server': String(allocation[i]),
          })
        job.quota = allocation[i]
        if (job.quota && !job.error) await this.client.rpc('unpause', job.gid)
      }
    }
    this.plannedRevision = revision
    this.lastPlan = Date.now()
  }

  async close() {
    if (this.closing) return this.closing
    this.closing = (async () => {
      clearTimeout(this.timer)
      await this.initializing?.catch(() => {})
      await this.ticking
      if (this.client) {
        await this.client.close()
        for (const job of this.jobs) this.settle(job, new Error('下载器已关闭'))
      }
    })()
    return this.closing
  }
}
