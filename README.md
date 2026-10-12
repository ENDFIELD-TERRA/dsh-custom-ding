# DSH Custom Ding

为 DeepSeek Harness 提供按场景自定义的提示音、音量滑动条和可选的系统弹窗通知。

[English](README.en.md) · [设置说明](docs/custom-settings.md)

四种提示场景默认共用 [HAMA-SUSHI.wav](sounds/HAMA-SUSHI.wav)，也可以在设置页分别换成自己的音频。普通问答保持安静。

| 场景 | 触发时机 |
| --- | --- |
| 计划出方案 | 主对话回合结束，且仍处于计划模式 |
| 任务完成 | 主对话回合结束，且调用过执行类工具 |
| 需要你回应 | 提问或审批请求 |
| 出错 | 主对话回合发生错误 |

同一场景默认间隔至少 2.5 秒；子任务完成不会单独播放提示音。

## 安装

需要已安装 DSH。先通过 Git 克隆本仓库，再从本地目录安装；如仓库有访问限制，请先配置具备权限的 GitHub 认证。以下命令可用于 PowerShell、Bash 或 zsh：

```sh
git clone https://github.com/ENDFIELD-TERRA/dsh-custom-ding.git
cd dsh-custom-ding
dsh plugin --profile web add "$(pwd)"
dsh web restart
```

重启后打开 **设置 → 提示音与通知**。

插件使用 DSH bundle 入口。只有标准组件接口、没有 DSH 产品服务的宿主无法运行提示音功能。安装包名为 `dsh-custom-ding`，与原佩丽卡插件拥有独立的插件标识、设置页、接口和存储，可以同时安装；同时启用时，两者各自发送提示。

从安装名为 `dsh-perlica-ding` 的版本切换时，请重新安装本仓库，并确认插件列表显示 `dsh-custom-ding`。新插件不读取旧插件设置，首次安装需重新设置音量、导入自定义音效并开启弹窗；旧插件的设置与文件仍保留。

## 提示音与音量

- 四个场景默认播放同一个 HAMA-SUSHI 音效。内置文件为 44.1 kHz、立体声、16 位 PCM WAV，时长约 4.64 秒。
- 每个场景都可以选择文件、试听、恢复默认。可导入 WAV、MP3 及浏览器支持解码的其他音频，最长 30 秒、最大 12 MB。
- 音量通过 0–100% 滑动条调节，也提供预设档位。设置自动保存，0% 为静音；保存失败会显示错误并恢复上次保存的值。
- 「恢复默认」移除该场景上传的音频。未配置其他音效目录、当前会话目录也没有同名覆盖文件时，使用内置 HAMA-SUSHI。

上传的音频在浏览器中转换为 PCM WAV，保存在运行 DSH 的电脑上，重启后仍有效。详细查找顺序和存储位置见[设置说明](docs/custom-settings.md)。

## 系统弹窗通知

**默认关闭**。在设置页开启后，可用「测试通知」检查。弹窗与音量独立，音量为 0 时仍可提醒；插件总开关关闭时，声音和弹窗都停止。

| 平台 | 声音播放 | 系统通知 |
| --- | --- | --- |
| Windows | Windows PowerShell / SoundPlayer | 系统 Toast |
| macOS | 系统自带的 `afplay` | AppleScript 通知中心 |
| Linux | `paplay` 或 `aplay` | `notify-send`，缺失时使用 `gdbus` |

通知显示在 **DSH 宿主所在的电脑**，受系统通知权限、勿扰模式和桌面会话限制。Linux 需要桌面通知服务及对应的 D-Bus 会话。发送超时或失败时会报错；发送命令成功不等于通知一定已在屏幕上弹出。

## 高级配置

在 profile 的 `cordis.patch.yml` 用户配置层中，按插件 ID 设置：

```yaml
- id: dsh-custom-ding
  name: dsh-custom-ding
  config:
    enabled: true
    volume: 100
    debounceMs: 2500
    soundDir: ""
```

`volume` 是尚未保存音量时的起始值，之后以设置页保存值为准。`soundDir` 可指定包含 `plan.wav`、`done.wav`、`ask.wav`、`fail.wav` 的覆盖目录；这些是自定义文件名，包内默认音效只有 HAMA-SUSHI。`execTools` 可自定义执行类工具白名单，设为空数组时所有工具都计为执行。

## 开发验证

需要 Node.js 22.15 或更高版本。先安装锁定的测试依赖，再运行验证：

```sh
npm ci --ignore-scripts
npm run verify
```

测试覆盖真实宿主事件分发、同一回合的补充消息、审批处理顺序、计划状态读取、插件并存、音量、音效导入与恢复、持久化及平台通知失败处理。安装后的声音效果与桌面通知可通过设置页的试听和测试按钮确认。

## 许可证

代码使用 [MIT 许可证](LICENSE)。本项目基于 [dsh-perlica-ding](https://github.com/ENDFIELD-TERRA/dsh-perlica-ding) 开发。
