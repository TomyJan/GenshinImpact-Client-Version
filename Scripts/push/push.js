import fs, { link } from 'fs'
import path from 'path'
import fetch from 'node-fetch'

const TGBotToken =
  process.env.TGBotToken || '5680978316:AAFjPWjc5RBcCcS6jwkuhitt1vNJKORk1eo'
const TGMsgID_GI = process.env.TGMsgID_GI || process.env.TGMsgID
const TGMsgID_SR = process.env.TGMsgID_SR || process.env.TGMsgID
const TGMsgID_WW = process.env.TGMsgID_WW || process.env.TGMsgID || '915891411'

class Push {
  constructor() {
    // 在构造函数中进行实例化的其他初始化工作
  }

  async pushWinGame(
    gameName,
    server,
    jsonData,
    isKuroGame = false,
    isKuroNewApi = false,
    otherServerData = null
  ) {
    // 库洛游戏的解析
    if (isKuroGame) {
      // 判断本地两个 latest 文件内容是否一样, 一样说明俩服务器都更新了, 一起推送, 否则只推送传入的服务器
      let latestCN = {}
      let latestOS = {}
      let latestVerPath = ''
      if (gameName === '鸣潮') latestVerPath = `./Scripts/data/WW/`
      else {
        console.error('无效的游戏名:', gameName)
        process.exit(1)
      }
      try {
        const latestCNContent = await fs.readFileSync(
          `${latestVerPath}latest_Win_Game_CN${
            isKuroNewApi ? '_NEW' : ''
          }.json`,
          'utf-8'
        )
        latestCN = JSON.parse(latestCNContent)
      } catch (error) {
        console.error('读取本地数据失败1:', error.message)
        process.exit(2)
      }
      try {
        const latestOSContent = await fs.readFileSync(
          `${latestVerPath}latest_Win_Game_OS${
            isKuroNewApi ? '_NEW' : ''
          }.json`,
          'utf-8'
        )
        latestOS = JSON.parse(latestOSContent)
      } catch (error) {
        console.error('读取本地数据失败2:', error.message)
        process.exit(3)
      }
      let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&disable_web_page_preview=True&chat_id=`
      let gameId = ``
      if (gameName === '鸣潮') {
        if (isKuroNewApi)
          pushUrl += `${TGMsgID_WW}&text=${encodeURIComponent(
            '\\[灰度\\] ' + gameName
          )}`
        else pushUrl += `${TGMsgID_WW}&text=${encodeURIComponent(gameName)}`
        gameId = 'WW'
      } else {
        console.error('无效的游戏名:', gameName)
        process.exit(4)
      }
      // 根据传入 jsonData 判断更新类型是 REL 还是 PRE
      let type = jsonData.predownload?.version ? 'PRE' : 'REL'

      if (otherServerData) {
        // 两个服务器都更新了, 一起推送
        pushUrl += encodeURIComponent(` Win ${type} 更新！\n\n`)
        let jsonDataCN = server === 'CN' ? jsonData : otherServerData.data
        let jsonDataOS = server === 'OS' ? jsonData : otherServerData.data
        let jsonDataCNRes = {}
        let jsonDataOSRes = {}
        let jsonDataCNLast = {}
        let jsonDataOSLast = {}
        let jsonDataCNResLast = {}
        let jsonDataOSResLast = {}

        try {
          const jsonDataCNResContent = fs.readFileSync(
            `./Scripts/data/${gameId}/latest_Win_Game_CN${
              isKuroNewApi ? '_NEW' : ''
            }_Res.json`,
            'utf-8'
          )
          const jsonDataOSResContent = fs.readFileSync(
            `./Scripts/data/${gameId}/latest_Win_Game_OS${
              isKuroNewApi ? '_NEW' : ''
            }_Res.json`,
            'utf-8'
          )
          const jsonDataCNLastContent = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_CN${
              isKuroNewApi ? '_NEW' : ''
            }.json`,
            'utf-8'
          )
          const jsonDataOSLastContent = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_OS${
              isKuroNewApi ? '_NEW' : ''
            }.json`,
            'utf-8'
          )
          const jsonDataCNResLastContent = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_CN${
              isKuroNewApi ? '_NEW' : ''
            }_Res.json`,
            'utf-8'
          )
          const jsonDataOSResLastContent = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_OS${
              isKuroNewApi ? '_NEW' : ''
            }_Res.json`,
            'utf-8'
          )

          jsonDataCNRes = JSON.parse(jsonDataCNResContent)
          jsonDataOSRes = JSON.parse(jsonDataOSResContent)
          jsonDataCNLast = JSON.parse(jsonDataCNLastContent)
          jsonDataOSLast = JSON.parse(jsonDataOSLastContent)
          jsonDataCNResLast = JSON.parse(jsonDataCNResLastContent)
          jsonDataOSResLast = JSON.parse(jsonDataOSResLastContent)

          // 如果是预下载版本，使用predownload的数据
          if (type === 'PRE') {
            jsonDataCNRes = jsonDataCNRes.predownload || jsonDataCNRes
            jsonDataOSRes = jsonDataOSRes.predownload || jsonDataOSRes
            jsonDataCN = {
              default: jsonDataCN.predownload || jsonDataCN.default,
            }
            jsonDataOS = {
              default: jsonDataOS.predownload || jsonDataOS.default,
            }
            jsonDataCNLast = { default: jsonDataCNLast.default }
            jsonDataOSLast = { default: jsonDataOSLast.default }
          }

          if (
            jsonDataCN?.default?.version === jsonDataOS?.default?.version &&
            jsonDataCNLast?.default?.version ===
              jsonDataOSLast?.default?.version
          ) {
            pushUrl += encodeURIComponent(
              `版本: ${
                jsonDataCNLast.default.version
                  ? `\`${jsonDataCNLast.default.version}\` \\=\\> `
                  : ''
              }\`${jsonDataCN.default.version}\`\n`
            )
          } else {
            pushUrl += encodeURIComponent(
              `CN 版本: ${
                jsonDataCNLast.default.version
                  ? `\`${jsonDataCNLast.default.version}\` \\=\\> `
                  : ''
              }\`${jsonDataCN.default.version}\`\nOS 版本: ${
                jsonDataOSLast.default.version
                  ? `\`${jsonDataOSLast.default.version}\` \\=\\> `
                  : ''
              }\`${jsonDataOS.default.version}\`\n`
            )
          }

          if (
            jsonDataCNRes.resource.length === jsonDataOSRes.resource.length &&
            jsonDataCNResLast.resource.length ===
              jsonDataOSResLast.resource.length
          ) {
            pushUrl += encodeURIComponent(
              `文件数: ${
                Array.isArray(jsonDataCNResLast?.resource)
                  ? `\`${jsonDataCNResLast.resource.length}\` \\=\\> `
                  : ''
              }\`${jsonDataCNRes.resource.length}\`\n`
            )
          } else {
            pushUrl += encodeURIComponent(
              `CN 文件数: ${
                Array.isArray(jsonDataCNResLast?.resource)
                  ? `\`${jsonDataCNResLast.resource.length}\` \\=\\> `
                  : ''
              }\`${jsonDataCNRes.resource.length}\`\nOS 文件数: ${
                Array.isArray(jsonDataOSResLast?.resource)
                  ? `\`${jsonDataOSResLast.resource.length}\` \\=\\> `
                  : ''
              }\`${jsonDataOSRes.resource.length}\`\n`
            )
          }

          // 计算大小
          let lastSizeCN = 0
          let lastSizeOS = 0
          let sizeCN = 0
          let sizeOS = 0
          let updateSizeCN = 0
          let updateSizeOS = 0
          if (Array.isArray(jsonDataCNResLast?.resource)) {
            for (let i = 0; i < jsonDataCNResLast.resource.length; i++) {
              lastSizeCN += jsonDataCNResLast.resource[i].size
            }
          }
          if (Array.isArray(jsonDataOSResLast?.resource)) {
            for (let i = 0; i < jsonDataOSResLast.resource.length; i++) {
              lastSizeOS += jsonDataOSResLast.resource[i].size
            }
          }
          for (let i = 0; i < jsonDataCNRes.resource.length; i++) {
            sizeCN += jsonDataCNRes.resource[i].size
          }
          for (let i = 0; i < jsonDataOSRes.resource.length; i++) {
            sizeOS += jsonDataOSRes.resource[i].size
          }
          // 使用 jsonDataCN.default.config.patchConfig 数组中 version==jsonDataCNLast.default.version 的 size 作为更新大小
          if (Array.isArray(jsonDataCN.default.config.patchConfig)) {
            let patchConfigCN = jsonDataCN.default.config.patchConfig.find(
              (item) => item.version === jsonDataCNLast.default.version
            )
            if (patchConfigCN) {
              updateSizeCN = patchConfigCN.size
            }
          }
          if (Array.isArray(jsonDataOS.default.config.patchConfig)) {
            let patchConfigOS = jsonDataOS.default.config.patchConfig.find(
              (item) => item.version === jsonDataOSLast.default.version
            )
            if (patchConfigOS) {
              updateSizeOS = patchConfigOS.size
            }
          }
          if (lastSizeCN === lastSizeOS && sizeCN === sizeOS && updateSizeCN === updateSizeOS) {
            pushUrl += encodeURIComponent(
              `大小: ${
                lastSizeCN ? `\`${formatBytes(lastSizeCN)}\` \\=\\> ` : ''
              }\`${formatBytes(sizeCN)}\` \\(UP:\`${formatBytes(updateSizeCN)}\`\\)\n`
            )
          } else {
            pushUrl += encodeURIComponent(
              `CN 大小: ${
                lastSizeCN ? `\`${formatBytes(lastSizeCN)}\` \\=\\> ` : ''
              }\`${formatBytes(sizeCN)}\` \\(UP:\`${formatBytes(updateSizeCN)}\`\\)\nOS 大小: ${
                lastSizeOS ? `\`${formatBytes(lastSizeOS)}\` \\=\\> ` : ''
              }\`${formatBytes(sizeOS)}\` \\(UP:\`${formatBytes(updateSizeOS)}\`\\)\n`
            )
          }

          if (
            jsonDataCN?.default?.changelog?.['zh-Hans'] ===
            jsonDataOS?.default?.changelog?.['zh-Hans']
          ) {
            pushUrl += encodeURIComponent(
              `更新日志: \n\`\`\`${
                jsonDataCN.default.changelog['zh-Hans']
                  ? jsonDataCN.default.changelog['zh-Hans']
                  : '暂无'
              }\`\`\`\n`
            )
          } else {
            pushUrl += encodeURIComponent(
              `CN 更新日志: \n\`\`\`${
                jsonDataCN.default.changelog['zh-Hans']
                  ? jsonDataCN.default.changelog['zh-Hans']
                  : '暂无'
              }\`\`\`\nOS 更新日志: \n\`\`\`${
                jsonDataOS.default.changelog
                  ? jsonDataOS.default.changelog['zh-Hans']
                  : '暂无'
              }\`\`\`\n`
            )
          }
        } catch (error) {
          console.error('读取本地数据失败3:', error.message)
          process.exit(5)
        }
      } else {
        pushUrl += encodeURIComponent(
          ` Win ${server.replace('_NEW', '')} REL 更新！\n\n`
        )
        let jsonData = {}
        let jsonDataRes = {}
        let jsonDataLast = {}
        let jsonDataResLast = {}
        //console.log('filePath:', `./Win/Game/${server}/${getLatestJsonFileName(`./Win/Game/${server}/`)}`)
        try {
          // 获取 /win/Game/CN 和 OS 目录下最新的 .json 作为传入的文件名
          const jsonDataContent = fs.readFileSync(
            `./${gameId}/Win/Game/${server}/${getLatestJsonFileName(
              `./${gameId}/Win/Game/${server}/`
            )}`,
            'utf-8'
          )
          const jsonDataContentRes = fs.readFileSync(
            `./Scripts/data/${gameId}/latest_Win_Game_${server}_Res.json`
          )
          const jsonDataContentLast = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_${server}.json`
          )
          const jsonDataContentResLast = fs.readFileSync(
            `./Scripts/data/${gameId}/last_Win_Game_${server}_Res.json`
          )
          jsonData = JSON.parse(jsonDataContent)
          jsonDataRes = JSON.parse(jsonDataContentRes)
          jsonDataLast = JSON.parse(jsonDataContentLast)
          jsonDataResLast = JSON.parse(jsonDataContentResLast)
          //console.log('读取本地数据:', jsonDataContent);
          pushUrl += encodeURIComponent(
            `版本: ${
              jsonDataLast.default.version
                ? `\`${jsonDataLast.default.version}\` \\=\\> `
                : ''
            }\`${jsonData.default.version}\`\n`
          )
          pushUrl += encodeURIComponent(
            `文件数: ${
              Array.isArray(jsonDataResLast?.resource)
                ? `\`${jsonDataResLast.resource.length}\` \\=\\> `
                : ''
            }\`${jsonDataRes.resource.length}\`\n`
          )
          // 计算大小
          let lastSize = 0
          let size = 0
          if (Array.isArray(jsonDataResLast?.resource)) {
            for (let i = 0; i < jsonDataResLast.resource.length; i++) {
              lastSize += jsonDataResLast.resource[i].size
            }
          }
          for (let i = 0; i < jsonDataRes.resource.length; i++) {
            size += jsonDataRes.resource[i].size
          }
          pushUrl += encodeURIComponent(
            `大小: ${
              lastSize ? `\`${formatBytes(lastSize)}\` \\=\\> ` : ''
            }\`${formatBytes(size)}\`\n`
          )
          pushUrl += encodeURIComponent(
            `更新日志: \n\`\`\`${
              jsonData.default.changelog['zh-Hans']
                ? jsonData.default.changelog['zh-Hans']
                : '暂无'
            }\`\`\`\n`
          )
        } catch (error) {
          console.error('读取本地数据失败4:', error.message)
          process.exit(6)
        }
      }

      pushUrl += encodeURIComponent(
        `\n\\*文件数和大小仅计算本体\n_via [@WutheringWavesVersion](https://t.me/WutheringWavesVersion)_`
      )

      console.log('推送地址:', pushUrl)
      let rsp = await fetch(pushUrl)
      if (!rsp.ok) {
        console.log(
          '推送请求失败:',
          rsp.status,
          rsp.statusText,
          await rsp.text()
        )
        process.exit(7)
      }

      // console.log(JSON.stringify(await rsp.json()))
      let pushJsonData = await rsp.json()
      console.log('推送结果:', pushJsonData)
      process.exit(0)
    }

    // 米哈游游戏的解析
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
      console.error('读取本地数据失败5:', error.message)
      process.exit(8)
    }
    try {
      const latestOSContent = await fs.readFileSync(
        `${latestVerPath}latest_Win_Game_OS.json`,
        'utf-8'
      )
      latestOS = JSON.parse(latestOSContent)
    } catch (error) {
      console.error('读取本地数据失败6:', error.message)
      process.exit(9)
    }
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&disable_web_page_preview=True&chat_id=`
    let gameId = ``
    if (gameName === '原神') {
      pushUrl += `${TGMsgID_GI}&text=${encodeURIComponent(gameName)}`
      gameId = 'GI'
    } else if (gameName === '崩坏星穹铁道') {
      pushUrl += `${TGMsgID_SR}&text=${encodeURIComponent(gameName)}`
      gameId = 'SR'
    } else {
      console.error('无效的游戏名:', gameName)
      process.exit(10)
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
      process.exit(11)
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
        console.error('读取本地数据失败7:', error.message)
        process.exit(12)
      }
      //console.log('jsonData:', jsonData)
      //console.log('updateType:', updateType)
      let linkData = {
        ...(updateType === 'REL'
          ? jsonData.data.game_packages[0].main
          : jsonData.data.game_packages[0].pre_download),
      }
      //console.log('linkData:', linkData)

      if (linkType === 'full') {
        let fullLink = '本体: '
        let fullSize = '大小: '
        if (linkData.major.game_pkgs.length === 1) {
          //完整包
          fullLink += `[完整包](${escapeCharacters(
            linkData.major.game_pkgs[0].url
          )}) \\| `
          fullSize += `${formatBytes(linkData.major.game_pkgs[0].size)} \\| `
        } else {
          // 分卷包
          fullLink += `分卷 `
          for (let i = 0; i < linkData.major.game_pkgs.length; i++) {
            fullLink += `[${i + 1}](${escapeCharacters(
              linkData.major.game_pkgs[i].url
            )}) \\| `
          }
          // 分卷计算总大小
          fullSize += `${formatBytes(
            Number(10737418240 * (linkData.major.game_pkgs.length - 1)) +
              Number(
                linkData.major.game_pkgs[linkData.major.game_pkgs.length - 1]
                  .size
              )
          )} \\| `
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
          fullSize += `${formatBytes(voiceDataCN.size)}\\|`
          voiceData = voiceData.filter((item) => item.language !== 'zh-cn')
        }
        if (voiceDataTW) {
          voiceLink += `[繁](${escapeCharacters(voiceDataTW.url)})\\|`
          fullSize += `${formatBytes(voiceDataTW.size)}\\|`
          voiceData = voiceData.filter((item) => item.language !== 'zh-tw')
        }
        if (voiceDataJP) {
          voiceLink += `[日](${escapeCharacters(voiceDataJP.url)})\\|`
          fullSize += `${formatBytes(voiceDataJP.size)}\\|`
          voiceData = voiceData.filter((item) => item.language !== 'ja-jp')
        }
        if (voiceDataEN) {
          voiceLink += `[英](${escapeCharacters(voiceDataEN.url)})\\|`
          fullSize += `${formatBytes(voiceDataEN.size)}\\|`
          voiceData = voiceData.filter((item) => item.language !== 'en-us')
        }
        if (voiceDataKR) {
          voiceLink += `[韩](${escapeCharacters(voiceDataKR.url)})\\|`
          fullSize += `${formatBytes(voiceDataKR.size)}\\|`
          voiceData = voiceData.filter((item) => item.language !== 'ko-kr')
        }
        // 处理剩余的语音包
        for (let i = 0; i < voiceData.length; i++) {
          voiceLink += `[${escapeCharacters(
            voiceData[i].language
          )}](${escapeCharacters(voiceData[i].url)})\\|`
          fullSize += `${formatBytes(voiceData[i].size)}\\|`
        }
        // 去掉最后一个 |
        voiceLink = voiceLink.slice(0, -2) + '\n'
        fullSize = fullSize.slice(0, -2) + '\n'

        return encodeURIComponent(fullLink + voiceLink + fullSize)
      } else {
        //最烦人的差分包
        // 读取 linkData.patches 数组中成员的 version 作为名字
        let diffLink = ''
        for (let i = 0; i < linkData.patches.length; i++) {
          let diffSize = '          '
          diffLink += `${escapeCharacters(
            linkData.patches[i].version
          )}\\-${escapeCharacters(linkData.major.version)}: `
          if (linkData.patches[i].game_pkgs.length === 1) {
            //完整包
            diffLink += `[本体](${escapeCharacters(
              linkData.patches[i].game_pkgs[0].url
            )}) \\| `
            diffSize += `${formatBytes(
              linkData.patches[i].game_pkgs[0].size
            )} \\| `
          } else {
            // 分卷包
            diffLink += `本体: 分卷 `
            for (let i = 0; i < linkData.patches[i].game_pkgs.length; i++) {
              diffLink += `[${i + 1}](${escapeCharacters(
                linkData.patches[i].game_pkgs[i].url
              )}) \\| `
            }
            // 分卷计算总大小
            diffSize += `${formatBytes(
              Number(10737418240 * (linkData.patches[i].game_pkgs.length - 1)) +
                Number(
                  linkData.patches[i].game_pkgs[
                    linkData.patches[i].game_pkgs.length - 1
                  ].size
                )
            )} \\| `
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
            diffSize += `${formatBytes(voiceDataCN.size)}\\|`
            voiceData = voiceData.filter((item) => item.language !== 'zh-cn')
          }
          if (voiceDataTW) {
            diffLink += `[繁](${escapeCharacters(voiceDataTW.url)})\\|`
            diffSize += `${formatBytes(voiceDataTW.size)}\\|`
            voiceData = voiceData.filter((item) => item.language !== 'zh-tw')
          }
          if (voiceDataJP) {
            diffLink += `[日](${escapeCharacters(voiceDataJP.url)})\\|`
            diffSize += `${formatBytes(voiceDataJP.size)}\\|`
            voiceData = voiceData.filter((item) => item.language !== 'ja-jp')
          }
          if (voiceDataEN) {
            diffLink += `[英](${escapeCharacters(voiceDataEN.url)})\\|`
            diffSize += `${formatBytes(voiceDataEN.size)}\\|`
            voiceData = voiceData.filter((item) => item.language !== 'en-us')
          }
          if (voiceDataKR) {
            diffLink += `[韩](${escapeCharacters(voiceDataKR.url)})\\|`
            diffSize += `${formatBytes(voiceDataKR.size)}\\|`
            voiceData = voiceData.filter((item) => item.language !== 'ko-kr')
          }
          // 处理剩余的语音包
          for (let j = 0; j < voiceData.length; j++) {
            diffLink += `[${escapeCharacters(
              voiceData[j].language
            )}](${escapeCharacters(voiceData[j].url)})\\|`
            diffSize += `${formatBytes(voiceData[j].size)}\\|`
          }
          // 去掉最后一个 |
          diffLink = diffLink.slice(0, -2) + '\n' + diffSize.slice(0, -2) + '\n'
        }
        return encodeURIComponent(diffLink)
      }

      return ''
    }

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
  }

  async pushWinLauncher(
    gameName,
    server,
    link,
    isKuroGame = false,
    isKuroNewApi = false
  ) {
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&disable_web_page_preview=True&chat_id=`

    // 库洛游戏的解析
    if (isKuroGame) {
      console.log('link:', JSON.stringify(link))
      server = server.replace('_NEW', '') // 灰度这里用 _NEW 标识要删掉否则会被认为是标识符
      if (gameName === '鸣潮') pushUrl += `${TGMsgID_WW}&text=`
      else {
        console.error('无效的游戏名:', gameName)
        process.exit(14)
      }
      if (isKuroNewApi) {
        pushUrl += encodeURIComponent(
          `\\[灰度\\] ${gameName} Win ${server} Launcher 更新！\n\n`
        )
      } else {
        pushUrl += encodeURIComponent(
          `${gameName} Win ${server} Launcher 更新！\n\n`
        )
      }
      pushUrl += `版本: ${
        link.old.version
          ? `[${escapeCharacters(link.old.version)}](${escapeCharacters(
              link.old.url
            )}) \\=\\> `
          : ''
      }[${escapeCharacters(link.new.version)}](${escapeCharacters(
        link.new.url
      )})%0A`
      pushUrl += `大小: ${
        link.old.size ? `\`${formatBytes(link.old.size)}\` \\=\\> ` : ''
      }\`${formatBytes(link.new.size)}\`%0A`
      pushUrl += `更新日志: \`${escapeCharacters(
        link.changelog ?? '暂无'
      )}\`%0A`
      pushUrl += encodeURIComponent(
        `\n_via [@WutheringWavesVersion](https://t.me/WutheringWavesVersion)_`
      )

      console.log('推送地址:', pushUrl)
      let rsp = await fetch(pushUrl)
      if (!rsp.ok) {
        console.log(
          '推送请求失败:',
          rsp.status,
          rsp.statusText,
          await rsp.text()
        )
        process.exit(15)
      }

      // console.log(JSON.stringify(await rsp.json()))
      let pushJsonData = await rsp.json()
      console.log('推送结果:', pushJsonData)
      process.exit(0)
    }

    // 米哈游游戏的解析
    if (gameName === '原神') pushUrl += `${TGMsgID_GI}&text=`
    else pushUrl += `${TGMsgID_SR}&text=`
    pushUrl += encodeURIComponent(
      `${gameName} Win ${server} Launcher 更新！\n\n`
    )
    pushUrl += `链接: [${escapeCharacters(link)}](${escapeCharacters(link)})`
    pushUrl +=
      gameName === '原神'
        ? encodeURIComponent(
            `\n\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`
          )
        : encodeURIComponent(
            `\n\n_via [@StarRailVersion](https://t.me/StarRailVersion)_`
          )

    console.log('推送地址:', pushUrl)
    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.error(
        '推送请求失败:',
        rsp.status,
        rsp.statusText,
        await rsp.text()
      )
      process.exit(16)
    }

    // console.log(JSON.stringify(await rsp.json()))
    let pushJsonData = await rsp.json()
    console.log('推送结果:', pushJsonData)
  }

  async pushAndroidGame(gameName, server, link) {
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&disable_web_page_preview=True&chat_id=`
    switch (gameName) {
      case '原神':
        pushUrl += `${TGMsgID_GI}&text=`
        break
      case '崩坏星穹铁道':
        pushUrl += `${TGMsgID_SR}&text=`
        break
      case '鸣潮':
        pushUrl += `${TGMsgID_WW}&text=`
        break
      default:
        console.error('无效的游戏名:', gameName)
        process.exit(17)
    }
    pushUrl += encodeURIComponent(
      `${gameName} Android ${server} Game 更新！\n\n`
    )
    pushUrl += `链接: [${escapeCharacters(link)}](${escapeCharacters(link)})%0A`
    switch (gameName) {
      case '原神':
        pushUrl += encodeURIComponent(
          `\n_via [@GenshinVersion](https://t.me/GenshinVersion)_`
        )
        break
      case '崩坏星穹铁道':
        pushUrl += encodeURIComponent(
          `\n_via [@StarRailVersion](https://t.me/StarRailVersion)_`
        )
        break
      case '鸣潮':
        pushUrl += encodeURIComponent(
          `\n_via [@WutheringWavesVersion](https://t.me/WutheringWavesVersion)_`
        )
        break
      default:
        console.error('无效的游戏名:', gameName)
        process.exit(17)
    }

    console.log('推送地址:', pushUrl)
    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
      console.error(
        '推送请求失败:',
        rsp.status,
        rsp.statusText,
        await rsp.text()
      )
      process.exit(17)
    }

    // console.log(JSON.stringify(await rsp.json()))
    let pushJsonData = await rsp.json()
    console.log('推送结果:', pushJsonData)
  }
}

function escapeCharacters(inputString) {
  if (!inputString) inputString = ''
  // 定义需要转义的字符集合
  var charactersToEscape = /[_*\[\]()~`>#\+\-=|{}.!]/g

  // 使用replace方法进行转义
  var escapedString = inputString.replace(charactersToEscape, '\\$&')

  return escapedString
}

// 把传入的单位为 B 的数字格式化成可读的 K, M, G 形式, 保留三位有效数字, 转义并返回
function formatBytes(bytes, decimals = 3) {
  console.log('bytes:', bytes)
  if (bytes === 0) return escapeCharacters('0B')

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['B', 'K', 'M', 'G', 'T']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return escapeCharacters(
    parseFloat((bytes / Math.pow(k, i)).toPrecision(dm)) + sizes[i]
  )
}

// 直接实例化 Push 类并默认导出
export default new Push()
