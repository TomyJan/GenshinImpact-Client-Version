import fs from 'fs'
import push from './push/push.js'

const ApiInfo = {
  WW: {
    CN: 'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/launcher/10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5/G152/index.json',
    CN_NEW:
      'https://starter-server-api.kurogame.com/launcher/gray?deviceId=CFF248F5-5191-4EC8-882C-3995573E87A3&gameId=G152&appId=10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5&identify=installer',
    OS: 'https://prod-alicdn-gamestarter.kurogame.com/launcher/launcher/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/G153/index.json',
    OS_NEW:
      'https://starter-server-api.kurogame.net/launcher/gray?deviceId=CFF248F5-5191-4EC8-882C-3995573E87A3&gameId=G153&appId=50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c&identify=installer',
    name: '鸣潮',
  },
}
// 方便测试
// process.argv[2] = 'cn'

let game = 'WW'
let server = null
let isNewApi = false
switch (process.argv[2]) {
  case 'cn':
    server = 'CN'
    break
  case 'os':
    server = 'OS'
    break
  default:
    console.error('无效的命令行参数: ' + process.argv[2])
    process.exit(1)
}
switch (process.argv[3]) {
  case 'new':
    isNewApi = true
    break
  default:
    break
}
if (isNewApi) {
  server += '_NEW'
}

const targetUrl = ApiInfo[game][server]
const targetDir = `./${game}/Win/Launcher/${server}/`
const latestVerPath = `./Scripts/data/${game}/latest_Win_Launcher_${server}.json`

async function getWinLauncherVersion() {
  // try {
  // 发送 GET 请求获取 JSON 响应
  let jsonData = {}
  let rsp = await fetchWithTimeout(targetUrl)
  if (!rsp.ok) {
    console.log('请求失败:', rsp.status, rsp.statusText, ', 重试一次...')
    rsp = await fetchWithTimeout(targetUrl)
    if (!rsp.ok) {
      console.log('请求失败:', rsp.status, rsp.statusText)
      process.exit(1)
    }
  }

  try {
    jsonData = await rsp.json()
    if (isNewApi) {
      jsonData = jsonData.data
      if (!jsonData) {
        console.error('返回数据不包含data属性, 灰度未在进行')
        process.exit(0)
      }
    }
  } catch (error) {
    console.error(
      '返回数据不是json格式:',
      error.message,
      '返回内容:',
      await rsp.text()
    )
    process.exit(2)
  }

  if (!jsonData.hasOwnProperty('default')) {
    console.error('返回数据不包含default属性:', jsonData)
    process.exit(3)
  }

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
  const remoteLink = jsonData.default.resource.version

  console.log('本地最新 Launcher 版本:', localData?.default?.resource?.version)
  console.log('取到最新 Launcher 版本:', remoteLink)
  if (
    remoteLink === undefined ||
    remoteLink === '' ||
    remoteLink === null ||
    remoteLink === 'null' ||
    remoteLink === 'undefined'
  ) {
    console.error('最新版本数据获取失败, 程序退出...')
    process.exit(4)
  }

  // 构建文件名
  const fileName = (await getNowDate()) + '.json'
  //console.log('文件名:', fileName);

  // 比较版本并更新本地数据
  if (localData?.default?.resource?.version !== remoteLink) {
    console.log('数据有变化，正在更新...')
    // 写出JSON文件
    const outputFilePath = targetDir + fileName
    // 检查目录是否存在, 不存在则先递归创建
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    await fs.writeFileSync(
      outputFilePath,
      JSON.stringify(jsonData, null, 2) + '\n',
      'utf-8'
    )
    console.log('数据已写出到:', outputFilePath)

    // 后续推送操作
    push.pushWinLauncher(
      ApiInfo[game].name,
      server,
      {
        new: {
          version: remoteLink,
          size: jsonData.default.resource.size,
          url: jsonData.default.cdnList[0].url + jsonData.default.resource.path,
        },
        old: {
          version: localData?.default?.resource?.version,
          size: localData?.default?.resource?.size,
          url:
            localData?.default?.cdnList[0]?.url + localData?.default?.resource?.path,
        },
        changelog: jsonData.default.changelog['zh-Hans'],
      },
      true,
      isNewApi
    )

    // 更新本地数据
    localData = jsonData

    // 写回本地保存的数据文件
    await fs.writeFileSync(
      latestVerPath,
      JSON.stringify(localData, null, 2) + '\n',
      'utf-8'
    )

    console.log('数据已更新并保存成功。')
  } else {
    console.log('数据无变化，无需更新。')
  }
  // } catch (error) {
  //   console.error('发生错误:', error.message)
  // }
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
