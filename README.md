# dsh-desktop — DeepSeek Harness 桌面版

把 [dsh](https://github.com/deepseek-ai/deepseek-harness) 的本地 Web 界面包装成原生桌面应用（macOS / Windows）。
启动即用：应用自动完成后端安装、启动与升级，无需浏览器、终端或手动配置。

## 特性

- **开箱即用**：无需安装 Node 或其他依赖，应用自带运行环境，首次启动自动安装 dsh 核心（约 1-2 分钟）。
- **自动热更新**：dsh 上游发布新版本后，应用在后台自动升级核心并重启，无需重新下载安装包。
- **配置共享**：与终端版 `dsh` 使用同一份配置和会话（`~/.dsh`），两边可无缝衔接。
- **跨平台**：支持 macOS（arm64 / x64）与 Windows（x64 / arm64）。

## 环境要求

- macOS 12+ 或 Windows 10+
- 仅开发/构建时需要 Node.js `^22.19.0 || >=24.0.0`

## 安装

从 [Releases](https://github.com/rye567/dsh-desktop/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|---|---|
| macOS Apple Silicon | `*.arm64.dmg` |
| macOS Intel | `*.x64.dmg`（取自 universal 包） |
| Windows x64 | `* Setup *.exe` |

> 因当前未做代码签名：macOS 首次打开需**右键 → 打开**绕过 Gatekeeper；
> Windows 首次运行如遇 SmartScreen 拦截，点「仍要运行」。

## 开发

```bash
npm install
npm run dev        # 开发模式，首次启动会自动安装 dsh 核心
```

## 构建

```bash
npm run dist            # macOS 安装包（zip + dmg，当前机器架构）
npm run dist:universal  # macOS 通用包（x64 + arm64）
npm run dist:win        # Windows x64（NSIS 安装包 + zip）
npm run dist:win:arm64  # Windows ARM64
npm run dist:dir        # 仅产出 .app 目录，用于本地快速验证
```

## 发布

打 `v*` tag 推送后，GitHub Actions 会在 macOS runner 上自动构建并发布到 GitHub Release。
发布源已在 `package.json` 与 `electron/app-updater.mjs` 中配置为 `rye567/dsh-desktop`。
