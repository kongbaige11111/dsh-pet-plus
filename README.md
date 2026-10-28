# dsh-pet-plus 🐾💬

给 [dsh-pet](https://www.npmjs.com/package/dsh-pet) 加的增强包：**在 QQ 里跟你的桌宠聊天**，顺手把养成、提醒和互动全补上。

> 依赖：已安装 `dsh-pet`（0.3.x）。本插件只通过 dsh-pet 自己的 HTTP 路由（`/dsh-pet-7340/chat|broadcast|anim|menu/*`）调用，
> 不改它的任何文件，所以 dsh-pet 升级不会把这层打坏；没装 dsh-pet 时它静默降级，不报错。

## 它加的四件事

| 能力 | 说明 |
| --- | --- |
| **QQ 互通** | 通过 NapCat / OneBot 11 收发消息。QQ 私聊或群里 @ 机器人 → 走桌宠**同一个人设 + 同一份记忆**生成回复 → 同时出现在 QQ 和宠物头顶气泡。QQ 里也能直接下指令。 |
| **好感度养成** | 亲密度、饥饿度、每日签到，全部落盘在 `$DSH_HOME/dsh-pet-plus/state.json`。摸摸 / 喂食会播对应动画，升级有专属台词。 |
| **定时提醒** | 喝水 45 分钟、久坐 60 分钟，可加番茄钟；到点桌宠说话 + 播动画，可选同步推到 QQ。支持免打扰时段（默认 23:30–08:00）。 |
| **互动与音效** | 桌宠右键菜单多出「摸摸 / 喂食 / 状态」；浏览器端在摸摸、喂食、提醒、升级时播一声合成提示音（不需要音频素材）。 |

## 安装

```sh
# 桌面应用：设置 → 插件 → 安装，填 dsh-pet-plus
# dsh web：
dsh plugin --profile <你的 profile> add dsh-pet-plus
```

装完重开 DSH。设置里会多出 **设置 → 插件 → 桌宠增强** 一页。

## 接入 QQ（NapCat）

1. 装 [NapCat](https://napcat.napcatqq.com/)（QQ 官方客户端 + NapCat 注入，或用 Docker 版），用一个**小号**扫码登录。
2. NapCat 的 **网络配置** 里开两样：
   - **HTTP 服务器**：监听 `3000`（或任意端口），记下 token（没设就留空）。
   - **HTTP 上报（HTTP POST）**：地址填
     `http://127.0.0.1:61030/dsh-pet-plus/qq/event`（端口换成你 DSH 实际端口，见启动日志里的 Web GUI URL）。
     如果设置了上报 token，就在地址后加 `?token=你的上报token`，并把它填进本插件设置页的「Access Token」下方那一项（`inboundToken`）。
3. 打开 **设置 → 插件 → 桌宠增强**：
   - 勾选「启用 QQ 互通」
   - API 地址：`http://127.0.0.1:3000`（NapCat 的 HTTP 服务器）
   - Access Token：NapCat 的 token
   - 机器人 QQ 号：刚登录的那个号
   - 允许私聊的 QQ：留空 = 任何人，建议填自己的大号
   - 允许的群号：留空 = 不响应群聊；填了群号才会进群
   - 群里必须 @ 才回应：默认开
4. 点「测试连接」，显示 `连接成功：昵称（QQ号）` 就成了。QQ 里私聊发一句「在吗」试试。

## QQ 里的指令

直接说话就是聊天；下面这些是指令：

```
摸摸          摸一下（+2 亲密度，45 秒冷却）
喂食 [食物]    喂东西（+6 亲密度、+35 饱食，5 分钟冷却）
好感          看亲密度 / 等级 / 饥饿度 / 连签
签到          每日签到（连签越多加得越多）
提醒          看定时提醒和下次时间
帮助          指令列表
```

## 在 DSH 里的斜杠命令

DSH 的命令名只接受 `/^[a-z][a-z0-9_-]*$/`（小写字母开头），所以这里用英文短名，描述是中文：

| 命令 | 作用 |
| --- | --- |
| `/pat` | 摸摸（+亲密度） |
| `/feed [食物]` | 喂食（+亲密度、+饱食） |
| `/raise` | 看亲密度 / 等级 / 饥饿度 / 连签 |
| `/remind` | 看定时提醒和下次时间 |
| `/qq` | 探一次 NapCat 连接状态 |

QQ 里那套中文指令（摸摸 / 喂食 / 好感 / 签到 / 提醒 / 帮助）不受影响，仍然是中文关键词。

## 配置

所有设置都在 **设置 → 插件 → 桌宠增强**，存到 `$DSH_HOME/dsh-pet-plus/config.json`，改完点「保存设置」即时生效，不用重启。
关键字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `petId` | `main` | 用哪只宠物（多开时填它的 id） |
| `qq.enabled` | `false` | QQ 互通总开关 |
| `qq.apiBase` | `http://127.0.0.1:3000` | NapCat 的 HTTP API |
| `qq.allowedUsers` | `[]` | 允许私聊的 QQ 号；空 = 不限 |
| `qq.allowedGroups` | `[]` | 允许的群号；空 = 不响应群聊 |
| `qq.groupRequireAt` | `true` | 群里必须 @ |
| `qq.maxReplyChars` | `500` | 回复截断长度 |
| `affection.patCooldownSec` | `45` | 摸摸冷却 |
| `affection.feedCooldownSec` | `300` | 喂食冷却 |
| `affection.hungerDecayPerHour` | `8` | 每小时掉多少饱食度 |
| `reminders.list` | 喝水 / 久坐 | 每项：`label`、`everyMin`、`text`、`anim`、`enabled`、`pushToQQ` |
| `reminders.quiet` | 23:30–08:00 | 免打扰时段 |
| `sound` | `true` | 浏览器端提示音 |

## 已知限制

- QQ 回复目前**只发文字**：表情包（`/chat` 返回的 `image`）暂未转发，因为图片 URL 是 localhost，跨进程取图行为依赖 NapCat 的实现。
- 一个 QQ 号一台机器：同一份配置只对接一个 NapCat 实例。
- 宠物 `display` 为 `desktop` 时，浏览器端没有宠物本体，但提示音和设置页照常工作；想让网页里也看到宠物，把 `pets[].display` 改成 `both`。

## License

MIT
