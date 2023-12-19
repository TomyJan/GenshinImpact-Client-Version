const TGBotToken = process.env.TGBotToken;
const TGMsgID = process.env.TGMsgID;

class Push {

    constructor() {
      // 在构造函数中进行实例化的其他初始化工作
    }
  
    pushWinGame() {
      // 实现 pushWinGame 方法的逻辑
      console.log('准备推送 Win Game 更新, bot token:', TGBotToken, ' , msg id:', TGMsgID);
      // 可以在这里添加推送游戏的具体操作
    }
  }
  
  // 直接实例化 Push 类并默认导出
  export default new Push();
  