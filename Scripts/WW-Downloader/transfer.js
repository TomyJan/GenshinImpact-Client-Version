import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { pipeline } from 'node:stream/promises'

const MiB = 1024 ** 2

export function normalizeThreadLimit(value = 16) {
  const count = Number(value)
  return Math.max(
    4,
    Math.min(16, Number.isFinite(count) ? Math.trunc(count) : 16),
  )
}

// 每个文件先保留一个名额，再按剩余字节/已分配线程数分配冗余。
// capacity 同时限制可用分片数；不支持 Range 的文件最多占用一个线程。
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

export async function discardPartialDownload(destination) {
  await fs.promises.rm(destination + '.parts', { recursive: true, force: true })
  await fs.promises.rm(destination + '.assembling', { force: true })
}

async function saveManifest(job) {
  const manifestPath = path.join(job.directory, 'manifest.json')
  await fs.promises.writeFile(
    manifestPath + '.tmp',
    JSON.stringify(job.manifest),
  )
  await fs.promises.rename(manifestPath + '.tmp', manifestPath)
}

async function prepareDownload(url, destination, options, limit) {
  const { size, md5 } = options
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('无效的文件大小')
  const directory = destination + '.parts'
  const identity = md5 || url
  let manifest
  try {
    manifest = JSON.parse(
      await fs.promises.readFile(path.join(directory, 'manifest.json'), 'utf8'),
    )
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  const reusable =
    manifest?.version === 1 &&
    manifest.size === size &&
    manifest.identity === identity &&
    Number.isSafeInteger(manifest.partSize) &&
    manifest.partSize > 0
  const job = {
    url,
    destination,
    directory,
    size,
    onProgress: options.onProgress,
    signal: options.signal,
    controller: new AbortController(),
    active: 0,
    downloaded: 0,
    rangeSupported: false,
    parts: [],
    manifest: reusable
      ? manifest
      : {
          version: 1,
          identity,
          size,
          // 小文件不做过细分片；大文件提供足够分片以回收空闲线程。
          partSize: Math.max(
            256 * 1024,
            Math.min(8 * MiB, Math.ceil(size / (limit * 2))),
          ),
        },
  }
  if (!reusable) {
    await discardPartialDownload(destination)
    await fs.promises.mkdir(directory, { recursive: true })
    await saveManifest(job)
  }

  for (let start = 0; start < size; start += job.manifest.partSize) {
    const end = Math.min(size, start + job.manifest.partSize) - 1
    const part = {
      start,
      end,
      path: path.join(directory, `${start}.part`),
      active: false,
      downloaded: 0,
    }
    try {
      const stats = await fs.promises.stat(part.path)
      if (stats.size <= end - start + 1) part.downloaded = stats.size
      else await fs.promises.truncate(part.path, 0)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    job.parts.push(part)
  }

  // 兼容旧脚本直接写入目标文件留下的连续前缀，迁移完才删除原文件。
  if (!reusable) {
    let existingSize = 0
    try {
      existingSize = (await fs.promises.stat(destination)).size
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (existingSize > 0 && existingSize < size) {
      for (const part of job.parts) {
        if (part.start >= existingSize) break
        const end = Math.min(part.end, existingSize - 1)
        await pipeline(
          fs.createReadStream(destination, { start: part.start, end }),
          fs.createWriteStream(part.path),
        )
        part.downloaded = end - part.start + 1
      }
      await fs.promises.unlink(destination)
    }
  }
  job.downloaded = job.parts.reduce((sum, part) => sum + part.downloaded, 0)
  job.onProgress?.(job.downloaded, false)
  return job
}

export class DownloadScheduler {
  constructor(limit = 16) {
    this.limit = normalizeThreadLimit(limit)
    this.active = 0
    this.jobs = new Set()
    this.scheduled = false
    this.agents = {
      'http:': new http.Agent({ keepAlive: true, maxSockets: this.limit }),
      'https:': new https.Agent({ keepAlive: true, maxSockets: this.limit }),
    }
  }

  async download(url, destination, options) {
    const job = await prepareDownload(url, destination, options, this.limit)
    return new Promise((resolve, reject) => {
      job.resolve = resolve
      job.reject = reject
      job.abort = () =>
        this.fail(job, job.signal.reason || new Error('下载已取消'))
      this.jobs.add(job)
      job.signal?.addEventListener('abort', job.abort, { once: true })
      if (job.signal?.aborted) job.abort()
      this.schedule()
    })
  }

  fail(job, error) {
    job.error ||= error
    job.controller.abort()
    this.schedule()
  }

  schedule() {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
  }

  pump() {
    for (const job of this.jobs) {
      if (job.active !== 0) continue
      if (job.error || job.downloaded === job.size) {
        this.jobs.delete(job)
        job.signal?.removeEventListener('abort', job.abort)
        if (job.error) job.reject(job.error)
        else this.assemble(job).then(job.resolve, job.reject)
      }
    }
    const jobs = [...this.jobs].filter((job) => !job.error)
    const allocation = allocateThreads(
      jobs.map((job) => ({
        remaining: job.size - job.downloaded,
        // 首个响应确认支持 Range 后才能并发，避免多路写入 HTTP 200 全量响应。
        capacity: job.rangeSupported
          ? job.parts.filter((part) => part.downloaded <= part.end - part.start)
              .length
          : 1,
      })),
      this.limit,
    )
    while (this.active < this.limit) {
      let selected = -1
      let weight = -1
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]
        if (job.active >= allocation[i]) continue
        if (
          !job.parts.some(
            (part) => !part.active && part.downloaded <= part.end - part.start,
          )
        )
          continue
        const score = (job.size - job.downloaded) / (job.active + 1)
        if (score > weight) {
          selected = i
          weight = score
        }
      }
      if (selected === -1) break
      const job = jobs[selected]
      const part = job.parts.find(
        (part) => !part.active && part.downloaded <= part.end - part.start,
      )
      part.active = true
      job.active++
      this.active++
      this.transfer(job, part)
        .catch((error) => this.fail(job, error))
        .finally(() => {
          part.active = false
          job.active--
          this.active--
          this.schedule()
        })
    }
  }

  async request(url, job, start, end, redirects = 0) {
    const target = new URL(url)
    const transport = target.protocol === 'https:' ? https : http
    if (!['http:', 'https:'].includes(target.protocol))
      throw new Error('不支持的下载协议')
    const response = await new Promise((resolve, reject) => {
      const request = transport.get(
        target,
        {
          agent: this.agents[target.protocol],
          headers: {
            Range: `bytes=${start}-${end}`,
            'Accept-Encoding': 'identity',
          },
          signal: job.controller.signal,
        },
        resolve,
      )
      request.setTimeout(30000, () =>
        request.destroy(new Error('下载请求超时')),
      )
      request.on('error', reject)
    })
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy()
      if (redirects >= 5 || !response.headers.location)
        throw new Error('下载重定向无效')
      return this.request(
        new URL(response.headers.location, target).href,
        job,
        start,
        end,
        redirects + 1,
      )
    }
    return response
  }

  async transfer(job, part) {
    const start = part.start + part.downloaded
    const response = await this.request(job.url, job, start, part.end)
    let output
    try {
      if (
        response.headers['content-encoding'] &&
        response.headers['content-encoding'] !== 'identity'
      )
        throw new Error('分片响应使用了内容压缩')
      if (response.statusCode === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
          response.headers['content-range'] || '',
        )
        if (
          !range ||
          Number(range[1]) !== start ||
          Number(range[2]) !== part.end ||
          Number(range[3]) !== job.size
        )
          throw new Error('Content-Range 与请求范围不匹配')
        job.rangeSupported = true
        this.schedule()
      } else if (
        response.statusCode === 200 &&
        !job.rangeSupported &&
        job.active === 1
      ) {
        // 服务器忽略 Range：清空续传偏移，当前响应按完整文件写入，绝不拼接重复内容。
        job.downloaded = 0
        part.start = 0
        part.end = job.size - 1
        part.downloaded = 0
        part.path = path.join(job.directory, '0.part')
        job.parts = job.size ? [part] : []
        job.manifest.partSize = Math.max(1, job.size)
        await saveManifest(job)
        job.onProgress?.(0, false)
        await fs.promises.writeFile(part.path, '')
      } else {
        throw new Error(`HTTP ${response.statusCode}`)
      }
      const expected = part.end - part.start + 1 - part.downloaded
      if (
        response.headers['content-length'] !== undefined &&
        Number(response.headers['content-length']) !== expected
      )
        throw new Error('分片 Content-Length 不匹配')
      output = await fs.promises.open(part.path, 'a')
      for await (const chunk of response) {
        if (part.downloaded + chunk.length > part.end - part.start + 1)
          throw new Error('分片响应超过请求范围')
        let offset = 0
        while (offset < chunk.length) {
          const { bytesWritten } = await output.write(
            chunk,
            offset,
            chunk.length - offset,
          )
          if (bytesWritten === 0) throw new Error('无法写入下载分片')
          offset += bytesWritten
          part.downloaded += bytesWritten
          job.downloaded += bytesWritten
          job.onProgress?.(job.downloaded, true)
        }
      }
      if (part.downloaded !== part.end - part.start + 1)
        throw new Error('分片响应提前结束')
    } finally {
      response.destroy()
      await output?.close()
    }
  }

  async assemble(job) {
    const temporary = job.destination + '.assembling'
    const output = await fs.promises.open(temporary, 'w')
    try {
      for (const part of job.parts) {
        for await (const chunk of fs.createReadStream(part.path)) {
          await output.writeFile(chunk)
        }
      }
    } finally {
      await output.close()
    }
    await fs.promises.rename(temporary, job.destination)
    await fs.promises.rm(job.directory, { recursive: true, force: true })
  }
}
