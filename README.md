# dsh-qq-kit

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面端用的一组 QQ 扩展插件：让一个 QQ 小号变成能聊、能发表情、能发说说、能主动找你、还能在你批准下操作电脑的机器人。

全部按 [OneBot 11](https://github.com/botuniverse/onebot-11) 标准走，通过 [NapCat](https://github.com/NapNeko/NapCatQQ) 的 HTTP/WebSocket 接口工作，不依赖 AstrBot、不往系统里塞乱七八糟的东西。

## 包含什么

| 插件 | 干什么 | 用到什么 |
| --- | --- | --- |
| `dsh-qq-meme` | 表情包：按标签挑图发送，提示词只对 QQ 会话生效 | NapCat HTTP |
| `dsh-qq-profile` | 改签名、昵称、头像、在线状态 | NapCat HTTP |
| `dsh-qq-qzone` | 发 QQ 空间说说、看自己/好友的说说 | NapCat 取 cookies + 空间网页接口 |
| `dsh-qq-proactive` | 主动找你：定时用模型现写一句，而不是背模板 | 宿主 gateway + NapCat |
| `dsh-qq-exec` | 让你用大号指挥小号读写文件、跑命令，**每次改动前必须在大号里回 `/allow` 批准** | 宿主 gateway + NapCat |
| `dsh-doubao-tts` | 火山引擎豆包语音合成（TTS 2.0 / Seed-Audio 1.0），要求语音回复时用 | 火山引擎 OpenSpeech |

## 前置条件

- DSH 桌面端（Electron 版），`dsh` 命令可用（脚本默认找 `D:\tools\DeepSeekharness\resources\runtime\cli\bin\dsh.cmd`，找不到会在 PATH 里找 `dsh`）
- 一个 QQ 小号 + [NapCat](https://github.com/NapNeko/NapCatQQ)（Shell 版），已登录并开启 OneBot 11 的 HTTP 服务端
- `dsh-onebot-qq` 插件（`dsh plugin add dsh-onebot-qq`），补丁按 **0.9.6** 写的
- 可选：`ffmpeg`（TTS 需要调音量/限幅时用）

## 这次更新了什么

- `dsh-qq-meme`：修掉「插件静默加载失败」——`package.json` 里多一个 `exports` 字段会让整个模块注册不上，现在改成动态导入并把失败原因打到控制台；提示词只注入 QQ 会话，桌面端不会再莫名其妙往 QQ 发图
- `dsh-qq-exec`：审批改成 QQ 里回 **`/allow 编号`**（走宿主命令通道），「允许」这条不会再被当成普通消息喂给模型、也不会再重复弹审批
- `patches/onebot-qq`：给 `dsh-onebot-qq` 打的四个补丁
  - 长回复自动拆条：换行即断，单条超过 55 字再按标点续切，最多 8 条，条间停顿 280–620ms
  - `/allow`、`/deny` 转发给宿主插件注册的命令
  - 语音先转写再派发（避免先回「听不到」、几秒后又补一句）
  - 排队提示静默，不再刷「稍等」之类
- `dsh-doubao-tts`：合成后可按 `gainDb` 增益、`limit` 限幅、`loudnessTarget` 响度归一化（seed-tts-2.0 与 seed-audio 都走同一套）

补丁会覆盖 `dsh-onebot-qq` 里的同名文件，首次覆盖前留 `*.upstream.js` 备份，想回滚直接改回来即可。

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本会依次问：主号 QQ、小号 QQ、NapCat HTTP token、数据目录（默认 `D:\DSH-Data`）、NapCat 目录，然后：

1. 把这些值写进各插件的 `cordis.patch.yml`（替换 `@ADMIN_QQ@`、`@NAPCAT_TOKEN@`、`@DSH_DATA@` 等占位符）
2. 建好数据目录（`persona`、`qq\memes`、`qq\media`、`speech\doubao`、`speech`、`tools`、`memory`）
3. 依次执行 `dsh plugin --profile desktop add <插件目录>`
4. 给已装的 `dsh-onebot-qq` 打补丁，并把语音转写钩子放到 `<数据目录>\tools\`、写一份 `<数据目录>\speech\qq-native.json`

第 4 步要是提示找不到 `dsh-onebot-qq`，先把 onebot 插件装好，再 `.\install.ps1 -SkipAdd` 跑一次补丁。

也可以带参数静默安装：

```powershell
.\install.ps1 -AdminQQ 123456 -BotQQ 10001 -NapCatToken abc123 -DshData 'D:\DSH-Data'
```

装完还要做两件事：

1. 人设：把 `examples/persona.example.md` 拷到 `<数据目录>\persona\` 并改成你的样子
2. 豆包语音：把 `examples/doubao-settings.example.json` 拷到 `<数据目录>\speech\doubao\settings.json`，填 `appId` + `accessToken`（新版控制台可只填 `apiKey`）

最后**重启 DSH 桌面端**。

## 配置在哪

每个插件的配置都在它自己目录下的 `cordis.patch.yml`，`dsh plugin add` 时会自动合并进 profile 的 patch 文件。

常改的几项：

- `dsh-qq-exec`：`adminQQ`（谁有审批权）、`dataRoot`（读写根目录）、`timeoutSec`（审批等多久）
- `dsh-qq-proactive`：`minGapMinutes` / `maxGapMinutes`（间隔范围）、`activeHours`（几点到几点发）、`target`
- `dsh-qq-meme`：`memesDir`（表情库，一级子目录名就是标签）
- `dsh-doubao-tts`：配置在 `speech/doubao/settings.json`，不在 yml 里

## QQ 里的用法

- 普通聊天：直接发消息，小号按人设回
- 发表情：小号自己判断，或直接说「发个表情」
- 改资料：`/setqqprofile` 相关工具由模型调用，说「把签名改成 xxx」即可
- 说说：说「发条说说：xxx」，发之前它会先问
- 主动消息：到点它自己发，不用管
- 操作电脑：主号说「在 D:\xxx 下建个 a.txt」，小号会回一条审批号，**主号回 `/allow 编号`** 才会真执行，超时作废

## 安全说明

- 所有凭据（NapCat token、豆包 appId/token）都只写在本机的 `cordis.patch.yml` / `settings.json` 里，本仓库只放占位符
- 仓库里没有任何 QQ 号、token、本机绝对路径；`install.ps1` 装的时候才填
- `dsh-qq-exec` 默认只读操作不审批，**写/删/执行命令一律要主号批准**，且只有 `adminQQ` 能批

## 已知限制

- 依赖 NapCat，QQ 客户端版本升级有可能影响富媒体（语音/图片）发送
- QQ 空间接口靠 cookies，掉登录后需要重扫
- `dsh-qq-exec` 的审批回复走宿主斜杠命令，**需要本仓库的 `patches/onebot-qq` 补丁**（`dsh-onebot-qq` 0.9.6 本身不转发宿主命令）
- 补丁按 `dsh-onebot-qq` 0.9.6 写的，升级插件后需要重新打
- 只在 Windows + PowerShell 5.1 上验证过

## 许可

MIT，见 [LICENSE](LICENSE)。
