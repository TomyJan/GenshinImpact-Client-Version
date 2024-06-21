import fs, { link } from 'fs'
import path from 'path'
import fetch from 'node-fetch'

const TGBotToken = process.env.TGBotToken
const TGMsgID_GI = process.env.TGMsgID_GI || process.env.TGMsgID
const TGMsgID_SR = process.env.TGMsgID_SR || process.env.TGMsgID

class Push {
  constructor() {
    // 在构造函数中进行实例化的其他初始化工作
  }

  async pushWinGame(gameName, server, jsonData) {
    // 判断本地两个 latest 文件内容是否一样, 一样说明俩服务器都更新了, 一起推送, 否则只推送传入的服务器
    let latestCN = {}
    let latestOS = {}
    const latestVerPath =
      gameName === '原神' ? `./Scripts/data/GI/` : `./Scripts/data/SR/`
    try {
      const latestCNContent = await fs.readFileSync(
        `${latestVerPath}latest_Win_Game_CN.json`,
        'utf-8'
      )
      latestCN = JSON.parse(latestCNContent)
    } catch (error) {
      console.error('读取本地数据失败:', error.message)
    }
    try {
      const latestOSContent = await fs.readFileSync(
        `${latestVerPath}latest_Win_Game_OS.json`,
        'utf-8'
      )
      latestOS = JSON.parse(latestOSContent)
    } catch (error) {
      console.error('读取本地数据失败:', error.message)
    }
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=`
    let gameId = ``
    if (gameName === '原神') {
      pushUrl += `${TGMsgID_GI}&text=${encodeURIComponent(gameName)}`
      gameId = 'GI'
    } else if (gameName === '崩坏星穹铁道') {
      pushUrl += `${TGMsgID_SR}&text=${encodeURIComponent(gameName)}`
      gameId = 'SR'
    } else {
      console.error('无效的游戏名:', gameName)
      process.exit(1)
    }
    let type = jsonData.data.game_packages[0].pre_download?.major?.version
      ? 'PRE'
      : 'REL'
    //console.log('latestCN:', JSON.stringify(latestCN))
    if (JSON.stringify(latestCN) === JSON.stringify(latestOS)) {
      console.log('两个服务器都更新了, 一起推送')
      //await this.pushWinGame('CN', latestCN)
      //await this.pushWinGame('OS', latestOS)
      pushUrl += encodeURIComponent(
        ` Win ${
          type === 'REL'
            ? escapeCharacters(
                jsonData.data.game_packages[0].main.major.version
              )
            : escapeCharacters(
                jsonData.data.game_packages[0].pre_download?.major?.version
              )
        } ${type} 更新！\n\n`
      )
      pushUrl += encodeURIComponent(`国服: \n`)
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, 'CN', 'full', type)
      pushUrl += encodeURIComponent(`差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, 'CN', 'diff', type)
      pushUrl += encodeURIComponent(`\n`)
      pushUrl += encodeURIComponent(`国际服: \n`)
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, 'OS', 'full', type)
      pushUrl += encodeURIComponent(`差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, 'OS', 'diff', type)
    } else {
      pushUrl += encodeURIComponent(
        ` Win ${server} ${
          type === 'REL'
            ? escapeCharacters(
                jsonData.data.game_packages[0].main.major.version
              )
            : escapeCharacters(
                jsonData.data.game_packages[0].pre_download?.major?.version
              )
        } ${type} 更新！\n\n`
      )
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, server, 'full', type)
      pushUrl += encodeURIComponent(`\n差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(gameId, server, 'diff', type)
    }
    pushUrl += encodeURIComponent('\n')

    if (
      jsonData.data.game_packages[0].pre_download?.major?.game_pkgs.length > 1
    )
      // 有分卷包时的提示
      pushUrl += encodeURIComponent(
        `本体分卷共有 ${
          jsonData.data.game_packages[0].pre_download?.major?.version
            ? jsonData.data.game_packages[0].pre_download?.major?.game_pkgs
                .length
            : jsonData.data.game_packages[0].main.major.game_pkgs.length
        } 个包, 请自行合并\n\n`
      )

    pushUrl += encodeURIComponent(
      `\\#${
        jsonData.data.game_packages[0].pre_download?.major?.version
          ? escapeCharacters(
              jsonData.data.game_packages[0].pre_download?.major?.version
            )
          : escapeCharacters(jsonData.data.game_packages[0].main.major.version)
      } `
    )

    if (jsonData.data.game_packages[0].pre_download?.major?.version)
      pushUrl += encodeURIComponent(`\\#预下载 \\#predownload `)
    pushUrl +=
      gameName === '原神'
        ? encodeURIComponent(
            `\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`
          )
        : encodeURIComponent(
            `\n_via [@StarRailVersion](https://t.me/StarRailVersion)_`
          )

    console.log('推送地址:', pushUrl)

    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.log('推送请求失败:', rsp.status, rsp.statusText, await rsp.text())
      return false
    }

    // console.log(JSON.stringify(await rsp.json()))
    let pushJsonData = await rsp.json()
    console.log('推送结果:', pushJsonData)

    /**
     * 获取 html 编码好, 按照 tg 要求转义好, 组合好的 markdown 格式的链接组文本
     * @param {string} server 服务器, CN/OS
     * @param {string} linkType 链接类型, full/diff
     * @param {string} updateType 更新类型, REL/PRE
     * @returns {string} 拼好的文本
     */
    function getEncodedLinkMsgGroupText(gameId, server, linkType, updateType) {
      // 根据传入的 server 值决定读取哪个文件, 解析成json后再根据 linkType 和 updateType 决定读取哪个字段
      let jsonData = {}
      //console.log('filePath:', `./Win/Game/${server}/${getLatestJsonFileName(`./Win/Game/${server}/`)}`)
      try {
        // 获取 /win/Game/CN或OS目录下最新的.json作为传入的文件名
        const jsonDataContent = fs.readFileSync(
          `./${gameId}/Win/Game/${server}/${getLatestJsonFileName(
            `./${gameId}/Win/Game/${server}/`
          )}`,
          'utf-8'
        )
        //console.log('读取本地数据:', jsonDataContent);
        jsonData = JSON.parse(jsonDataContent)
      } catch (error) {
        console.error('读取本地数据失败:', error.message)
      }
      //console.log('jsonData:', jsonData)
      //console.log('updateType:', updateType)
      let linkData = {
        ...(updateType === 'REL'
          ? jsonData.data.game_packages[0].main
          : jsonData.data.game_packages[0].pre_download),
      }
      //console.log('linkData:', linkData)
      let fullLink = '本体: '

      if (linkType === 'full') {
        if ((linkData.major.game_pkgs.length = 1)) {
          //完整包
          fullLink += `[完整包](${escapeCharacters(
            linkData.major.game_pkgs[0].url
          )}) \\| `
        } else {
          // 分卷包
          fullLink += `分卷 `
          for (let i = 0; i < linkData.major.game_pkgs.length; i++) {
            fullLink += `[${i + 1}](${escapeCharacters(
              linkData.major.game_pkgs[i].url
            )}) \\| `
          }
          // 去掉最后一个 |
          fullLink = fullLink.slice(0, -3) + '\n'
        }

        //return encodeURIComponent(fullLink)

        // 拼接语音包链接
        let voiceLink = '语音包: '
        // 按照 audio_pkgs.language 字段区分语言包
        let voiceData = linkData.major.audio_pkgs

        // 优先按顺序处理五种已知语音包
        let voiceDataCN = voiceData.find((item) => item.language === 'zh-cn')
        let voiceDataTW = voiceData.find((item) => item.language === 'zh-tw')
        let voiceDataJP = voiceData.find((item) => item.language === 'ja-jp')
        let voiceDataEN = voiceData.find((item) => item.language === 'en-us')
        let voiceDataKR = voiceData.find((item) => item.language === 'ko-kr')
        if (voiceDataCN) {
          voiceLink += `[简](${escapeCharacters(voiceDataCN.url)})\\|`
          voiceData = voiceData.filter((item) => item.language !== 'zh-cn')
        }
        if (voiceDataTW) {
          voiceLink += `[繁](${escapeCharacters(voiceDataTW.url)})\\|`
          voiceData = voiceData.filter((item) => item.language !== 'zh-tw')
        }
        if (voiceDataJP) {
          voiceLink += `[日](${escapeCharacters(voiceDataJP.url)})\\|`
          voiceData = voiceData.filter((item) => item.language !== 'ja-jp')
        }
        if (voiceDataEN) {
          voiceLink += `[英](${escapeCharacters(voiceDataEN.url)})\\|`
          voiceData = voiceData.filter((item) => item.language !== 'en-us')
        }
        if (voiceDataKR) {
          voiceLink += `[韩](${escapeCharacters(voiceDataKR.url)})\\|`
          voiceData = voiceData.filter((item) => item.language !== 'ko-kr')
        }
        // 处理剩余的语音包
        for (let i = 0; i < voiceData.length; i++) {
          voiceLink += `[${escapeCharacters(
            voiceData[i].language
          )}](${escapeCharacters(voiceData[i].url)})\\|`
        }
        // 去掉最后一个 |
        voiceLink = voiceLink.slice(0, -2) + '\n'

        return encodeURIComponent(fullLink + voiceLink)
      } else {
        //最烦人的差分包
        // 读取 linkData.patches 数组中成员的 version 作为名字
        let diffLink = ''
        for (let i = 0; i < linkData.patches.length; i++) {
          diffLink += `${escapeCharacters(
            linkData.patches[i].version
          )}\\-${escapeCharacters(linkData.major.version)}: `
          if ((linkData.patches[i].game_pkgs.length = 1)) {
            //完整包
            diffLink += `[本体](${escapeCharacters(
              linkData.patches[i].game_pkgs[0].url
            )}) \\| `
          } else {
            // 分卷包
            diffLink += `本体: 分卷 `
            for (let i = 0; i < linkData.patches[i].game_pkgs.length; i++) {
              diffLink += `[${i + 1}](${escapeCharacters(
                linkData.patches[i].game_pkgs[i].url
              )}) \\| `
            }
            // 去掉最后一个 |
            diffLink = diffLink.slice(0, -3) + '\n'
          }

          let voiceData = linkData.patches[i].audio_pkgs
          // 优先按顺序处理五种已知语音包
          let voiceDataCN = voiceData.find((item) => item.language === 'zh-cn')
          let voiceDataTW = voiceData.find((item) => item.language === 'zh-tw')
          let voiceDataJP = voiceData.find((item) => item.language === 'ja-jp')
          let voiceDataEN = voiceData.find((item) => item.language === 'en-us')
          let voiceDataKR = voiceData.find((item) => item.language === 'ko-kr')
          if (voiceDataCN) {
            diffLink += `[简](${escapeCharacters(voiceDataCN.url)})\\|`
            voiceData = voiceData.filter((item) => item.language !== 'zh-cn')
          }
          if (voiceDataTW) {
            diffLink += `[繁](${escapeCharacters(voiceDataTW.url)})\\|`
            voiceData = voiceData.filter((item) => item.language !== 'zh-tw')
          }
          if (voiceDataJP) {
            diffLink += `[日](${escapeCharacters(voiceDataJP.url)})\\|`
            voiceData = voiceData.filter((item) => item.language !== 'ja-jp')
          }
          if (voiceDataEN) {
            diffLink += `[英](${escapeCharacters(voiceDataEN.url)})\\|`
            voiceData = voiceData.filter((item) => item.language !== 'en-us')
          }
          if (voiceDataKR) {
            diffLink += `[韩](${escapeCharacters(voiceDataKR.url)})\\|`
            voiceData = voiceData.filter((item) => item.language !== 'ko-kr')
          }
          // 处理剩余的语音包
          for (let j = 0; j < voiceData.length; j++) {
            diffLink += `[${escapeCharacters(
              voiceData[j].language
            )}](${escapeCharacters(voiceData[j].url)})\\|`
          }
          // 去掉最后一个 |
          diffLink = diffLink.slice(0, -2) + '\n'
        }
        return encodeURIComponent(diffLink)
      }

      return ''
    }

    function getLatestJsonFileName(directoryPath) {
      // 读取目录中的所有文件
      const files = fs.readdirSync(directoryPath)

      // 筛选出所有以 '.json' 结尾的文件
      const jsonFiles = files.filter((file) => file.endsWith('.json'))

      // 如果没有找到任何 JSON 文件，则返回 null
      if (jsonFiles.length === 0) {
        return null
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
  }

  async pushWinLauncher(gameName, server, link) {
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=`
    if (gameName === '原神') pushUrl += `${TGMsgID_GI}&text=`
    else pushUrl += `${TGMsgID_SR}&text=`
    pushUrl += encodeURIComponent(
      `${gameName} Win ${server} Launcher 更新！\n\n`
    )
    pushUrl += `链接: [${escapeCharacters(link)}](${escapeCharacters(link)})\n`
    pushUrl +=
      gameName === '原神'
        ? encodeURIComponent(
            `\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`
          )
        : encodeURIComponent(
            `\n_via [@StarRailVersion](https://t.me/StarRailVersion)_`
          )

    console.log('推送地址:', pushUrl)
    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.log('推送请求失败:', rsp.status, rsp.statusText, await rsp.text())
      return false
    }

    // console.log(JSON.stringify(await rsp.json()))
    let pushJsonData = await rsp.json()
    console.log('推送结果:', pushJsonData)
  }

  async pushAndroidGame(gameName, server, link) {
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=`
    if (gameName === '原神') pushUrl += `${TGMsgID_GI}&text=`
    else pushUrl += `${TGMsgID_SR}&text=`
    pushUrl += encodeURIComponent(
      `${gameName} Android ${server} Game 更新！\n\n`
    )
    pushUrl += `链接: [${escapeCharacters(link)}](${escapeCharacters(link)})\n`
    pushUrl +=
      gameName === '原神'
        ? encodeURIComponent(
            `\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`
          )
        : encodeURIComponent(
            `\n_via [@StarRailVersion](https://t.me/StarRailVersion)_`
          )

    console.log('推送地址:', pushUrl)
    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.log('推送请求失败:', rsp.status, rsp.statusText, await rsp.text())
      return false
    }

    // console.log(JSON.stringify(await rsp.json()))
    let pushJsonData = await rsp.json()
    console.log('推送结果:', pushJsonData)
  }
}

function escapeCharacters(inputString) {
  // 定义需要转义的字符集合
  var charactersToEscape = /[_*\[\]()~`>#\+\-=|{}.!]/g

  // 使用replace方法进行转义
  var escapedString = inputString.replace(charactersToEscape, '\\$&')

  return escapedString
}

// 直接实例化 Push 类并默认导出
export default new Push()
