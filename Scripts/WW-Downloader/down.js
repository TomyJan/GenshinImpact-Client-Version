import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import https from 'https'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const jsonFile = 'Scripts/WW-Downloader/filelist.json'
const baseUrl =
  'https://pcdownload-aliyun.aki-game.com//launcher/game/G152/10003/3.0.0/QDYPElFKaZpJXkogwRukzDzAfaEsoupi/zip/'
// const baseUrl =
//   'https://pcdownload-huoshan.aki-game.com//launcher/game/G152/10003/2.6.0/PvvUtPgrOKbiVwNKSABGishwOHYgFPUf/zip/'
// const baseUrl =
//   'https://pcdownload-qcloud.aki-game.com//launcher/game/G152/10003/2.6.0/PvvUtPgrOKbiVwNKSABGishwOHYgFPUf/zip/'
const targetDir = path.join(__dirname, 'ww')

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

    https
      .get(url, (res) => {
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
  const url = baseUrl + relativePath
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

  await checkAndDownload()
}

// 主函数
async function main() {
  log(null, null, `加载文件列表 ${jsonFile}`)
  let data
  try {
    data = JSON.parse(fs.readFileSync(jsonFile, 'utf8')).resource
  } catch (err) {
    console.error(`无法读取 ${jsonFile}：${err.message}`)
    return
  }

  const total = data.length
  log(null, null, `共 ${total} 个文件任务开始执行`)

  for (let i = 0; i < total; i++) {
    await handleFile(data[i], i, total)
  }

  log(null, null, `所有任务完成`)
}

main().catch((err) => {
  console.error(`主函数出错: ${err.message}`)
})
