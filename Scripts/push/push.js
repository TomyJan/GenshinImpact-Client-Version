import fs, { link } from 'fs'

import fetch from 'node-fetch'

const TGBotToken = process.env.TGBotToken
const TGMsgID = process.env.TGMsgID

class Push {
  constructor() {
    // 在构造函数中进行实例化的其他初始化工作
  }

  async pushWinGame(server, jsonData) {
    // 判断本地两个 latest 文件内容是否一样, 一样说明俩服务器都更新了, 一起推送, 否则只推送传入的服务器
    let latestCN = {}
    let latestOS = {}
    try {
      const latestCNContent = await fs.readFileSync(
        `./Scripts/data/latest_Win_Game_CN.json`,
        'utf-8'
      )
      latestCN = JSON.parse(latestCNContent)
    } catch (error) {
      console.error('读取本地数据失败:', error.message)
    }
    try {
      const latestOSContent = await fs.readFileSync(
        `./Scripts/data/latest_Win_Game_OS.json`,
        'utf-8'
      )
      latestOS = JSON.parse(latestOSContent)
    } catch (error) {
      console.error('读取本地数据失败:', error.message)
    }
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=${TGMsgID}&text=`
    let type = jsonData.data.pre_download_game.latest.version ? 'PRE' : 'REL'
    //console.log('latestCN:', JSON.stringify(latestCN))
    if (JSON.stringify(latestCN) === JSON.stringify(latestOS)) {
      console.log('两个服务器都更新了, 一起推送')
      //await this.pushWinGame('CN', latestCN)
      //await this.pushWinGame('OS', latestOS)
      pushUrl += encodeURIComponent(
        `原神 Win ${
          type === 'REL'
            ? escapeCharacters(jsonData.data.game.latest.version)
            : escapeCharacters(jsonData.data.pre_download_game.latest.version)
        } ${type} 更新！\n\n`
      )
      pushUrl += encodeURIComponent(`国服: \n`)
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText('CN', 'full', type)
      pushUrl += encodeURIComponent(`差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText('CN', 'diff', type)
      pushUrl += encodeURIComponent(`\n`)
      pushUrl += encodeURIComponent(`国际服: \n`)
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText('OS', 'full', type)
      pushUrl += encodeURIComponent(`差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText('OS', 'diff', type)
    } else {
      pushUrl += encodeURIComponent(
        `原神 Win ${server} ${
          type === 'REL'
            ? escapeCharacters(jsonData.data.game.latest.version)
            : escapeCharacters(jsonData.data.pre_download_game.latest.version)
        } ${type} 更新！\n\n`
      )
      pushUrl += encodeURIComponent(`完整包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(server, 'full', type)
      pushUrl += encodeURIComponent(`\n差分包: \n`)
      pushUrl += getEncodedLinkMsgGroupText(server, 'diff', type)
    }

    pushUrl += encodeURIComponent(
      `\n本体为分卷, 共有 ${
        jsonData.data.pre_download_game.latest.version
          ? jsonData.data.pre_download_game.latest.segments.length
          : jsonData.data.game.latest.segments.length
      } 个包, 请自行修改后缀\n\n`
    )

    pushUrl += encodeURIComponent(`\\#${jsonData.data.pre_download_game.latest.version ? escapeCharacters(jsonData.data.pre_download_game.latest.version) : escapeCharacters(jsonData.data.game.latest.version)} `)

    if (jsonData.data.pre_download_game.latest.version)
    pushUrl += encodeURIComponent(
      `\\#预下载 \\#predownload `
    )
    pushUrl += encodeURIComponent(`\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`)

    // console.log('推送地址:', pushUrl)

    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.log('推送请求失败:', rsp.status, rsp.statusText)
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
    function getEncodedLinkMsgGroupText(server, linkType, updateType) {
      // 根据传入的 server 值决定读取哪个文件, 解析成json后再根据 linkType 和 updateType 决定读取哪个字段
      let jsonData = {}
      try {
        // 获取 /win/Game/CN或OS目录下最新的.json作为传入的文件名
        const jsonDataContent = fs.readFileSync(
          `./Win/Game/${server}/${getLatestJsonFileName(
            `./Win/Game/${server}/`
          )}`,
          'utf-8'
        )
        jsonData = JSON.parse(jsonDataContent)
      } catch (error) {
        console.error('读取本地数据失败:', error.message)
      }
      let linkData =
        updateType === 'rel'
          ? jsonData.data.game
          : jsonData.data.pre_download_game
      //console.log('linkData:', linkData)
      let fullLink = '本体: 分卷 '
      if (linkType === 'full') {
        for (let i = 0; i < linkData.latest.segments.length; i++) {
          fullLink += `[${i + 1}](${escapeCharacters(
            linkData.latest.segments[i].path
          )})\\|`
        }
        // 去掉最后一个 |
        fullLink = fullLink.slice(0, -2) + '\n'
        //return encodeURIComponent(fullLink)

        // 拼接语音包链接
        let voiceLink = '语音包: '
        // 按照 voice_packs.language 字段区分语言包
        let voiceData = linkData.latest.voice_packs
        //console.log('voiceData:', voiceData)
        for (let i = 0; i < voiceData.length; i++) {
          if (voiceData[i].language === 'zh-cn')
            voiceLink += `[中文](${escapeCharacters(voiceData[i].path)})\\|`
          else if (voiceData[i].language === 'en-us')
            voiceLink += `[英文](${escapeCharacters(voiceData[i].path)})\\|`
          else if (voiceData[i].language === 'ja-jp')
            voiceLink += `[日文](${escapeCharacters(voiceData[i].path)})\\|`
          else if (voiceData[i].language === 'ko-kr')
            voiceLink += `[韩文](${escapeCharacters(voiceData[i].path)})\\|`
        }
        // 去掉最后一个 |
        voiceLink = voiceLink.slice(0, -2) + '\n'

        return encodeURIComponent(fullLink + voiceLink)
      } else {
        //最烦人的差分包
        // 读取 linkData.diffs数组中成员的 version 作为名字
        let diffLink = ''
        for (let i = 0; i < linkData.diffs.length; i++) {
          diffLink += `${escapeCharacters(
            linkData.diffs[i].version
          )}\\-${escapeCharacters(linkData.latest.version)}: `
          diffLink += `[本体](${escapeCharacters(linkData.diffs[i].path)})\\|`
          let voiceData = linkData.diffs[i].voice_packs
          for (let j = 0; j < voiceData.length; j++) {
            if (voiceData[j].language === 'zh-cn')
              diffLink += `[中文](${escapeCharacters(voiceData[j].path)})\\|`
            else if (voiceData[j].language === 'en-us')
              diffLink += `[英文](${escapeCharacters(voiceData[j].path)})\\|`
            else if (voiceData[j].language === 'ja-jp')
              diffLink += `[日文](${escapeCharacters(voiceData[j].path)})\\|`
            else if (voiceData[j].language === 'ko-kr')
              diffLink += `[韩文](${escapeCharacters(voiceData[j].path)})\\|`
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

  async pushWinLauncher(server, link) {
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=${TGMsgID}&text=`
    pushUrl += encodeURIComponent(`原神 Win ${server} Launcher 更新！\n\n`)
    pushUrl += `链接: [${escapeCharacters(link)}](${escapeCharacters(link)})\n`
    pushUrl += encodeURIComponent(`\n\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`)

    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.log('推送请求失败:', rsp.status, rsp.statusText)
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
