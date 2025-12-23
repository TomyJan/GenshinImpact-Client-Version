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

// ==================== 配置 ====================
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
  if (!Number.isFinite(c) || c <= 0) c = 4
  c = Math.max(1, Math.min(c, 16))
  return c
}

const concurrency = parseConcurrencyArg()
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: concurrency })

// ==================== 进度管理器 ====================
class ProgressManager {
  constructor(total, concurrency) {
    this.total = total
    this.concurrency = concurrency
    this.completed = 0
    this.succeeded = 0
    this.failed = 0
    this.failedFiles = [] // 收集失败文件
    this.slots = new Array(concurrency).fill(null) // 每个并发线程的状态
    this.startTime = Date.now()
    this.lastRender = 0
    this.renderInterval = 100 // 渲染间隔 ms
    this.isTTY = process.stdout.isTTY
    this.headerLines = 6 // 头部固定行数（空行+边框+标题+分隔+底边框+空行）
  }

  // 格式化时间 (秒 -> mm:ss 或 hh:mm:ss)
  formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '--:--'
    seconds = Math.floor(seconds)
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // 格式化速度
  formatSpeed(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '-- B/s'
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / 1048576).toFixed(1) + ' MB/s'
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
    return Math.floor(bytesPerSec) + ' B/s'
  }

  // 格式化大小
  formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(2) + ' MB'
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return bytes + ' B'
  }

  // 生成进度条
  makeProgressBar(percent, width = 20) {
    const filled = Math.round(width * percent / 100)
    const empty = width - filled
    return '█'.repeat(filled) + '░'.repeat(empty)
  }

  // 计算字符串显示宽度（处理中文、emoji等）
  getDisplayWidth(str) {
    let width = 0
    for (const char of str) {
      const code = char.codePointAt(0)
      // emoji 范围（简化判断）
      if (code >= 0x1F300 && code <= 0x1F9FF) width += 2
      // 中文等宽字符
      else if (code >= 0x4E00 && code <= 0x9FFF) width += 2
      // 全角字符
      else if (code >= 0xFF00 && code <= 0xFFEF) width += 2
      // 特殊符号
      else if (code >= 0x2600 && code <= 0x26FF) width += 2
      // 变体选择器（不占宽度）
      else if (code >= 0xFE00 && code <= 0xFE0F) width += 0
      else width += 1
    }
    return width
  }

  // 按显示宽度填充字符串
  padEndDisplay(str, targetWidth, padChar = ' ') {
    const currentWidth = this.getDisplayWidth(str)
    const padNeeded = targetWidth - currentWidth
    return padNeeded > 0 ? str + padChar.repeat(padNeeded) : str
  }

  padStartDisplay(str, targetWidth, padChar = ' ') {
    const currentWidth = this.getDisplayWidth(str)
    const padNeeded = targetWidth - currentWidth
    return padNeeded > 0 ? padChar.repeat(padNeeded) + str : str
  }

  // 截断文件名（按显示宽度）
  truncateName(name, maxLen = 30) {
    let width = 0
    let result = ''
    for (const char of name) {
      const charWidth = this.getDisplayWidth(char)
      if (width + charWidth > maxLen - 3 && width + charWidth > maxLen) {
        return result + '...'
      }
      if (width + charWidth > maxLen) {
        return result + '...'
      }
      result += char
      width += charWidth
    }
    return this.padEndDisplay(name, maxLen)
  }

  // 获取当前时间字符串
  now() {
    return new Date().toTimeString().split(' ')[0]
  }

  // 更新槽位状态
  updateSlot(slotIndex, state) {
    this.slots[slotIndex] = state
    this.throttledRender()
  }

  // 清除槽位
  clearSlot(slotIndex) {
    this.slots[slotIndex] = null
  }

  // 标记完成
  markComplete(success, failInfo = null) {
    this.completed++
    if (success) {
      this.succeeded++
    } else {
      this.failed++
      if (failInfo) this.failedFiles.push(failInfo)
    }
    this.throttledRender()
  }

  // 节流渲染
  throttledRender() {
    const now = Date.now()
    if (now - this.lastRender >= this.renderInterval) {
      this.render()
      this.lastRender = now
    }
  }

  // 强制渲染
  forceRender() {
    this.render()
    this.lastRender = Date.now()
  }

  // 渲染进度显示
  render() {
    if (!this.isTTY) return // 非 TTY 环境不刷新

    const elapsed = (Date.now() - this.startTime) / 1000
    const overallPercent = this.total > 0 ? (this.completed / this.total * 100) : 0
    const avgTimePerFile = this.completed > 0 ? elapsed / this.completed : 0
    const remaining = this.total - this.completed
    const eta = avgTimePerFile * remaining

    const pad = '    ' // 左边距
    const width = 150 // 固定内容宽度

    // 构建输出
    const lines = []
    
    // 顶部空行和边框
    lines.push('')
    lines.push(pad + '╔' + '═'.repeat(width) + '╗')
    
    // 头部：总体进度
    const completedStr = String(this.completed)
    const totalStr = String(this.total)
    const progressBar = this.makeProgressBar(overallPercent, 30)
    const percentStr = overallPercent.toFixed(1).padStart(5)
    const headerContent = ` 📊 总进度   ${progressBar} ${percentStr}% (${completedStr}/${totalStr})          ✅ ${String(this.succeeded).padStart(4)}  ❌ ${String(this.failed).padStart(3)}                         ⏱️  用时: ${this.formatTime(elapsed).padStart(5)}  预计剩余: ${this.formatTime(eta).padStart(5)} `
    lines.push(pad + '║' + this.padEndDisplay(headerContent, width - 2) + '║')
    lines.push(pad + '╠' + '═'.repeat(width) + '╣')

    // 固定宽度定义
    const W_THREAD = 6      // "线程 1" 等
    const W_INDEX = 12      // "[0001/1000]"
    const W_NAME = 44       // 文件名
    const W_BAR = 15        // 进度条
    const W_PERCENT = 5     // "100.0%"
    const W_SPEED = 12      // "999.9 MB/s"
    const W_SIZE = 24       // "1000.00 MB/1000.00 MB"
    const W_TIME = 14       // "00:00/00:00"

    // 各个并发线程
    for (let i = 0; i < this.concurrency; i++) {
      const slot = this.slots[i]
      const threadLabel = this.padEndDisplay(`线程${String(i + 1).padStart(2)}`, W_THREAD)
      
      if (!slot) {
        const idleContent = ` ${threadLabel} │ ⏸️  空闲等待中...`
        lines.push(pad + '║' + this.padEndDisplay(idleContent, width) + '║')
      } else {
        const { index, name, phase, percent, speed, elapsed: taskElapsed, eta: taskEta, current, total: fileTotal } = slot
        
        // 各字段固定宽度
        const indexStr = `[${String(index + 1).padStart(4, '0')}/${String(this.total).padStart(4, '0')}]`.padEnd(W_INDEX)
        const nameStr = this.truncateName(name, W_NAME)
        const bar = this.makeProgressBar(percent, W_BAR)
        const percentStr = `${percent.toFixed(1)}%`.padStart(W_PERCENT)
        const speedStr = this.formatSpeed(speed).padStart(W_SPEED)
        const currentSize = this.formatSize(current)
        const totalSize = this.formatSize(fileTotal)
        const sizeStr = `${currentSize}/${totalSize}`.padStart(W_SIZE)
        const timeStr = `${this.formatTime(taskElapsed)}/${this.formatTime(taskEta)}`.padEnd(W_TIME)
        
        // 使用 emoji 图标（通过 padEndDisplay 处理宽度）
        let phaseIcon = '⏳'
        if (phase === 'download') phaseIcon = '⬇️'
        else if (phase === 'verify') phaseIcon = '🔍'
        else if (phase === 'done') phaseIcon = '✅'
        else if (phase === 'error') phaseIcon = '❌'
        else if (phase === 'skip') phaseIcon = '⏭️'
        const phaseStr = this.padEndDisplay(phaseIcon, 3)
        
        const lineContent = ` ${threadLabel} │ ${indexStr}${phaseStr}${nameStr} ${bar} ${percentStr} ${speedStr} ${sizeStr} ${timeStr}`
        lines.push(pad + '║' + this.padEndDisplay(lineContent, width) + '║')
      }
    }
    
    // 底部边框
    lines.push(pad + '╚' + '═'.repeat(width) + '╝')
    lines.push('')

    // 移动光标到起始位置并清除后续内容
    const totalLines = this.headerLines + this.concurrency
    process.stdout.write(`\x1b[${totalLines}A`) // 上移
    process.stdout.write('\x1b[0J') // 清除光标后的所有内容
    
    // 输出新内容
    process.stdout.write(lines.join('\n') + '\n')
  }

  // 初始化显示区域
  init() {
    if (!this.isTTY) {
      console.log(`[${this.now()}] 开始下载 ${this.total} 个文件，并发数: ${this.concurrency}`)
      return
    }
    // 预留显示空间
    const totalLines = this.headerLines + this.concurrency
    for (let i = 0; i < totalLines; i++) {
      console.log('')
    }
    this.forceRender()
  }

  // 输出普通日志（在进度区域之外）
  log(msg) {
    if (this.isTTY) {
      // 保存光标，移到进度区域下方输出，再恢复
      const totalLines = this.headerLines + this.concurrency
      process.stdout.write(`\x1b[${totalLines}B`) // 下移到进度区域外
      console.log(`[${this.now()}] ${msg}`)
      process.stdout.write(`\x1b[${totalLines + 1}A`) // 移回原位
      this.forceRender()
    } else {
      console.log(`[${this.now()}] ${msg}`)
    }
  }

  // 完成时的最终输出
  finish() {
    if (this.isTTY) {
      // 移到进度区域下方
      const totalLines = this.headerLines + this.concurrency
      process.stdout.write(`\x1b[${totalLines}B\n`)
    }

    const elapsed = (Date.now() - this.startTime) / 1000
    console.log('')
    console.log('═'.repeat(60))
    console.log(`  下载完成！`)
    console.log(`  总文件: ${this.total} | 成功: ${this.succeeded} | 失败: ${this.failed}`)
    console.log(`  总用时: ${this.formatTime(elapsed)}`)
    console.log('═'.repeat(60))

    // 醒目展示失败文件
    if (this.failedFiles.length > 0) {
      console.log('')
      console.log('\x1b[31m' + '╔' + '═'.repeat(58) + '╗' + '\x1b[0m')
      console.log('\x1b[31m' + '║' + '  ⚠️  以下文件下载失败:'.padEnd(57) + '║' + '\x1b[0m')
      console.log('\x1b[31m' + '╠' + '═'.repeat(58) + '╣' + '\x1b[0m')
      for (const f of this.failedFiles) {
        const line = `  [${f.index + 1}] ${f.name}`.slice(0, 56)
        console.log('\x1b[31m' + '║' + line.padEnd(58) + '║' + '\x1b[0m')
        const reason = `      原因: ${f.reason}`.slice(0, 56)
        console.log('\x1b[31m' + '║' + reason.padEnd(58) + '║' + '\x1b[0m')
      }
      console.log('\x1b[31m' + '╚' + '═'.repeat(58) + '╝' + '\x1b[0m')
      console.log('')
    }
  }
}

