import fs from 'fs'
import fetch from 'node-fetch'
import AbortController from 'abort-controller'
import push from './push/push.js'

const ApiInfo = {
  GI: {
    CN: 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGamePackages?launcher_id=jGHBHlcOq1&game_ids[]=1Z8W5NHUQb',
    OS: 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api/getGamePackages?launcher_id=VYTpXlbWo8&game_ids[]=gopR6Cufr3',
    name: '原神',
  },
  SR: {
    CN: 'https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGamePackages?launcher_id=jGHBHlcOq1&game_ids[]=64kMb5iAWu',
    OS: 'https://sg-hyp-api.hoyoverse.com/hyp/hyp-connect/api/getGamePackages?launcher_id=VYTpXlbWo8&game_ids[]=4ziysqXOQ8',
    name: '崩坏星穹铁道',
  },
}

// 方便测试
// process.argv[2] = 'sr'
// process.argv[3] = 'os'

// 根据命令行参数选择目标链接
// const game =
//   process.argv[2] === 'gi'
//     ? 'GI'
//     : process.argv[2] === 'sr'
//     ? 'SR'
//     : (() => {
//         throw new Error('无效的命令行参数: ' + process.argv[2])
//       })()
let game = null
let gameBiz = null
switch (process.argv[2]) {
  case 'gi':
    game = 'GI'
    gameBiz = 'hk4e_'
    break
  case 'sr':
    game = 'SR'
    gameBiz = 'hkrpg_'
    break
  default:
    console.error('无效的命令行参数: ' + process.argv[2])
    process.exit(1)
}
// const server =
//   process.argv[3] === 'cn'
//     ? 'CN'
//     : process.argv[3] === 'os'
//     ? 'OS'
//     : (() => {
//         throw new Error('无效的命令行参数: ' + process.argv[3])
//       })()
let server = null
switch (process.argv[3]) {
  case 'cn':
    server = 'CN'
    gameBiz += 'cn'
    break
  case 'os':
    server = 'OS'
    gameBiz += 'global'
    break
  default:
    console.error('无效的命令行参数: ' + process.argv[3])
    process.exit(1)
}

const targetUrl = ApiInfo[game][server]
const targetDir = `./${game}/Win/Game/${server}/`
const scriptDataPath = `./Scripts/data/${game}/`
const latestVerPath = `${scriptDataPath}latest_Win_Game_${server}.json`

async function getWinGameVersion() {
  try {
    // 发送GET请求获取JSON数据
    let rsp = await fetchWithTimeout(targetUrl)
    if (!rsp.ok) {
      console.error('请求失败:', rsp.status, rsp.statusText, ', 重试一次...')
      rsp = await fetchWithTimeout(targetUrl)
      if (!rsp.ok) {
        console.error('请求失败:', rsp.status, rsp.statusText)
        process.exit(2)
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

    // 检查是否获取到了游戏数据
    if (jsonData?.retcode !== 0 || jsonData.data.game_packages.length !== 1 || jsonData.data.game_packages[0].game.biz !== gameBiz) {
      console.error('获取到的游戏数据不合法:', JSON.stringify(jsonData))
      process.exit(3)
    }

    // 提取版本信息
    const latestVersion = jsonData.data.game_packages[0].main.major.version
    const preDownloadVersion = jsonData.data.game_packages[0].pre_download?.major?.version
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

      // 如果只有单个服务器更新, 先写一下临时文件, 等两个都更新了再推送
      // 检查临时文件是否存在
      const tmpFileName = `${scriptDataPath}tmp-not_pushed_win_${game}_server.txt`
      if (fs.existsSync(tmpFileName)) {
        // 读取文件
        const tmpServer = await fs.readFileSync(tmpFileName, 'utf-8')
        if (tmpServer !== server) {
          // 两个都更新了
          console.log(
            `从临时文件获取当前已缓存${game} 版本信息: 两个服务器都已更新, 正在推送...`
          )
          // 删除缓存的文件
          await fs.unlinkSync(tmpFileName)

          // 推送
          await push.pushWinGame(ApiInfo[game].name, server, jsonData)
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
        `游戏${game}只检查到了${server}服务器的更新, 已缓存, 等待另一个服务器更新后再推送...`
      )
    } else {
      console.log('数据无变化，无需更新。')
    }
  } catch (error) {
    console.error('发生错误:', error.message)
    process.exit(6)
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
