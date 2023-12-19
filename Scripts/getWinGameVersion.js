import fs from 'fs'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'
import push from './push/push.js'

const CN_API_URL =
  'https://sdk-static.mihoyo.com/hk4e_cn/mdk/launcher/api/resource?channel_id=1&key=eYd89JmJ&launcher_id=18&sub_channel_id=1'
const OS_API_URL =
  'https://sdk-os-static.mihoyo.com/hk4e_global/mdk/launcher/api/resource?channel_id=1&key=gcStgarh&launcher_id=10&sub_channel_id=0'

// 方便测试
process.argv[2] = 'cn'
// 根据命令行参数选择目标链接
const server =
  process.argv[2] === 'cn'
    ? 'CN'
    : process.argv[2] === 'os'
    ? 'OS'
    : (() => {
        throw new Error('无效的命令行参数: ' + process.argv[2])
      })()

const targetUrl = server === 'CN' ? CN_API_URL : OS_API_URL
const targetDir = `./Win/Game/${server}/`
const latestVerPath = `./Scripts/data/latest_Win_Game_${server}.json`

async function getWinGameVersion() {
  try {
    // 发送GET请求获取JSON数据
    let rsp = await fetchWithTimeout(targetUrl)
    if (!rsp.ok) {
      console.log('请求失败:', rsp.status, rsp.statusText, ', 重试一次...')
      rsp = await fetchWithTimeout(targetUrl)
      if (!rsp.ok) {
        console.log('请求失败:', rsp.status, rsp.statusText)
        return false
      }
    }

    // console.log(JSON.stringify(await rsp.json()))
    let jsonData = await rsp.json()

    // 读取本地保存的数据
    let localData = {}
    try {
      const localDataContent = await fs.readFileSync(latestVerPath, 'utf-8')
      //console.log('读取本地数据:', localDataContent);
      localData = JSON.parse(localDataContent)
    } catch (error) {
      // 文件不存在或解析错误时，忽略错误
      console.error('读取本地数据失败:', error.message)
    }

    // 提取版本信息
    const latestVersion = jsonData.data.game.latest.version
    const preDownloadVersion = jsonData.data.pre_download_game.latest.version
    console.log(
      '本地最新 REL 版本:',
      localData.latestVersion,
      '预下载版本:',
      localData.preDownloadVersion
    )
    console.log(
      '取到最新 REL 版本:',
      latestVersion,
      '预下载版本:',
      preDownloadVersion
    )

    // 构建文件名
    const fileName =
      `REL${latestVersion}` +
      (preDownloadVersion ? `+PRE${preDownloadVersion}` : '') +
      '.json'
    //console.log('文件名:', fileName);

    // 比较版本并更新本地数据
    if (
      localData.latestVersion !== latestVersion ||
      localData.preDownloadVersion !== preDownloadVersion
    ) {
      console.log('数据有变化，正在更新...')
      // 写出JSON文件
      const outputFilePath = targetDir + fileName
      await fs.writeFileSync(
        outputFilePath,
        JSON.stringify(jsonData, null, 2) + '\n',
        'utf-8'
      )
      console.log('数据已写出到:', outputFilePath)

      // 更新本地数据
      localData.latestVersion = latestVersion
      localData.preDownloadVersion = preDownloadVersion

      // 写回本地保存的数据文件
      await fs.writeFileSync(
        latestVerPath,
        JSON.stringify(localData, null, 2) + '\n',
        'utf-8'
      )

      console.log('数据已更新并保存成功。')

      // TODO 后续推送操作
      push.pushWinGame(server, jsonData)
    } else {
      console.log('数据无变化，无需更新。')
    }
  } catch (error) {
    console.error('发生错误:', error.message)
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 10000 } = options
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeout)
  const response = await fetch(resource, {
    ...options,
    signal: controller.signal,
  })
  clearTimeout(id)
  return response
}

// 执行函数
getWinGameVersion()
