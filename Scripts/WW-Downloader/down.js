import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { getWWResourcePacks, resourceLevelNames } from '../utils/wwResources.js'
import { DownloadScheduler, discardPartialDownload } from './transfer.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 国服正式资源入口：自动获取当前版本及其分包清单，无需手动修改版本路径。
const gameIndexUrl =
  'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json'
// 下载版本：default = 当前正式版（默认），pre = 预下载版本。
// pre 未开放时会报错退出；预下载下载的是所选画质的完整包体，不是增量补丁。
const versionType = 'pre'
// 下载资源等级：UHD = 极致（最高，默认），HD = 高清，SD = 流畅。
// 只需修改此变量；每个等级都会自动包含 common 公共包，不下载其他等级的包。
// 在同一目录切换版本或等级会保留原有文件；如需纯净包体，请使用空目录。
const resourceLevel = 'UHD'
const targetDir = path.join(__dirname, 'ww')

// ==================== 配置 ====================
// -c/--concurrency 或 DOWNLOAD_CONCURRENCY 设置所有文件合计的下载线程上限。
// 默认 16，限制为 4–16；文件处理并发使用同一上限，校验不占下载连接。
// 少量尾片或服务器不支持 Range 时，实际连接数可能低于 4。
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
  if (!Number.isFinite(c) || c <= 0) c = 16
  c = Math.max(4, Math.min(c, 16))
  return c
}

const concurrency = parseConcurrencyArg()
const downloadScheduler = new DownloadScheduler(concurrency)
const downloadController = new AbortController()

