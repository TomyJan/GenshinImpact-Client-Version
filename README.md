# GenshinImpact-Client-Version

记录和推送鸣潮、原神和崩坏星穹铁道游戏客户端、启动器和资源包版本信息更新。

## 获取更新推送

最推荐的使用方式是直接订阅我们的 Telegram 频道：

- 鸣潮：[@WutheringWavesVersion](https://t.me/WutheringWavesVersion)
- 原神：[@GenshinVersion](https://t.me/GenshinVersion)
- 崩坏星穹铁道：[@StarRailVersion](https://t.me/StarRailVersion)

## 查看版本记录

也可以直接查看仓库中的版本记录目录：

- `GI/`：原神版本记录 4.2 至今
- `SR/`：崩坏星穹铁道版本记录 1.5 至今
- `WW/`：鸣潮版本记录 1.0 至今

目录结构大致如下：

- `Android/Game/`：Android 客户端版本信息
- `Win/Game/`：Windows 客户端版本信息
- `Win/Launcher/`：Windows 启动器版本信息
- `CN`：国服 / 简中服
- `OS`：国际服
- `*_NEW`：部分游戏的灰度、新接口或新资源记录

每个版本文件通常是接口返回内容的整理或存档，适合用来追踪版本号、下载地址、资源包变化等信息。

## 脚本目录

- `Scripts/`：版本检测、数据保存和推送脚本
- `.github/workflows/`：自动更新工作流

## 本地运行脚本

一般用户不需要本地运行脚本；如果你想自行部署或调试，可以参考下面的命令。

安装依赖：

```bash
pnpm install
```

检测原神或崩坏星穹铁道：

```bash
node ./Scripts/getWinGameVersion.js gi cn
node ./Scripts/getWinLauncherVersion.js sr os
node ./Scripts/getAndroidGameVersion.js gi
```

检测鸣潮：

```bash
node ./Scripts/getWWWinGameVersion.js cn
node ./Scripts/getWWWinLauncherVersion.js os
node ./Scripts/getAndroidGameVersion.js ww
```

参数说明：

- 游戏：`gi`、`sr`、`ww`
- 服务器：`cn`、`os`

## 自行配置 Telegram 推送

如需在自己的 Fork 中启用 Telegram 推送，请配置以下环境变量或 GitHub Actions Secrets：

- `TGBotToken`
- `TGMsgID`
- `TGMsgID_GI`
- `TGMsgID_SR`
- `TGMsgID_WW`

其中 `TGMsgID_GI`、`TGMsgID_SR`、`TGMsgID_WW` 为可选项，用于给不同游戏配置不同的推送目标。

## 其他说明

本仓库仅整理公开接口返回的版本信息，主要用于版本追踪和更新提醒。

部分资源存档可以从 [TomyJan 镜像站](https://mirror.tomys.top/189Cloud/%E8%BD%AF%E4%BB%B6/Games) 获取。

代码是闭着眼睛用脚踩出来的，能跑就行。不要看，以免吓死你，也不要以此为由喷我。

## License

[MPL-2.0](./LICENSE)
