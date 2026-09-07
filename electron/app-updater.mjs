// L1 壳更新检查。
// 说明：未购买 Apple Developer ID 时，macOS 不允许未签名 app 被自动覆盖
// 安装（electron-updater 在 mac 上强制要求签名），因此降级为“检查 GitHub
// Release → 弹窗提示 → 跳转下载”。日常使用主要靠 L2 核心热更新，壳更新
// 极少发生。后续若补充签名+公证，可直接替换为 electron-updater 静默更新。
import { app, dialog, shell, BrowserWindow } from 'electron';
import semver from 'semver';

// 发布源写死为代码常量：electron-builder 打包会剥离 package.json 的
// build 字段，运行时读不到，故不能从 package.json 取。
const GITHUB_OWNER = 'rye567';
const GITHUB_REPO = 'dsh-desktop';

const INITIAL_DELAY_MS = 10_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function checkAppUpdate() {
  await sleep(INITIAL_DELAY_MS);
  for (;;) {
    try {
      await checkOnce();
    } catch { /* 检查失败静默跳过，下周期重试 */ }
    await sleep(INTERVAL_MS);
  }
}

async function checkOnce() {
  if (GITHUB_OWNER === 'YOUR_GITHUB_OWNER') return; // 未配置发布源则跳过

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
    { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'dsh-desktop' } });
  if (!res.ok) return;
  const release = await res.json();
  const latest = (release.tag_name ?? '').replace(/^v/, '');
  if (!semver.valid(latest) || !semver.gt(latest, app.getVersion())) return;

  // macOS 关窗不退出、activate 会重建窗口，不能捕获启动时的窗口引用。
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '桌面壳有新版本',
    message: `发现新版本 v${latest}（当前 v${app.getVersion()}）`,
    detail: '壳更新频率很低，日常功能更新由核心热更新自动完成。是否前往下载？',
    buttons: ['前往下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await shell.openExternal(release.html_url);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
