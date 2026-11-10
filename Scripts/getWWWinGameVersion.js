import fs from 'fs'
import push from './push/push.js'
import path from 'path'
import { fetchWithRetry } from './utils/fetchWithRetry.js'
import { getWWResourceLevels } from './utils/wwResources.js'

const ApiInfo = {
  WW: {
    CN: 'https://prod-cn-alicdn-gamestarter.kurogame.com/launcher/game/10003_oLNgHF1CESo51DGHN2odtp40e3oI1HfZ/G152/official/index.json',
    CN_NEW:
      'https://starter-server-api.kurogame.com/launcher/gray?deviceId=CFF248F5-5191-4EC8-882C-3995573E87A3&gameId=G152&appId=10003_Y8xXrXk65DqFHEDgApn3cpK5lfczpFx5&identify=game',
    OS: 'https://prod-alicdn-gamestarter.kurogame.com/launcher/game/50004_P7xcUZnEr1AXIGON25E6KjpOgTlVrg6e/G153/official/index.json',
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
    (file) => file.endsWith('.json') && !file.endsWith('_Res.json'),
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

// 新正式接口按资源等级分包，保留原始数据，并兼容现有版本/推送字段。
function normalizeGameData(data) {
  if (!data.resourcePacks) return data
  const getInfo = (info) => {
    const resourceLevels = getWWResourceLevels(info)
    return {
      version: info.resourcePacks.common.version,
      cdnList: info.cdnList,
      resourceLevel: 'HD',
      resourceLevelSizes: Object.fromEntries(
        Object.entries(resourceLevels).map(([level, value]) => [
          level,
          value.size,
        ]),
      ),
      resourceLevels,
      resourcePacks: info.resourcePacks,
      changelog: info.changelog || {},
      config: info.config || {},
    }
  }
  return {
    ...data,
    default: getInfo(data),
    predownload: data.predownload?.resourcePacks
      ? getInfo({ ...data, ...data.predownload })
      : data.predownload,
  }
}

async function getGameResources(info) {
  const fetchResources = async (resourcePath) => {
    const rsp = await fetchWithRetry(info.cdnList[0].url + resourcePath)
    if (!rsp.ok)
      throw new Error(`资源请求失败: ${rsp.status} ${rsp.statusText}`)
    return rsp.json()
  }
  if (!info.resourceLevels) return fetchResources(info.resources)
  // 公共包在多个画质中复用，每个分包只请求一次。
  const packNames = [
    ...new Set(
      Object.values(info.resourceLevels).flatMap(
        (level) => level.resourcePacks,
      ),
    ),
  ]
  const resourcesByPack = {}
  for (const name of packNames) {
    resourcesByPack[name] = (
      await fetchResources(info.resourcePacks[name].indexFile)
    ).resource
  }
  return {
    // 保留原有 resource 字段，兼容旧记录和其他服务器推送。
    resource: info.resourceLevels[info.resourceLevel].resourcePacks.flatMap(
      (name) => resourcesByPack[name],
    ),
    resourceLevels: Object.fromEntries(
      Object.entries(info.resourceLevels).map(([level, value]) => [
        level,
        {
          fileCount: value.resourcePacks.reduce(
            (total, name) => total + resourcesByPack[name].length,
            0,
          ),
        },
      ]),
    ),
  }
}

// 正式通道先等待另一服的下一次检查；同类型更新合并，另一服无更新则单独推送。
async function pushOrWait(jsonData, changed, type) {
  const forType = (data, updateType) =>
    updateType === 'REL' ? { ...data, predownload: null } : data
  if (isNewApi) {
    if (changed)
      await push.pushWinGame(
        ApiInfo[game].name,
        server,
        forType(jsonData, type),
        true,
        true,
      )
    return
  }

  const pendingPath = `${scriptDataPath}tmp-not_pushed_win_${game}_server.txt`
  let pending = null
  if (fs.existsSync(pendingPath)) {
    const content = fs.readFileSync(pendingPath, 'utf-8').trim()
    // 兼容旧版只记录服务器名的等待标记。
    pending = content.startsWith('{')
      ? JSON.parse(content)
      : { server: content }
    if (!['CN', 'OS'].includes(pending.server))
      throw new Error(`无效的等待服务器: ${pending.server}`)
  }
  const savePending = () =>
    fs.writeFileSync(
      pendingPath,
      JSON.stringify({ server, type }) + '\n',
      'utf-8',
    )

  if (pending && pending.server !== server) {
    const otherData = JSON.parse(
      fs.readFileSync(
        `${scriptDataPath}latest_Win_Game_${pending.server}.json`,
        'utf-8',
      ),
    )
    const otherType =
      pending.type || (otherData.predownload?.version ? 'PRE' : 'REL')
    const canMerge =
      changed &&
      type === otherType &&
      (type !== 'PRE' ||
        jsonData.predownload.version === otherData.predownload?.version)
    // 推送函数成功后会退出进程，须先保存下一条等待项或清除已处理的标记。
    if (changed && !canMerge) savePending()
    else fs.unlinkSync(pendingPath)
    if (canMerge) {
      await push.pushWinGame(
        ApiInfo[game].name,
        server,
        forType(jsonData, type),
        true,
        false,
        { server: pending.server, data: forType(otherData, otherType) },
      )
    } else {
      await push.pushWinGame(
        ApiInfo[game].name,
        pending.server,
        forType(otherData, otherType),
        true,
        false,
      )
    }
  } else if (changed) {
    savePending()
    console.log(
      `游戏 ${game} 的 ${server} ${type} 更新已缓存，等待另一服检查后推送...`,
    )
  }
}

async function getWinGameVersion() {
  // try {
  // 发送GET请求获取JSON数据
  let jsonData = {}
  const rsp = await fetchWithRetry(targetUrl)
  if (!rsp.ok) {
    console.error('请求失败:', rsp.status, rsp.statusText)
    process.exit(2)
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
      await rsp.text(),
    )
    process.exit(3)
  }

  jsonData = normalizeGameData(jsonData)

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
    localData.predownload?.version,
  )
  console.log(
    '取到最新 REL 版本:',
    latestVersion,
    '预下载版本:',
    preDownloadVersion,
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

  // 按实际变化判断通知类型，预下载存在但未变化时仍可推送正式版更新。
  const preChanged =
    localData.predownload?.version !== preDownloadVersion ||
    JSON.stringify(localData.predownload?.resourceLevels) !==
      JSON.stringify(jsonData.predownload?.resourceLevels)
  const updateType = preDownloadVersion && preChanged ? 'PRE' : 'REL'
  // 比较版本并更新本地数据
  const changed =
    localData.default?.version !== latestVersion ||
    preChanged ||
    localData.default?.resourceLevel !== jsonData.default.resourceLevel ||
    JSON.stringify(localData.default?.resourceLevels) !==
      JSON.stringify(jsonData.default.resourceLevels)
  if (changed) {
    console.log('数据有变化，正在更新...')
    // 所有清单取齐后才更新版本缓存，失败时下次仍能重试。
    let resJsonData = {}
    try {
      resJsonData = await getGameResources(jsonData.default)
      if (preDownloadVersion) {
        resJsonData.predownload = await getGameResources({
          cdnList: jsonData.default.cdnList,
          ...jsonData.predownload,
        })
      }
    } catch (error) {
      console.error('获取资源数据失败:', error.message)
      process.exit(3)
    }

    // 先检查目标目录是否存在
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }
    // 写出JSON文件
    const outputFilePath = targetDir + fileName
    await fs.writeFileSync(
      outputFilePath,
      JSON.stringify(jsonData, null, 2) + '\n',
      'utf-8',
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
      'utf-8',
    )
    console.log('脚本版本数据已更新并保存成功。')

    // 将 latestVerResPath 文件的内容读出来写到 lastVerResPath
    if (!fs.existsSync(latestVerResPath)) {
      fs.writeFileSync(latestVerResPath, '{}', 'utf-8')
    }
    const lastResDataContent = await fs.readFileSync(latestVerResPath, 'utf-8')
    await fs.writeFileSync(lastVerResPath, lastResDataContent, 'utf-8')
    await fs.writeFileSync(
      latestVerResPath,
      JSON.stringify(resJsonData, null, 2) + '\n',
      'utf-8',
    )
    console.log('脚本资源数据已更新并保存成功。')

    const outputResFilePath = targetDir + fileName.replace('.json', '_Res.json')
    await fs.writeFileSync(
      outputResFilePath,
      JSON.stringify(resJsonData, null, 2) + '\n',
      'utf-8',
    )
    console.log('资源数据已写出到:', outputResFilePath)

    console.log('所有数据已更新并保存成功。')
  } else {
    console.log('数据无变化，无需更新。')
  }
  await pushOrWait(jsonData, changed, updateType)
  // } catch (error) {
  //   console.error('发生错误:', error.message)
  //   process.exit(6)
  // }
}

// 执行函数
getWinGameVersion()
