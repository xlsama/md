# Changelog

## 0.1.11

工作区读不到时不再假装成空目录：daemon 上报读取与监听是否可用，`md <path>` 会重启一个失去了工作区访问权的 daemon（macOS 上 `~/Downloads`、`~/Documents`、`~/Desktop` 的授权会随时间失效），页面也会说清楚是「读不到」还是「监听不了」/ A workspace it cannot read no longer reads as an empty one: the daemon reports whether it can list and watch the root, `md <path>` restarts a daemon that has lost access to it (on macOS the grants for `~/Downloads`, `~/Documents` and `~/Desktop` expire), and the page says which of the two failed.

## 0.1.7

设置面板不再用工具名当标题，粘贴时转存图片默认关闭，自动保存延迟默认 100ms / Settings rows are named by what they do rather than by the tool behind them; importing pasted remote images is now off by default and the autosave delay defaults to 100ms.

## 0.1.4

移除 0.1.3 的配置目录迁移逻辑 / Dropped the config directory migration added in 0.1.3.

## 0.1.3

新增 `md config` 打印配置文件路径与内容，配置目录由 `~/.config/writedown` 改为 `~/.config/md`（旧文件自动搬迁），CLI 帮助改为英文 / Added `md config` to print the settings file path and contents, moved the config directory from `~/.config/writedown` to `~/.config/md` (existing files migrate automatically), and switched the CLI help to English.

## 0.1.2

开机自启支持 Linux（systemd）与 Windows（计划任务），`md service plist` 更名 `md service config` / Start-at-login now covers Linux (systemd) and Windows (Task Scheduler); `md service plist` is renamed to `md service config`.

## 0.1.1

包名改为 `@xlsama/md`，仓库迁至 `xlsama/md` / Renamed the package to `@xlsama/md` and the repo to `xlsama/md`.

## 0.1.0

首个版本发布 / Initial release.
