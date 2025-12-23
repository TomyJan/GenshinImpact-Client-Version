import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import https from 'https'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const baseUrl =
  'https://pcdownload-aliyun.aki-game.com//launcher/game/G152/10003/3.0.0/QDYPElFKaZpJXkogwRukzDzAfaEsoupi/'
const resDownloadBaseUrl = `${baseUrl}zip/`
const resListUrl = `${baseUrl}resource.json`
const targetDir = path.join(__dirname, 'ww')

// 并发与连接配置
function parseConcurrencyArg() {
  const argv = process.argv.slice(2)
  let c = undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--concurrency=')) {
      c = parseInt(arg.split('=')[1], 10)
      break
    }
    if (arg === '--concurrency' || arg === '-c') {
      const next = argv[i + 1]
      if (next) c = parseInt(next, 10)
      break
    }
  }
  if (!Number.isFinite(c) || c <= 0) {
    const envC = parseInt(process.env.DOWNLOAD_CONCURRENCY || '', 10)
    if (Number.isFinite(envC) && envC > 0) c = envC
  }
  if (!Number.isFinite(c) || c <= 0) c = 4 // 默认并发
  // 简单上限，避免过高并发导致不稳定
  c = Math.max(1, Math.min(c, 16))
  return c
}

const concurrency = parseConcurrencyArg()
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: concurrency })

// 获取当前时间字符串
function now() {
  return new Date().toTimeString().split(' ')[0]
}

// 格式化速度
function formatSpeed(bytesPerSec) {
  if (bytesPerSec >= 1024 * 1024)
    return (bytesPerSec / 1048576).toFixed(1) + ' MB/s'
  if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
  return bytesPerSec + ' B/s'
}

// 日志输出
function log(index, total, msg) {
  const prefix =
    index !== null ? `[${String(index + 1).padStart(3, '0')}/${total}]` : ''
  console.log(`${now()} ${prefix} ${msg}`)
}

// 下载文件并显示进度
function downloadFileWithProgress(url, dest, index, total, name, expectedSize) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    let downloaded = 0
    let lastLogged = Date.now()
    let lastDownloaded = 0

    const req = https
      .get(url, { agent: httpsAgent }, (res) => {
        if (res.statusCode !== 200) {
          fs.unlink(dest, () => {})
          return reject(new Error(`HTTP ${res.statusCode}`))
        }

        res.on('data', (chunk) => {
          downloaded += chunk.length
          const nowTime = Date.now()
          if (nowTime - lastLogged >= 1000) {
            const speed = formatSpeed(
              (downloaded - lastDownloaded) / ((nowTime - lastLogged) / 1000)
            )
            const totalMB = (expectedSize / 1048576).toFixed(2)
            const downloadedMB = (downloaded / 1048576).toFixed(2)
            log(
              index,
              total,
              `下载 ${name} 进度: ${downloadedMB} MB / ${totalMB} MB (${speed})`
            )
            lastLogged = nowTime
            lastDownloaded = downloaded
          }
        })

        res.pipe(file)
        file.on('finish', () => file.close(resolve))
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {})
        reject(err)
      })

    file.on('error', (err) => {
      try { req.destroy() } catch {}
      fs.unlink(dest, () => {})
      reject(err)
    })
  })
}

// 计算文件 md5 并显示进度（大于 1MB 才显示）
function getFileMD5WithProgress(filePath, index, total, name, fileSize) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fs.createReadStream(filePath)
    let processed = 0
    let lastLogged = Date.now()
    let lastProcessed = 0

    stream.on('data', (chunk) => {
      hash.update(chunk)
      if (fileSize > 1048576) {
        processed += chunk.length
        const nowTime = Date.now()
        if (nowTime - lastLogged >= 1000) {
          const speed = formatSpeed(
            (processed - lastProcessed) / ((nowTime - lastLogged) / 1000)
          )
          const percent = ((processed / fileSize) * 100).toFixed(1)
          log(index, total, `校验 ${name} 进度: ${percent}% (${speed})`)
          lastLogged = nowTime
          lastProcessed = processed
        }
      }
    })

    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// 处理单个文件