// 全局进度管理器
let progressManager = null

// ==================== 下载逻辑 ====================

// 下载文件（带进度回调）
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    let downloaded = 0

    const req = https.get(url, { agent: httpsAgent }, (res) => {
      if (res.statusCode !== 200) {
        fs.unlink(dest, () => {})
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      res.on('data', (chunk) => {
        downloaded += chunk.length
        if (onProgress) onProgress(downloaded)
      })

      res.pipe(file)
      file.on('finish', () => file.close(resolve))
    }).on('error', (err) => {
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

// 计算文件 MD5（带进度回调）
function getFileMD5(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fs.createReadStream(filePath)
    let processed = 0

    stream.on('data', (chunk) => {
      hash.update(chunk)
      processed += chunk.length
      if (onProgress) onProgress(processed)
    })

    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

// 处理单个文件
async function handleFile(fileObj, index, total, slotIndex) {
  const relativePath = fileObj.dest
  const fullPath = path.join(targetDir, relativePath)
  const url = resDownloadBaseUrl + relativePath
  const name = path.basename(relativePath)
  const fileSize = fileObj.size

  fs.mkdirSync(path.dirname(fullPath), { recursive: true })

  // 创建进度更新函数
  const createProgressUpdater = (phase) => {
    const startTime = Date.now()
    let lastUpdate = 0
    return (current) => {
      const now = Date.now()
      if (now - lastUpdate < 100) return // 节流
      lastUpdate = now
      
      const elapsed = (now - startTime) / 1000
      const speed = elapsed > 0 ? current / elapsed : 0
      const percent = fileSize > 0 ? (current / fileSize) * 100 : 0
      const eta = speed > 0 ? (fileSize - current) / speed : 0
      
      progressManager.updateSlot(slotIndex, {
        index, name, phase, percent, speed,
        elapsed, eta, current, total: fileSize
      })
    }
  }

  const checkAndDownload = async (isRetry = false) => {
    // 检查已存在文件
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath)
      if (stats.size === fileSize) {
        // 校验 MD5
        const progressUpdater = createProgressUpdater('verify')
        progressUpdater(0)
        
        try {
          const md5 = await getFileMD5(fullPath, progressUpdater)
          if (md5 === fileObj.md5) {
            progressManager.updateSlot(slotIndex, {
              index, name, phase: 'skip', percent: 100, speed: 0,
              elapsed: 0, eta: 0, current: fileSize, total: fileSize
            })
            return { success: true }
          }
        } catch {}
      }
      // 文件有问题，需要重新下载
      try { fs.unlinkSync(fullPath) } catch {}
    }

    // 下载文件
    const downloadUpdater = createProgressUpdater('download')
    downloadUpdater(0)
    
    try {
      await downloadFile(url, fullPath, downloadUpdater)
    } catch (e) {
      if (!isRetry) {
        return await checkAndDownload(true)
      }
      return { success: false, reason: `下载失败: ${e.message}` }
    }

    // 校验下载的文件
    const verifyUpdater = createProgressUpdater('verify')
    verifyUpdater(0)
    
    try {
      const stats = fs.statSync(fullPath)
      if (stats.size !== fileSize) {
        throw new Error('文件大小不匹配')
      }
      const md5 = await getFileMD5(fullPath, verifyUpdater)
      if (md5 !== fileObj.md5) {
        throw new Error('MD5 校验失败')
      }
      
      progressManager.updateSlot(slotIndex, {
        index, name, phase: 'done', percent: 100, speed: 0,
        elapsed: 0, eta: 0, current: fileSize, total: fileSize
      })
      return { success: true }
    } catch (e) {
      if (!isRetry) {
        try { fs.unlinkSync(fullPath) } catch {}
        return await checkAndDownload(true)
      }
      return { success: false, reason: `校验失败: ${e.message}` }
    }
  }

  const result = await checkAndDownload()
  
  if (result.success) {
    progressManager.markComplete(true)
  } else {
    progressManager.updateSlot(slotIndex, {
      index, name, phase: 'error', percent: 0, speed: 0,
      elapsed: 0, eta: 0, current: 0, total: fileSize
    })
    progressManager.markComplete(false, { index, name, reason: result.reason })
  }
  
  progressManager.clearSlot(slotIndex)
  return result.success
}

// ==================== 并发执行器 ====================
function runWithConcurrency(data, limit) {
  return new Promise((resolve) => {
    let nextIndex = 0
    const total = data.length
    
    if (total === 0) return resolve()

    // 维护可用槽位队列
    const availableSlots = []
    for (let i = 0; i < limit; i++) availableSlots.push(i)

    function runNext() {
      while (availableSlots.length > 0 && nextIndex < total) {
        const currentIndex = nextIndex++
        const slotIndex = availableSlots.shift() // 取出一个可用槽位
        
        handleFile(data[currentIndex], currentIndex, total, slotIndex)
          .finally(() => {
            availableSlots.push(slotIndex) // 归还槽位
            if (progressManager.completed === total) {
              resolve()
            } else {
              runNext()
            }
          })
      }
    }

    runNext()
  })
}

// ==================== 主函数 ====================
async function main() {
  console.log(`[${new Date().toTimeString().split(' ')[0]}] 正在加载资源列表...`)
  
  let data
  try {
    const res = await fetch(resListUrl)
    if (!res.ok) {
      console.error(`无法加载资源列表: HTTP ${res.status}`)
      process.exit(1)
    }
    let resJson
    try {
      resJson = await res.json()
    } catch (err) {
      console.error(`无法解析资源列表 JSON: ${err.message}`)
      process.exit(1)
    }
    data = resJson.resource
  } catch (err) {
    console.error(`无法加载资源列表: ${err.message}`)
    process.exit(1)
  }

  if (!data || data.length === 0) {
    console.log('资源列表为空，无需下载')
    return
  }

  const total = data.length
  console.log(`共 ${total} 个文件，并发数: ${concurrency}`)
  console.log(`目标目录: ${targetDir}`)
  console.log('')

  // 初始化进度管理器
  progressManager = new ProgressManager(total, concurrency)
  progressManager.init()

  // 执行下载
  await runWithConcurrency(data, concurrency)

  // 输出最终结果
  progressManager.finish()

  // 如果有失败，返回非零退出码
  if (progressManager.failed > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`主函数出错: ${err.message}`)
  process.exit(1)
})
