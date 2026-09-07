// dsh-desktop 主进程入口。
// 职责：单实例锁 → 显示加载页 → 确保 dsh 核心已安装 → 启动后端 → 加载 GUI
//      → 后台执行 L1（壳）/L2（dsh 核心）两级更新检查。
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshBackend } from './backend.mjs';
import { checkCoreUpdate } from './core-updater.mjs';
import { checkAppUpdate } from './app-updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 后端默认宿主：与 `dsh web` 行为一致，仅监听回环地址。 */
const HOST = '127.0.0.1';

// Windows 任务栏图标分组与通知依赖 AppUserModelId，需与 appId 一致；
// 在 macOS 上调用无副作用。
app.setAppUserModelId('ai.deepseek.dsh-desktop');

let win = null;
let backend = null;

// npm CLI 路径：打包后 npm 被 asarUnpack，需指向 app.asar.unpacked。
function resolveNpmCli() {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : app.getAppPath();
  return path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function sendStatus(text) {
  if (win && !win.isDestroyed()) win.webContents.send('boot-status', text);
}

async function boot() {
  backend = new DshBackend({
    runtimeDir: path.join(app.getPath('userData'), 'dsh-runtime'),
    npmCli: resolveNpmCli(),
    host: HOST,
    onStatus: sendStatus,
  });

  sendStatus('检查 dsh 核心…');
  await backend.ensureInstalled();

  sendStatus('启动 dsh 后端…');
  // dsh web 打印的 URL 携带启动令牌（首访换取登录 Cookie），必须加载它。
  const { url } = await backend.start();
  await win.loadURL(url);

  // 后端重启（核心热更新后）→ 加载新的带令牌 URL。
  backend.on('restarted', ({ url: newUrl }) => {
    if (win && !win.isDestroyed()) win.loadURL(newUrl);
  });

  // 后端异常退出 → 延迟自动拉起一次，避免壳变成死窗口。
  backend.on('crashed', (code) => {
    sendStatus(`后端异常退出（退出码 ${code}），3 秒后自动重启…`);
    setTimeout(async () => {
      try {
        const { url: recoveredUrl } = await backend.start();
        if (win && !win.isDestroyed()) win.loadURL(recoveredUrl);
      } catch (err) {
        sendStatus(`后端重启失败：${err?.message ?? err}`);
      }
    }, 3000);
  });

  // 两级更新均在后台进行，不阻塞 GUI 可用。
  void checkCoreUpdate(backend, sendStatus);
  void checkAppUpdate();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // GUI 由本地回环后端提供；保持默认隔离即可。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 外部链接交给系统浏览器，不跳出桌面壳。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://${HOST}:`)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'loading.html'));
}

// macOS 惯例：单实例，重复启动聚焦已有窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    // 开发模式下 Electron 默认用自身图标；显式设置 Dock 图标保持与打包后一致。
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
    }
    ipcMain.handle('get-backend-info', () => backend?.info() ?? null);
    createWindow();
    void boot().catch((err) => sendStatus(`启动失败：${err?.message ?? err}`));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // macOS 惯例：关窗不退出；显式 Cmd+Q 才退出并回收后端。
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出时必须先等后端子进程回收完毕（SIGTERM → 超时升级 SIGKILL），
  // 否则主进程先退、后端变孤儿。preventDefault 打断首次退出，收尸后再退。
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting || !backend) return;
    quitting = true;
    event.preventDefault();
    void backend.stop().finally(() => app.quit());
  });
}