async function handleFile(fileObj, index, total) {
  const relativePath = fileObj.dest
  const fullPath = path.join(targetDir, relativePath)
  const url = resDownloadBaseUrl + relativePath
  const name = path.basename(relativePath)

  fs.mkdirSync(path.dirname(fullPath), { recursive: true })

  const checkAndDownload = async (isRetry = false) => {
    if (fs.existsSync(fullPath)) {
      log(index, total, `校验 ${name}`)
      const stats = fs.statSync(fullPath)
      if (stats.size === fileObj.size) {
        const md5 = await getFileMD5WithProgress(
          fullPath,
          index,
          total,
          name,
          stats.size
        )
        if (md5 === fileObj.md5) {
          log(index, total, `校验 ${name} 完成`)
          return true
        }
      }
      log(index, total, `校验 ${name} 文件错误${isRetry ? '' : ', 重试一次'}`)
    }

    log(index, total, `下载 ${name}`)
    try {
      await downloadFileWithProgress(
        url,
        fullPath,
        index,
        total,
        name,
        fileObj.size
      )
      log(index, total, `下载 ${name} 完成`)
    } catch (e) {
      log(index, total, `下载 ${name} 失败: ${e.message}`)
      return false
    }

    log(index, total, `校验 ${name}`)
    try {
      const stats = fs.statSync(fullPath)
      if (stats.size !== fileObj.size) throw new Error('size mismatch')
      const md5 = await getFileMD5WithProgress(
        fullPath,
        index,
        total,
        name,
        stats.size
      )
      if (md5 !== fileObj.md5) throw new Error('md5 mismatch')
      log(index, total, `校验 ${name} 完成`)
      return true
    } catch (e) {
      log(index, total, `校验 ${name} 文件错误${isRetry ? '' : ', 重试一次'}`)
      if (!isRetry) return await checkAndDownload(true)
      return false
    }
  }

  return await checkAndDownload()
}

// 主函数
async function main() {
  log(null, null, `加载资源列表`)
  let data
  try {
    const res = await fetch(resListUrl)
    if (!res.ok){
      log(null, null, `无法加载资源列表：HTTP ${res.status}`)
      return
    }
    let resJson
    try {
      resJson = await res.json()
    } catch (err) {
      log(null, null, `无法解析资源列表 JSON：${err.message} , 响应文本：` + await res.text())
      return
    }
    data = resJson.resource
  } catch (err) {
    console.error(`无法加载资源列表：${err.message}`)
    return
  }

  const total = data.length
  log(null, null, `共 ${total} 个文件任务开始执行`)
  log(null, null, `并发数: ${concurrency}`)

  const taskFns = data.map((item, i) => () => handleFile(item, i, total))
  const { successes, fails } = await runWithConcurrency(taskFns, concurrency)

  log(null, null, `所有任务完成，成功 ${successes}，失败 ${fails}`)
}

main().catch((err) => {
  console.error(`主函数出错: ${err.message}`)
})

// 简单任务池并发执行器
function runWithConcurrency(taskFns, limit) {
  return new Promise((resolve) => {
    let nextIndex = 0
    let running = 0
    let successes = 0
    let fails = 0

    const total = taskFns.length
    if (total === 0) return resolve({ successes: 0, fails: 0 })

    function runNext() {
      while (running < limit && nextIndex < total) {
        const current = nextIndex++
        const task = taskFns[current]
        running++
        Promise.resolve()
          .then(task)
          .then((ok) => {
            if (ok === false) fails++
            else successes++
          })
          .catch(() => {
            fails++
          })
          .finally(() => {
            running--
            if (successes + fails === total) {
              resolve({ successes, fails })
            } else {
              runNext()
            }
          })
      }
    }

    runNext()
  })
}
