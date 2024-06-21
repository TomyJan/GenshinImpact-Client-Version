import fs from 'fs'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'
import push from './push/push.js'

const ApiInfo = {
  GI: {
    CN: 'https://api-takumi.mihoyo.com/event/download_porter/link/ys_cn/official/default',
    OS: 'https://sg-public-api.hoyoverse.com/event/download_porter/link/ys_global/genshinimpactpc/default',
    name: '原神',
  },
  SR: {
    CN: 'https://api-takumi.mihoyo.com/event/download_porter/link/hkrpg_cn/official/default',
    OS: 'https://sg-public-api.hoyoverse.com/event/download_porter/link/hkrpg_global/oswebpc/default',
    name: '崩坏星穹铁道',
  },
}
// 方便测试
// process.argv[2] = 'sr'
// process.argv[3] = 'cn'
// 根据命令行参数选择目标链接
const game =
  process.argv[2] === 'gi'
    ? 'GI'
    : process.argv[2] === 'sr'
    ? 'SR'
    : (() => {
        throw new Error('无效的命令行参数: ' + process.argv[2])
      })()
const server =
  process.argv[3] === 'cn'
    ? 'CN'
    : process.argv[3] === 'os'
    ? 'OS'
    : (() => {
        throw new Error('无效的命令行参数: ' + process.argv[3])
      })()

const targetUrl = ApiInfo[game][server]
const targetDir = `./${game}/Win/Launcher/${server}/`
const latestVerPath = `./Scripts/data/${game}/latest_Win_Launcher_${server}.json`

async function getWinLauncherVersion() {
  try {
    // 发送 GET请求获取 302 地址
    let jsonData = {}
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
    jsonData = { data: { link: await rsp.url } }

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
    const remoteLink = jsonData.data.link

    console.log('本地最新 Launcher 版本:', localData.link)
    console.log('取到最新 Launcher 版本:', remoteLink)
    if (
      remoteLink === undefined ||
      remoteLink === '' ||
      remoteLink === null ||
      remoteLink === 'null' ||
      remoteLink === 'undefined'
    ) {
      console.error('最新版本数据获取失败, 程序退出...')
      process.exit(1)
    }

    // 构建文件名
    const fileName = (await getNowDate()) + '.json'
    //console.log('文件名:', fileName);

    // 比较版本并更新本地数据
    if (localData.link !== remoteLink) {
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
      localData.link = remoteLink

      // 写回本地保存的数据文件
      await fs.writeFileSync(
        latestVerPath,
        JSON.stringify(localData, null, 2) + '\n',
        'utf-8'
      )

      console.log('数据已更新并保存成功。')

      // TODO 后续推送操作
      push.pushWinLauncher(ApiInfo[game].name, server, remoteLink)
    } else {
      console.log('数据无变化，无需更新。')
    }
  } catch (error) {
    console.error('发生错误:', error.message)
  }
}

// 写一个获取当前utc+8日期时间拼接成纯数字的方法
async function getNowDate() {
  let date = new Date()
  let year = date.getFullYear()
  let month = (date.getMonth() + 1).toString().padStart(2, '0')
  let day = date.getDate().toString().padStart(2, '0')
  let hour = date.getHours().toString().padStart(2, '0')
  let minute = date.getMinutes().toString().padStart(2, '0')
  let second = date.getSeconds().toString().padStart(2, '0')
  let nowDate = year + month + day + hour + minute + second
  return nowDate
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
getWinLauncherVersion()
