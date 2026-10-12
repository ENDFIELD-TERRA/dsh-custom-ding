# 自定义提示音与弹窗通知

在 DSH 的「设置 → 提示音与通知」中调整。安装或更新插件后需重启 DSH。

四个场景共用内置的 `HAMA-SUSHI.wav`，时长约 4.64 秒，格式为 44.1 kHz、立体声、16 位 PCM WAV。每个场景仍可单独上传其他提示音。

## 音量

拖动 0–100% 滑动条，或使用预设档位。松开滑块、离开控件或停止拖动后自动保存；试听会等待当前音量保存完成。0% 表示静音。保存失败时显示错误并恢复上一次保存的值。

## 自定义提示音

「计划出方案」「任务完成」「需要你回应」「出错」分别支持选择本地音频、试听和恢复默认。

- 可导入 WAV、MP3 及浏览器支持解码的其他音频，最长 30 秒、原文件最大 12 MB。
- 音频在浏览器中转换为 PCM WAV，再传给运行 DSH 的宿主。文件与设置仅保存在该宿主，不会上传到第三方服务。
- 上传成功后立即生效，重启后仍保留。上传或保存失败不会替换当前音效。
- 恢复默认会移除该场景上传的音频。随后依次查找配置的音效目录、当前会话目录、内置 `HAMA-SUSHI.wav` 和系统音效；没有目录覆盖时即使用 HAMA-SUSHI。

自定义文件保存在 `$DSH_HOME/dsh-perlica-ding/sounds/`，文件名由音频内容生成。未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`。音量沿用插件原有存储；新增设置使用同目录下的 `preferences.json`。损坏的设置文件会另存保留，然后使用默认值。

## 弹窗通知

默认关闭。开启后，主对话计划就绪、任务完成、需要回应或出错时请求系统通知。普通问答与子任务完成不会额外产生通知；同类事件沿用配置的防抖间隔。

弹窗与音量独立，静音时也可提醒；插件的总开关关闭时两者均停用。单独试听音效不会发送弹窗。「测试通知」可用于检查系统通知服务。

通知显示在运行 DSH 的电脑上，远程浏览器不会收到本地电脑的系统通知。支持以下桌面平台：

| 平台 | 发送方式 | 运行条件 |
| --- | --- | --- |
| Windows | 系统 Toast 通知 | 使用已注册的 DSH 应用身份；没有桌面版时使用已注册的 Windows PowerShell 身份。系统目录从环境读取，支持系统安装在其他盘符。 |
| macOS | 系统自带的 AppleScript 通知 | 通过 `osascript` 发送至通知中心，需在桌面会话中运行并允许相关应用通知。 |
| Linux | freedesktop 桌面通知 | 优先使用 `notify-send`；缺少该命令时使用 `gdbus`。需有桌面通知服务并能连接对应的 D-Bus 会话，适用于实现该协议的 GNOME、KDE、Xfce 等桌面。 |

通知进程超时、被终止、缺少发送工具或通知服务不可用时会报告错误。「测试通知」成功仅表示发送命令正常完成，不保证通知已显示在屏幕上。系统权限、勿扰模式、无桌面的服务会话及未配置桌面通知服务的 WSL 环境都可能阻止弹出；插件不会绕过系统设置，也不会自动安装系统工具。

平台机制参考：[Apple 通知脚本指南](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/DisplayNotifications.html)、[freedesktop 通知协议](https://specifications.freedesktop.org/notification/latest/protocol.html)、[gdbus 命令手册](https://manpages.debian.org/bookworm/libglib2.0-bin/gdbus.1.en.html)。

卸载插件不会删除保存的音效和设置。需要完全移除时，可在停止 DSH 后删除上述插件状态目录；该目录也可能包含原有的音量存档。
