const TGBotToken = process.env.TGBotToken
const TGMsgID = process.env.TGMsgID

class Push {
  constructor() {
    // 在构造函数中进行实例化的其他初始化工作
  }

  async pushWinGame(server, jsonData) {
    // 实现 pushWinGame 方法的逻辑
    console.log(
      '准备推送 Win Game 更新, bot token:',
      TGBotToken,
      ' , msg id:',
      TGMsgID
    )
    let type = jsonData.data.pre_download_game.latest.version ? 'PRE' : 'REL'
    // 可以在这里添加推送游戏的具体操作
    let pushUrl = `https://api.telegram.org/bot${TGBotToken}/sendMessage?parse_mode=MarkdownV2&chat_id=${TGMsgID}&text=`
    pushUrl += encodeURIComponent(`原神 Win ${server} ${type === 'REL' ? escapeCharacters(jsonData.data.game.latest.version) : escapeCharacters(jsonData.data.pre_download_game.latest.version)} ${type} 更新！\n`)
    pushUrl += encodeURIComponent(`完整包: \n`)
    pushUrl += encodeURIComponent(`[本体](${jsonData.data.pre_download_game.latest.version ? jsonData.data.pre_download_game.latest.segments[0].path : jsonData.data.game.latest.segments[0].path})\\|`)
    pushUrl += encodeURIComponent(`[中文语音](${jsonData.data.pre_download_game.latest.version ? escapeCharacters(jsonData.data.pre_download_game.latest.voice_packs[0].path) : escapeCharacters(jsonData.data.game.latest.voice_packs[0].path)})\\|`)
    pushUrl += encodeURIComponent(`[日文语音](${jsonData.data.pre_download_game.latest.version ? escapeCharacters(jsonData.data.pre_download_game.latest.voice_packs[2].path) : escapeCharacters(jsonData.data.game.latest.voice_packs[2].path)})\\|`)
    pushUrl += encodeURIComponent(`[英文语音](${jsonData.data.pre_download_game.latest.version ? escapeCharacters(jsonData.data.pre_download_game.latest.voice_packs[1].path) : escapeCharacters(jsonData.data.game.latest.voice_packs[1].path)})\\|`)
    pushUrl += encodeURIComponent(`[韩文语音](${jsonData.data.pre_download_game.latest.version ? escapeCharacters(jsonData.data.pre_download_game.latest.voice_packs[3].path) : escapeCharacters(jsonData.data.game.latest.voice_packs[3].path)})`)
    pushUrl += encodeURIComponent(`\n\n本体为分卷, 共有 ${jsonData.data.pre_download_game.latest.version ? jsonData.data.pre_download_game.latest.segments.length : jsonData.data.game.latest.segments.length} 个包, 请自行修改后缀\n`)
    pushUrl += encodeURIComponent(`\\#预下载 \\#predownload _via [@GenshinVersion](https://t.me/GenshinVersion)_\n`)

    console.log('推送地址:', pushUrl)

    let rsp = await fetch(pushUrl)
    if (!rsp.ok) {
        console.log('推送请求失败:', rsp.status, rsp.statusText)
        return false
      }
  
      // console.log(JSON.stringify(await rsp.json()))
      let pushJsonData = await rsp.json()
      console.log('推送结果:', pushJsonData)


      function escapeCharacters(inputString) {
        // 定义需要转义的字符集合
        var charactersToEscape = /[_*\[\]()~`>#\+\-=|{}.!]/g;
      
        // 使用replace方法进行转义
        var escapedString = inputString.replace(charactersToEscape, '\\$&');
      
        return escapedString;
      }     

  }
}

// 直接实例化 Push 类并默认导出
export default new Push()
