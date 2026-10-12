# DSH Custom Ding

Customizable task sounds, a volume slider, and optional desktop notifications for DeepSeek Harness.

[简体中文](README.md) · [Settings guide (Chinese)](docs/custom-settings.md)

All four notification scenes share [HAMA-SUSHI.wav](sounds/HAMA-SUSHI.wav) by default. You can replace each scene's sound independently in settings. Ordinary conversation stays quiet.

| Scene | Trigger |
| --- | --- |
| Plan ready | The main conversation turn ends while plan mode is active |
| Task complete | The main conversation turn ends after using execution tools |
| Your response needed | A question or approval request |
| Error | An error occurs in the main conversation turn |

Repeated events of the same kind are spaced at least 2.5 seconds apart by default. Completing a background task does not produce a separate sound.

## Installation

Install DSH, clone this repository, then install from the local directory. Configure GitHub credentials if repository access is restricted. These commands work in PowerShell, Bash, or zsh:

```sh
git clone https://github.com/ENDFIELD-TERRA/dsh-custom-ding.git
cd dsh-custom-ding
dsh plugin --profile web add "$(pwd)"
dsh web restart
```

After restarting, open **Settings → 提示音与通知** (Sounds and notifications).

Installation uses the DSH bundle entry. A host that offers only standard component interfaces without DSH product services cannot run the sound feature. The package is named `dsh-custom-ding`. Its plugin identity, settings page, API, and storage are independent of the original Perlica plugin, so both can be installed together. When both are enabled, each sends its own notifications.

When switching from a version installed as `dsh-perlica-ding`, reinstall this repository and confirm that the plugin list shows `dsh-custom-ding`. The new plugin does not read the old plugin's settings. Set the volume, import custom sounds, and enable popups again after installation. The old plugin's settings and files remain available.

## Sounds and volume

- Every scene uses HAMA-SUSHI by default. The bundled clip is a 44.1 kHz, stereo, 16-bit PCM WAV lasting approximately 4.64 seconds.
- Each scene supports file selection, preview, and reset. Import WAV, MP3, or another format the browser can decode, up to 30 seconds and 12 MB.
- Adjust volume with the 0–100% slider or a preset. Settings save automatically; 0% mutes audio. Failed saves display an error and restore the last saved value.
- Reset removes the uploaded sound for that scene. The bundled HAMA-SUSHI clip plays when neither the configured sound directory nor the conversation workspace contains a matching override.

The browser converts uploads to PCM WAV. Audio files are stored on the computer running DSH and survive restarts. See the [settings guide](docs/custom-settings.md) for lookup priority and storage locations.

## Desktop notifications

**Off by default.** Enable the switch in settings, then use the test button. Desktop notifications work independently of sound volume, including at 0%. Turning off the plugin's master switch stops both sounds and popups.

| Platform | Audio playback | Desktop notifications |
| --- | --- | --- |
| Windows | Windows PowerShell / SoundPlayer | System Toast |
| macOS | Built-in `afplay` | AppleScript Notification Center |
| Linux | `paplay` or `aplay` | `notify-send`, with `gdbus` when it is missing |

Notifications appear on the **computer hosting DSH**. System permissions, Focus or Do Not Disturb settings, and desktop-session availability affect display. Linux requires a notification service and its D-Bus session. Timeouts and failed sends produce errors; successful command completion does not guarantee an onscreen popup.

## Advanced configuration

Configure the plugin by ID in the profile's user `cordis.patch.yml` layer:

```yaml
- id: dsh-custom-ding
  name: dsh-custom-ding
  config:
    enabled: true
    volume: 100
    debounceMs: 2500
    soundDir: ""
```

`volume` supplies the initial value when no volume has been saved. Saved settings take precedence afterward. `soundDir` can point to overrides named `plan.wav`, `done.wav`, `ask.wav`, and `fail.wav`; these names are for custom files, while HAMA-SUSHI is the only bundled default. `execTools` customizes the execution-tool allowlist. An empty array counts every tool as execution.

## Development checks

Use Node.js 22.15 or newer. Install the locked test dependencies before running verification:

```sh
npm ci --ignore-scripts
npm run verify
```

Tests cover the real host event dispatcher, same-turn follow-up messages, approval ordering, plan state, plugin coexistence, volume, sound import and reset, persistence, and platform notification failures. Use the settings page's preview and notification test buttons to check the installed experience.

## License

Code is licensed under [MIT](LICENSE). This project is based on [dsh-perlica-ding](https://github.com/ENDFIELD-TERRA/dsh-perlica-ding).
