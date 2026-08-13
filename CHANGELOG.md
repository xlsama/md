# Changelog

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
