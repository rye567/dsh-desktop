// L2 核心热更新：上游 @deepseek-ai/dsh 发布新版后，桌面壳无需重新构建，
// 后台 npm 升级 userData 里的核心并重启后端进程，页面自动重载即完成更新。
import semver from 'semver';
import { CORE_PACKAGE } from './backend.mjs';

/** 启动后延迟检查的间隔：避免与首轮启动争抢 IO。 */
const INITIAL_DELAY_MS = 15_000;
/** 周期性复查间隔（默认 6 小时）。 */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * @param {import('./backend.mjs').DshBackend} backend
 * @param {(text: string) => void} onStatus
 */
export async function checkCoreUpdate(backend, onStatus) {
  await sleep(INITIAL_DELAY_MS);
  for (;;) {
    try {
      await checkOnce(backend, onStatus);
    } catch (err) {
      // 更新失败（断网、registry 异常等）不影响使用，下个周期再试。
      backend.emit('log', `核心更新检查失败：${err?.message ?? err}`);
    }
    await sleep(INTERVAL_MS);
  }
}

async function checkOnce(backend, onStatus) {
  const current = backend.installedVersion();
  if (!current) return;

  // 版本探测走 npm view（与安装同一 npm 配置/镜像源），避免「探测到新版
  // 却因镜像滞后装不上」导致的反复空升级。
  const latest = await backend.latestVersion();

  if (!semver.valid(latest) || !semver.valid(current)) return;
  // 预发布通道（如 0.1.2-rc.1 → 0.1.2-rc.2）同样纳入比较。
  if (!semver.gt(latest, current, { includePrerelease: true })) return;

  onStatus(`发现 dsh 核心新版本 ${latest}（当前 ${current}），正在后台升级…`);
  await backend.installCore(`${CORE_PACKAGE}@${latest}`);
  onStatus('核心升级完成，正在重启后端…');
  try {
    await backend.restart();
  } catch (err) {
    // 升级成功但重启失败：不能让后端停在停止态（GUI 变死页），
    // 立即尝试拉起一次；仍失败则交给崩溃自愈/用户重启。
    backend.emit('log', `热更新重启失败：${err?.message ?? err}，尝试直接拉起…`);
    await backend.start();
  }
  onStatus(`已升级到 ${latest}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
