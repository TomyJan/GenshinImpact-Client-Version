import fs from 'fs'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'
import push from './push/push.js'
import path from 'path'

const ApiInfo = {
  WW: {
    CN: 'https://prod-cn-alicdn-gamestarter.kurogame.com/pcstarter/prod/game/G152/10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5/index.json',
    CN_NEW:
      'https://starter-server-api.kurogame.com/launcher/gray?deviceId=CFF248F5-5191-4EC8-882C-3995573E87A3&gameId=G152&appId=10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5&identify=game',
    OS: 'https://prod-alicdn-gamestarter.kurogame.com/pcstarter/prod/game/G153/50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c/index.json',
    OS_NEW:
      'https://starter-server-api.kurogame.net/launcher/gray?deviceId=CFF248F5-5191-4EC8-882C-3995573E87A3&gameId=G153&appId=50004_obOHXFrFanqsaIEOmuKroCcbZkQRBC7c&identify=game',
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
const targetDir = `./${game}/Win/Game/${server}/`
const scriptDataPath = `./Scripts/data/${game}/`
const latestVerPath = `${scriptDataPath}latest_Win_Game_${server}.json`
const lastVerPath = `${scriptDataPath}last_Win_Game_${server}.json`
const latestVerResPath = `${scriptDataPath}latest_Win_Game_${server}_Res.json`
const lastVerResPath = `${scriptDataPath}last_Win_Game_${server}_Res.json`

// 获取目录下最新的JSON文件名
function getLatestJsonFileName(directoryPath) {
  // 读取目录中的所有文件
  const files = fs.readdirSync(directoryPath)

  // 筛选出所有以 '.json' 结尾, 但不以 _Res.json 结尾的文件
  const jsonFiles = files.filter(
    (file) => file.endsWith('.json') && !file.endsWith('_Res.json')
  )

  // 如果没有找到任何 JSON 文件，则返回 null
  if (jsonFiles.length === 0) {
    console.error('未找到任何 JSON 文件:', directoryPath)
    process.exit(13)
  }

  // 根据文件的修改时间排序文件列表，获取最新的文件
  const latestJsonFile = jsonFiles.reduce((latestFile, currentFile) => {
    const currentFilePath = path.join(directoryPath, currentFile)
    const latestFilePath = path.join(directoryPath, latestFile)

    return fs.statSync(currentFilePath).mtime >
      fs.statSync(latestFilePath).mtime
      ? currentFile
      : latestFile
  })

  // 返回最新的 JSON 文件名
  return latestJsonFile
}

async function getWinGameVersion() {
  // try {
  // 发送GET请求获取JSON数据
  let jsonData = {}
  let rsp = await fetchWithTimeout(targetUrl)
  if (!rsp.ok) {
    console.error('请求失败:', rsp.status, rsp.statusText, ', 重试一次...')
    rsp = await fetchWithTimeout(targetUrl)
    if (!rsp.ok) {
      console.error('请求失败:', rsp.status, rsp.statusText)
      process.exit(2)
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

  // 检查是否获取到了游戏数据
  if (!jsonData.hasOwnProperty('default')) {
    console.error('返回数据不包含default属性:', jsonData)
    process.exit(3)
  }

  // 提取版本信息
  const latestVersion = jsonData.default?.version
  const preDownloadVersion = jsonData.predownload?.version

  console.log(
    '本地最新 REL 版本:',
    localData.default?.version,
    '预下载版本:',
    localData.predownload?.version
  )
  console.log(
    '取到最新 REL 版本:',
    latestVersion,
    '预下载版本:',
    preDownloadVersion
  )
  if (!latestVersion) {
    logger.error('最新 REL 版本数据获取失败, 程序退出...')
    process.exit(4)
  }

  // 构建文件名
  const fileName =
    `REL${latestVersion}` +
    (preDownloadVersion ? `+PRE${preDownloadVersion}` : '') +
    '.json'
  //console.log('文件名:', fileName);

  // 比较版本并更新本地数据
  if (
    localData.default?.version !== latestVersion ||
    localData.predownload?.version !== preDownloadVersion
  ) {
    console.log('数据有变化，正在更新...')
    // 先检查目标目录是否存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    // 写出JSON文件
    const outputFilePath = targetDir + fileName
    await fs.writeFileSync(
      outputFilePath,
      JSON.stringify(jsonData, null, 2) + '\n',
      'utf-8'
    )
    console.log('版本数据已写出到:', outputFilePath)

    // 更新本地数据
    localData = jsonData

    // 写回本地保存的数据文件
    // 先把 latestVerPath 文件的内容读出来写到 lastVerPath
    if (!fs.existsSync(latestVerPath)) {
      fs.writeFileSync(latestVerPath, '{}', 'utf-8')
    }
    const lastDataContent = await fs.readFileSync(latestVerPath, 'utf-8')
    await fs.writeFileSync(lastVerPath, lastDataContent, 'utf-8')
    await fs.writeFileSync(
      latestVerPath,
      JSON.stringify(localData, null, 2) + '\n',
      'utf-8'
    )
    console.log('脚本版本数据已更新并保存成功。')

    // 获取资源数据
    let resJsonData = {}
    let rsp_res = await fetchWithTimeout(
      jsonData.default.cdnList[0].url + jsonData.default.resources
    )
    if (!rsp_res.ok) {
      console.error(
        '请求失败:',
        rsp_res.status,
        rsp_res.statusText,
        ', 重试一次...'
      )
      rsp_res = await fetchWithTimeout(
        jsonData.default.cdnList[0].url + jsonData.default.resources
      )
      if (!rsp_res.ok) {
        console.error('请求失败:', rsp_res.status, rsp_res.statusText)
        process.exit(2)
      }
    }

    try {
      resJsonData = await rsp_res.json()
      if (preDownloadVersion) {
        let rsp_res_pre = await fetchWithTimeout(
          jsonData.default.cdnList[0].url + jsonData.predownload.resources
        )
        if (!rsp_res_pre.ok) {
          console.error(
            '请求失败:',
            rsp_res_pre.status,
            rsp_res_pre.statusText,
            ', 重试一次...'
          )
          rsp_res_pre = await fetchWithTimeout(
            jsonData.default.cdnList[0].url + jsonData.predownload.resources
          )
          if (!rsp_res_pre.ok) {
            console.error(
              '请求失败:',
              rsp_res_pre.status,
              rsp_res_pre.statusText
            )
            process.exit(2)
          }
        }
        try {
          resJsonData.predownload = await rsp_res_pre.json()
        } catch (error) {
          console.error(
            '返回数据不是json格式:',
            error.message,
            '返回内容:',
            resJsonData
          )
          process.exit(3)
        }
      }
    } catch (error) {
      console.error(
        '返回数据不是json格式:',
        error.message,
        '返回内容:',
        resJsonData
      )
      process.exit(3)
    }

    // 将 latestVerResPath 文件的内容读出来写到 lastVerResPath
    if (!fs.existsSync(latestVerResPath)) {
      fs.writeFileSync(latestVerResPath, '{}', 'utf-8')
    }
    const lastResDataContent = await fs.readFileSync(latestVerResPath, 'utf-8')
    await fs.writeFileSync(lastVerResPath, lastResDataContent, 'utf-8')
    await fs.writeFileSync(
      latestVerResPath,
      JSON.stringify(resJsonData, null, 2) + '\n',
      'utf-8'
    )
    console.log('脚本资源数据已更新并保存成功。')

    const outputResFilePath = targetDir + fileName.replace('.json', '_Res.json')
    await fs.writeFileSync(
      outputResFilePath,
      JSON.stringify(resJsonData, null, 2) + '\n',
      'utf-8'
    )
    console.log('资源数据已写出到:', outputResFilePath)

    console.log('所有数据已更新并保存成功。')

    // 如果只有单个服务器更新, 先写一下临时文件, 等两个都更新了再推送
    // 但是 WW 灰度不用此逻辑
    if (isNewApi) {
      console.log(`游戏 ${game} 的新API ${server} 服务器已更新, 正在推送...`)
      await push.pushWinGame(
        ApiInfo[game].name,
        server,
        jsonData,
        true,
        isNewApi
      )
      process.exit(0)
    }
    // 检查临时文件是否存在
    const tmpFileName = `${scriptDataPath}tmp-not_pushed_win_${game}_server.txt`
    if (fs.existsSync(tmpFileName)) {
      // 读取文件
      const tmpServer = await fs.readFileSync(tmpFileName, 'utf-8')
      if (tmpServer !== server) {
        // 获取另一个服务器的数据
        const otherServer = tmpServer
        const otherServerPath = `./${game}/Win/Game/${otherServer}/${getLatestJsonFileName(
          `./${game}/Win/Game/${otherServer}/`
        )}`
        const otherServerData = JSON.parse(
          await fs.readFileSync(otherServerPath, 'utf-8')
        )

        // 读取两个服务器的last数据
        const lastCNContent = await fs.readFileSync(
          `${scriptDataPath}last_Win_Game_${server === 'CN' ? 'CN' : 'OS'}${
            isNewApi ? '_NEW' : ''
          }.json`,
          'utf-8'
        )
        const lastOSContent = await fs.readFileSync(
          `${scriptDataPath}last_Win_Game_${server === 'CN' ? 'OS' : 'CN'}${
            isNewApi ? '_NEW' : ''
          }.json`,
          'utf-8'
        )
        const lastCN = JSON.parse(lastCNContent)
        const lastOS = JSON.parse(lastOSContent)

        // 检查两个服务器是否都有更新
        const serverUpdated =
          server === 'CN'
            ? lastCN.default.version !== jsonData.default.version
            : lastOS.default.version !== jsonData.default.version
        const otherServerUpdated =
          server === 'CN'
            ? lastOS.default.version !== otherServerData.default.version
            : lastCN.default.version !== otherServerData.default.version

        console.log(
          '当前服务器版本:',
          server === 'CN' ? lastCN.default.version : lastOS.default.version,
          '->',
          server === 'CN'
            ? jsonData.default.version
            : otherServerData.default.version
        )
        console.log(
          '另一服务器版本:',
          server === 'CN' ? lastOS.default.version : lastCN.default.version,
          '->',
          server === 'CN'
            ? otherServerData.default.version
            : jsonData.default.version
        )

        // 删除缓存的文件
        await fs.unlinkSync(tmpFileName)

        if (serverUpdated && otherServerUpdated) {
          // 两个服务器都更新了，一起推送
          console.log(
            `从临时文件获取当前已缓存${game} 版本信息: 两个服务器都已更新, 正在推送...`
          )
          await push.pushWinGame(
            ApiInfo[game].name,
            server,
            jsonData,
            true,
            isNewApi,
            {
              server: otherServer,
              data: otherServerData,
            }
          )
        } else if (serverUpdated) {
          // 只有当前服务器更新了
          console.log(
            `从临时文件获取当前已缓存${game} 版本信息: 只有 ${server} 服务器更新, 正在推送...`
          )
          await push.pushWinGame(
            ApiInfo[game].name,
            server,
            jsonData,
            true,
            isNewApi
          )
        } else if (otherServerUpdated) {
          // 只有另一个服务器更新了
          console.log(
            `从临时文件获取当前已缓存${game} 版本信息: 只有 ${otherServer} 服务器更新, 正在推送...`
          )
          await push.pushWinGame(
            ApiInfo[game].name,
            otherServer,
            otherServerData,
            true,
            isNewApi
          )
        } else {
          console.log('两个服务器都没有更新，无需推送')
        }
        process.exit(0)
      } else {
        // 这咋回事给我搞懵了, 别推, 等下次再检查吧
        console.error(
          '意料之外的错误: 临时文件中的服务器信息与当前服务器信息相同'
        )
        process.exit(5)
      }
    } // 没缓存文件, 说明只检查到了一个服务器的更新, 先不推送, 缓存
    else await fs.writeFileSync(tmpFileName, server, 'utf-8')
    console.log(
      `游戏 ${game} 只检查到了 ${server} 服务器的更新, 已缓存, 等待另一个服务器更新后再推送...`
    )
  } else {
    console.log('数据无变化，无需更新。')
  }
  // } catch (error) {
  //   console.error('发生错误:', error.message)
  //   process.exit(6)
  // }
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