// ==================== 进度管理器 ====================
class ProgressManager {
  constructor(total, concurrency, totalBytes) {
    this.total = total
    this.totalBytes = totalBytes
    this.downloadedBytes = 0
    this.fileBytes = new Map()
    this.transferredBytes = 0
    this.concurrency = concurrency
    this.completed = 0
    this.succeeded = 0
    this.failed = 0
    this.failedFiles = [] // 收集失败文件
    this.completedFiles = new Map() // 去重记录校验通过的大小与已存在文件。
    this.slots = new Array(concurrency).fill(null) // 每个并发线程的状态
    this.startTime = Date.now()
    this.speedSamples = [{ time: this.startTime, bytes: 0 }]
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
    if (h > 0)
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  // 格式化速度
  formatSpeed(bytesPerSec) {
    if (!isFinite(bytesPerSec) || bytesPerSec <= 0) return '-- B/s'
    if (bytesPerSec >= 1024 * 1024)
      return (bytesPerSec / 1048576).toFixed(1) + ' MB/s'
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s'
    return Math.floor(bytesPerSec) + ' B/s'
  }

  // 格式化大小
  formatSize(bytes) {
    if (bytes >= 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
    if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(2) + ' MB'
    if (bytes >= 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return bytes + ' B'
  }

  // 生成进度条
  makeProgressBar(percent, width = 20) {
    const filled = Math.round((width * percent) / 100)
    const empty = width - filled
    return '█'.repeat(filled) + '░'.repeat(empty)
  }

  // 计算字符串显示宽度（处理中文、emoji等）
  getDisplayWidth(str) {
    let width = 0
    for (const char of str) {
      const code = char.codePointAt(0)
      // emoji 范围（简化判断）
      if (code >= 0x1f300 && code <= 0x1f9ff) width += 2
      // 中文等宽字符
      else if (code >= 0x4e00 && code <= 0x9fff) width += 2
      // 全角字符
      else if (code >= 0xff00 && code <= 0xffef) width += 2
      // 特殊符号
      else if (code >= 0x2600 && code <= 0x26ff) width += 2
      // 变体选择器（不占宽度）
      else if (code >= 0xfe00 && code <= 0xfe0f) width += 0
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
  updateSlot(slotIndex, state, force = false) {
    if (state.phase === 'done' || state.phase === 'skip') {
      this.updateDownloaded(state.index, state.total)
      this.completedFiles.set(state.index, {
        size: state.total,
        skipped: state.phase === 'skip',
      })
    } else if (state.phase === 'error') {
      this.updateDownloaded(state.index, state.current || 0)
      this.completedFiles.delete(state.index)
    }
    this.slots[slotIndex] = state
    if (force) this.forceRender()
    else this.throttledRender()
  }

  // 按文件记录有效下载量；重试会回退该文件进度，校验和跳过不计入网速。
  updateDownloaded(index, current, fromNetwork = false) {
    const previous = this.fileBytes.get(index) || 0
    this.fileBytes.set(index, current)
    this.downloadedBytes += current - previous
    if (fromNetwork) this.transferredBytes += Math.max(0, current - previous)
  }

  getOverallProgress() {
    const now = Date.now()
    this.speedSamples.push({ time: now, bytes: this.transferredBytes })
    // 保留最近一秒的采样及窗口前一个采样，汇总所有线程的实际传输速度。
    while (
      this.speedSamples.length > 2 &&
      this.speedSamples[1].time <= now - 1000
    ) {
      this.speedSamples.shift()
    }
    const first = this.speedSamples[0]
    const speed =
      now > first.time
        ? ((this.transferredBytes - first.bytes) * 1000) / (now - first.time)
        : 0
    const remaining = Math.max(0, this.totalBytes - this.downloadedBytes)
    return {
      percent:
        this.totalBytes > 0
          ? Math.min(100, (this.downloadedBytes / this.totalBytes) * 100)
          : this.completed === this.total
            ? 100
            : 0,
      speed,
      eta: remaining === 0 ? 0 : speed > 0 ? remaining / speed : Infinity,
    }
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
    const { percent: overallPercent, speed, eta } = this.getOverallProgress()

    const pad = '    ' // 左边距
    const width = 150 // 固定内容宽度

    // 构建输出
    const lines = []

    // 总进度与线程行共用列宽，字段长度变化时仍保持纵向对齐。
    const W_THREAD = 6
    const W_INDEX = 12
    const W_NAME = 44
    const W_BAR = 15
    const W_PERCENT = 6 // 为 100.0% 预留完整宽度，避免后续列右移。
    const W_SPEED = 12
    const W_SIZE = 24
    const W_TIME = 14

    // 顶部空行和边框
    lines.push('')
    lines.push(pad + '╔' + '═'.repeat(width) + '╗')

    // 头部：总体进度
    const labelStr = this.padEndDisplay('总进度', W_THREAD)
    const countStr =
      `[${String(this.completed).padStart(4, '0')}/${String(this.total).padStart(4, '0')}]`.padEnd(
        W_INDEX,
      )
    const summaryStr = this.padEndDisplay(
      `成功: ${this.succeeded}  失败: ${this.failed}`,
      W_NAME,
    )
    const progressBar = this.makeProgressBar(overallPercent, W_BAR)
    const percentStr = `${overallPercent.toFixed(1)}%`.padStart(W_PERCENT)
    const speedStr = this.formatSpeed(speed).padStart(W_SPEED)
    const sizeStr =
      `${this.formatSize(this.downloadedBytes)}/${this.formatSize(this.totalBytes)}`.padStart(
        W_SIZE,
      )
    const timeStr =
      `${this.formatTime(elapsed)}/${this.formatTime(eta)}`.padEnd(W_TIME)
    const headerContent = ` ${labelStr} │ ${countStr}${this.padEndDisplay('📊', 3)}${summaryStr} ${progressBar} ${percentStr} ${speedStr} ${sizeStr} ${timeStr}`
    lines.push(pad + '║' + this.padEndDisplay(headerContent, width) + '║')
    lines.push(pad + '╠' + '═'.repeat(width) + '╣')

    // 各个并发线程
    for (let i = 0; i < this.concurrency; i++) {
      const slot = this.slots[i]
      const threadLabel = this.padEndDisplay(
        `线程${String(i + 1).padStart(2)}`,
        W_THREAD,
      )

      if (!slot) {
        const idleContent = ` ${threadLabel} │ ⏸️  空闲等待中...`
        lines.push(pad + '║' + this.padEndDisplay(idleContent, width) + '║')
      } else {
        const {
          index,
          name,
          phase,
          percent,
          speed,
          elapsed: taskElapsed,
          eta: taskEta,
          current,
          total: fileTotal,
        } = slot

        // 各字段固定宽度
        const indexStr = `[${String(index + 1).padStart(4, '0')}/${String(
          this.total,
        ).padStart(4, '0')}]`.padEnd(W_INDEX)
        const nameStr = this.truncateName(name, W_NAME)
        const bar = this.makeProgressBar(percent, W_BAR)
        const percentStr = `${percent.toFixed(1)}%`.padStart(W_PERCENT)
        const speedStr = this.formatSpeed(speed).padStart(W_SPEED)
        const currentSize = this.formatSize(current)
        const totalSize = this.formatSize(fileTotal)
        const sizeStr = `${currentSize}/${totalSize}`.padStart(W_SIZE)
        const timeStr = `${this.formatTime(taskElapsed)}/${this.formatTime(
          taskEta,
        )}`.padEnd(W_TIME)

        // 使用 emoji 图标（通过 padEndDisplay 处理宽度）
        let phaseIcon = '⏳'
        if (phase === 'download') phaseIcon = '⬇️'
        else if (phase === 'migrate') phaseIcon = '🧩'
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
      console.log(
        `[${this.now()}] 开始下载 ${this.total} 个文件，并发数: ${
          this.concurrency
        }`,
      )
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
  finish({ interrupted = null } = {}) {
    if (this.isTTY) {
      // 移到进度区域下方
      const totalLines = this.headerLines + this.concurrency
      process.stdout.write(`\x1b[${totalLines}B\n`)
    }

    const elapsed = (Date.now() - this.startTime) / 1000
    const completedFiles = [...this.completedFiles.values()]
    const skipped = completedFiles.filter((file) => file.skipped).length
    const verifiedBytes = completedFiles.reduce(
      (sum, file) => sum + file.size,
      0,
    )
    const verifiedPercent =
      this.totalBytes > 0
        ? (verifiedBytes / this.totalBytes) * 100
        : this.succeeded === this.total
          ? 100
          : 0
    const averageSpeed =
      this.transferredBytes === 0
        ? '0 B/s'
        : this.formatSpeed(elapsed > 0 ? this.transferredBytes / elapsed : 0)
    const title = interrupted
      ? `下载已中断（${interrupted}）`
      : this.failed === 0
        ? '下载完成'
        : this.succeeded === 0
          ? '下载失败'
          : '下载结束（部分失败）'
    const printStat = (label, value) =>
      console.log(`  ${this.padEndDisplay(label + ':', 12)}${value}`)
    console.log('')
    console.log('═'.repeat(60))
    console.log(`  ${title}`)
    printStat(
      '文件统计',
      `总计 ${this.total} | 下载成功 ${this.succeeded - skipped} | 校验跳过 ${skipped} | 失败 ${this.failed}` +
        (interrupted ? ` | 未完成 ${this.total - this.completed}` : ''),
    )
    printStat(
      '校验完成',
      `${this.formatSize(verifiedBytes)} / ${this.formatSize(this.totalBytes)} (${verifiedPercent.toFixed(1)}%)`,
    )
    if (interrupted) {
      printStat(
        '已保留进度',
        `${this.formatSize(this.downloadedBytes)} / ${this.formatSize(this.totalBytes)}（含已完成文件和已识别的续传数据，未全部校验）`,
      )
    }
    printStat(
      '本次传输',
      `${this.formatSize(this.transferredBytes)}（含重试流量，不含校验读取）`,
    )
    printStat('平均速度', `${averageSpeed}（按总耗时计算）`)
    printStat('总用时', this.formatTime(elapsed))
    printStat('下载线程', `上限 ${concurrency}，文件并发 ${this.concurrency}`)
    printStat('保存目录', targetDir)
    console.log('═'.repeat(60))
    if (interrupted) {
      console.log(
        '  断点数据已保留，重新运行会校验已有文件并续传；未完成的校验会重新开始。',
      )
    }

    // 醒目展示失败文件
    if (this.failedFiles.length > 0) {
      console.log('')
      const red = this.isTTY ? '\x1b[31m' : ''
      const reset = this.isTTY ? '\x1b[0m' : ''
      console.log(`${red}  失败文件:${reset}`)
      for (const f of this.failedFiles) {
        console.log(`  [${f.index + 1}] ${f.path || f.name}`)
        console.log(`      原因: ${f.reason}`)
      }
      console.log('  重新运行会校验已有文件，并继续可用的断点数据。')
      console.log('')
    }
  }
}

// 全局进度管理器
let progressManager = null

// ==================== 下载逻辑 ====================

// aria2 直接写入单个临时文件，调度器统一管理所有文件的连接预算。
function downloadFile(url, dest, onProgress, fileObj) {
  return downloadScheduler.download(url, dest, {
    ...fileObj,
    onProgress,
    onMessage: (message) => progressManager?.log(message),
    signal: downloadController.signal,
  })
}

// 计算文件 MD5（带进度回调）
function getFileMD5(filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const stream = fs.createReadStream(filePath, {
      signal: downloadController.signal,
      highWaterMark: 1024 ** 2,
    })
    let processed = 0
    let digest
    let readError

    stream.on('data', (chunk) => {
      hash.update(chunk)
      processed += chunk.length
      if (onProgress) onProgress(processed)
    })

    stream.on('end', () => {
      digest = hash.digest('hex')
    })
    stream.on('error', (error) => {
      readError = error
    })
    // 等待文件描述符关闭后才结束任务，确保中断统计之后没有后台读写。
    stream.on('close', () => {
      if (readError) reject(readError)
      else if (digest !== undefined) resolve(digest)
      else reject(new Error('校验读取提前结束'))
    })
  })
}

// 处理单个文件
async function handleFile(fileObj, index, total, slotIndex) {
  const signal = downloadController.signal
  signal.throwIfAborted()
  const relativePath = fileObj.dest
  const fullPath = path.join(targetDir, relativePath)
  const url = fileObj.url
  const name = path.basename(relativePath)
  const fileSize = fileObj.size

  fs.mkdirSync(path.dirname(fullPath), { recursive: true })

  // 创建进度更新函数
  const createProgressUpdater = (phase) => {
    const startTime = Date.now()
    let lastUpdate = null
    let resumedBytes = 0
    return (current, fromNetwork = true) => {
      // 每个数据块都计入总进度，避免渲染节流遗漏文件尾部的数据。
      if (phase === 'download' || phase === 'migrate') {
        progressManager.updateDownloaded(index, current, fromNetwork)
        if (!fromNetwork) resumedBytes = current
      }
      const now = Date.now()
      const force = lastUpdate === null || current === fileSize
      // 阶段起点和终点必须立即显示，不能被刚结束的阶段刷新吞掉。
      if (!force && now - lastUpdate < 100) return // 节流
      lastUpdate = now

      const elapsed = (now - startTime) / 1000
      const speed = elapsed > 0 ? (current - resumedBytes) / elapsed : 0
      const percent = fileSize > 0 ? (current / fileSize) * 100 : 0
      const eta = speed > 0 ? (fileSize - current) / speed : 0

      progressManager.updateSlot(
        slotIndex,
        {
          index,
          name,
          phase,
          percent,
          speed,
          elapsed,
          eta,
          current,
          total: fileSize,
        },
        force,
      )
    }
  }

  const checkAndDownload = async (isRetry = false) => {
    signal.throwIfAborted()
    // 检查已存在文件
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath)
      if (stats.size === fileSize) {
        // 校验 MD5
        const progressUpdater = createProgressUpdater('verify')
        progressUpdater(0)

        try {
          const md5 = await getFileMD5(fullPath, progressUpdater)
          signal.throwIfAborted()
          if (md5 === fileObj.md5) {
            progressManager.updateSlot(slotIndex, {
              index,
              name,
              phase: 'skip',
              percent: 100,
              speed: 0,
              elapsed: 0,
              eta: 0,
              current: fileSize,
              total: fileSize,
            })
            return { success: true }
          }
        } catch {
          signal.throwIfAborted()
        }
      }
      // 不完整的旧文件保留连续前缀；完整但校验失败的文件必须重新下载。
      if (stats.size >= fileSize) {
        signal.throwIfAborted()
        fs.unlinkSync(fullPath)
        await discardPartialDownload(fullPath)
      }
    }

    // 下载文件
    const downloadUpdater = createProgressUpdater('download')
    downloadUpdater(0, false)

    let migrationUpdater = null
    let nativeVerifyUpdater = null
    let downloadResult
    try {
      downloadResult = await downloadFile(url, fullPath, downloadUpdater, {
        ...fileObj,
        onMigrationProgress: (current) => {
          if (!migrationUpdater) {
            progressManager.log(`正在一次性导入旧断点数据: ${relativePath}`)
            migrationUpdater = createProgressUpdater('migrate')
          }
          migrationUpdater(current, false)
        },
        onVerifyProgress: (current) => {
          nativeVerifyUpdater ||= createProgressUpdater('verify')
          nativeVerifyUpdater(current, false)
        },
      })
    } catch (e) {
      signal.throwIfAborted()
      if (!isRetry) {
        return await checkAndDownload(true)
      }
      return { success: false, reason: `下载失败: ${e.message}` }
    }

    // 校验下载的文件
    signal.throwIfAborted()
    const verifyUpdater = createProgressUpdater('verify')
    if (!downloadResult?.verified) verifyUpdater(0)

    try {
      const stats = fs.statSync(fullPath)
      if (stats.size !== fileSize) {
        throw new Error('文件大小不匹配')
      }
      // 新下载由调度器并行校验一次；已有目标文件由上面的扫描校验处理。
      if (!downloadResult?.verified) {
        const md5 = await getFileMD5(fullPath, verifyUpdater)
        signal.throwIfAborted()
        if (md5 !== fileObj.md5) throw new Error('MD5 校验失败')
      }

      progressManager.updateSlot(slotIndex, {
        index,
        name,
        phase: 'done',
        percent: 100,
        speed: 0,
        elapsed: 0,
        eta: 0,
        current: fileSize,
        total: fileSize,
      })
      return { success: true }
    } catch (e) {
      signal.throwIfAborted()
      if (!isRetry) {
        try {
          fs.unlinkSync(fullPath)
        } catch {}
        await discardPartialDownload(fullPath)
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
      index,
      name,
      phase: 'error',
      percent: 0,
      speed: 0,
      elapsed: 0,
      eta: 0,
      current: progressManager.fileBytes.get(index) || 0,
      total: fileSize,
    })
    progressManager.markComplete(false, {
      index,
      name,
      path: relativePath,
      reason: result.reason,
    })
  }

  progressManager.clearSlot(slotIndex)
  return result.success
}

// ==================== 并发执行器 ====================
function runWithConcurrency(data, limit) {
  // 大文件先占用线程，小文件填补后续空位，减少末尾只剩大文件的等待。
  data = [...data].sort((a, b) => b.size - a.size)
  return new Promise((resolve) => {
    let nextIndex = 0
    let running = 0
    const total = data.length

    if (total === 0) return resolve()

    // 维护可用槽位队列
    const availableSlots = []
    for (let i = 0; i < limit; i++) availableSlots.push(i)

    function runNext() {
      while (
        !downloadController.signal.aborted &&
        availableSlots.length > 0 &&
        nextIndex < total
      ) {
        const currentIndex = nextIndex++
        const slotIndex = availableSlots.shift() // 取出一个可用槽位
        running++

        handleFile(data[currentIndex], currentIndex, total, slotIndex)
          .catch((error) => {
            progressManager.clearSlot(slotIndex)
            if (downloadController.signal.aborted) return
            progressManager.markComplete(false, {
              index: currentIndex,
              name: path.basename(data[currentIndex].dest),
              path: data[currentIndex].dest,
              reason: error.message,
            })
          })
          .finally(() => {
            running--
            availableSlots.push(slotIndex) // 归还槽位
            runNext()
          })
      }
      // 中断后不再补位，等所有在途任务关闭文件和请求，再输出统计。
      if (
        running === 0 &&
        (nextIndex === total || downloadController.signal.aborted)
      )
        resolve()
    }

    runNext()
  })
}

// ==================== 主函数 ====================
async function loadResources(signal = downloadController.signal) {
  if (!['default', 'pre'].includes(versionType)) {
    throw new Error(`不支持的下载版本: ${versionType}，可选 default/pre`)
  }
  const fetchJson = async (url) => {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
    return res.json()
  }
  const indexData = await fetchJson(gameIndexUrl)
  if (versionType === 'pre' && !indexData.predownload?.resourcePacks) {
    throw new Error('预下载尚未开放')
  }
  const gameData =
    versionType === 'pre'
      ? { ...indexData, ...indexData.predownload }
      : indexData
  const packs = getWWResourcePacks(gameData, resourceLevel)
  const cdnUrl = gameData.cdnList[0].url
  const files = []
  for (const pack of packs) {
    const manifest = await fetchJson(new URL(pack.indexFile, cdnUrl).href)
    const baseUrl = new URL(pack.baseUrl.replace(/\/?$/, '/'), cdnUrl)
    for (const file of manifest.resource) {
      files.push({
        ...file,
        url: new URL(file.dest.replace(/^\/+/, ''), baseUrl).href,
      })
    }
  }
  return files
}

async function main() {
  let interrupted = null
  const onSignal = (signal) => {
    if (interrupted) return
    interrupted = signal
    process.exitCode = signal === 'SIGINT' ? 130 : 143
    downloadController.abort(new Error(`下载已中断（${signal}）`))
  }
  const onSIGINT = () => onSignal('SIGINT')
  const onSIGTERM = () => onSignal('SIGTERM')
  process.on('SIGINT', onSIGINT)
  process.on('SIGTERM', onSIGTERM)
  try {
    console.log(
      `[${new Date().toTimeString().split(' ')[0]}] 正在加载资源列表...`,
    )

    let data
    try {
      data = await loadResources(downloadController.signal)
      downloadController.signal.throwIfAborted()
    } catch (err) {
      if (downloadController.signal.aborted) return
      console.error(`无法加载资源列表: ${err.message}`)
      process.exitCode = 1
      return
    }

    if (!data || data.length === 0) {
      console.log('资源列表为空，无需下载')
      return
    }

    const total = data.length
    console.log(`下载版本: ${versionType === 'pre' ? '预下载' : '正式版'}`)
    console.log(`资源等级: ${resourceLevelNames[resourceLevel]}`)
    console.log(
      `共 ${total} 个文件，下载线程上限: ${concurrency}，同时处理最多 ${concurrency} 个文件`,
    )
    console.log(`目标目录: ${targetDir}`)
    console.log('')

    // 初始化进度管理器
    const totalBytes = data.reduce((sum, file) => sum + file.size, 0)
    const fileConcurrency = concurrency
    progressManager = new ProgressManager(total, fileConcurrency, totalBytes)
    progressManager.init()

    // 执行下载
    await runWithConcurrency(data, fileConcurrency)

    // 如果有失败，返回非零退出码
    if (!interrupted && progressManager.failed > 0) {
      process.exitCode = 1
    }
  } finally {
    try {
      await downloadScheduler.close()
      if (progressManager) progressManager.finish({ interrupted })
      else if (interrupted) {
        console.log(
          `已中断（${interrupted}）：资源列表尚未加载完成，尚未开始下载。`,
        )
      }
    } finally {
      process.off('SIGINT', onSIGINT)
      process.off('SIGTERM', onSIGTERM)
    }
  }
}

main().catch((err) => {
  console.error(`主函数出错: ${err.message}`)
  process.exitCode = 1
})
