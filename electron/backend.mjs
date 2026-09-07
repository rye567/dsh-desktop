// dsh 后端生命周期管理。
// 核心安装在 userData/dsh-runtime（npm --prefix），由 Electron 内置的
// Node 运行时（ELECTRON_RUN_AS_NODE=1）执行，无需用户安装 Node。
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** dsh 核心包名：上游每次发布即触发本壳的 L2 热更新。 */
export const CORE_PACKAGE = '@deepseek-ai/dsh';

/** npm 源：默认国内镜像（npmmirror），探测与安装走同一源保证版本收敛。
 *  出境网络良好时可改回 https://registry.npmjs.org。 */
const NPM_REGISTRY = 'https://registry.npmmirror.com';

/** npm 单次操作的最长容忍时间（安装/升级受网络影响，给足余量）。 */
const NPM_TIMEOUT_MS = 15 * 60 * 1000;

export class DshBackend extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.runtimeDir 核心运行时安装目录（userData 下）
   * @param {string} opts.npmCli    npm-cli.js 的绝对路径
   * @param {string} opts.host      监听地址（回环）
   * @param {(text: string) => void} [opts.onStatus] 启动/更新状态回调
   */
  constructor({ runtimeDir, npmCli, host, onStatus, nodeBin }) {
    super();
    this.runtimeDir = runtimeDir;
    this.npmCli = npmCli;
    this.host = host;
    this.onStatus = onStatus ?? (() => {});
    // Node 运行时：默认用 Electron 主进程自身（ELECTRON_RUN_AS_NODE 模式），
    // 测试时可注入其他 Node/Electron 二进制。
    this.nodeBin = nodeBin ?? process.execPath;
    this.child = null;
    this.port = null;
    this.url = null;
    this.stopping = false;
    // 生命周期串行锁：start/stop/restart 必须互斥，否则崩溃自愈与
    // 热更新并发时会产生两个后端进程，其一引用被覆盖成为孤儿。
    this._op = Promise.resolve();
  }

  get binPath() {
    return path.join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }

  /** 已安装核心版本；未安装返回 null。 */
  installedVersion() {
    try {
      const pkg = JSON.parse(fs.readFileSync(
        path.join(this.runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      return pkg.version ?? null;
    } catch {
      return null;
    }
  }

  info() {
    return { version: this.installedVersion(), port: this.port, runtimeDir: this.runtimeDir };
  }

  /** 首次运行：安装 dsh 核心（纯 JS 依赖，无需本地编译工具链）。 */
  async ensureInstalled() {
    if (fs.existsSync(this.binPath)) return;
    this.onStatus('首次运行，正在安装 dsh 核心（约 1-2 分钟）…');
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    await this.runNpm(['install', `${CORE_PACKAGE}@latest`, '--prefix', this.runtimeDir,
      '--registry', NPM_REGISTRY, '--no-audit', '--no-fund', '--loglevel=error']);
    if (!fs.existsSync(this.binPath)) {
      throw new Error('dsh 核心安装失败：未找到入口文件');
    }
  }

  /** 升级核心到指定（或最新）版本，供 L2 热更新调用。 */
  async installCore(spec = `${CORE_PACKAGE}@latest`) {
    await this.runNpm(['install', spec, '--prefix', this.runtimeDir,
      '--registry', NPM_REGISTRY, '--no-audit', '--no-fund', '--loglevel=error']);
  }

  /**
   * 查询 npm 源上的最新核心版本。
   * 注意：刻意走 npm CLI（`npm view`）而非直接 fetch registry URL，
   * 且与安装共用 NPM_REGISTRY，保证探测源与安装源一致、版本收敛。
   */
  async latestVersion() {
    const out = await this.runNpm(['view', CORE_PACKAGE, 'version',
      '--registry', NPM_REGISTRY], { captureStdout: true });
    return out.trim() || null;
  }

  /** 以子进程方式执行 npm；Electron 主进程自带 Node 运行时。 */
  runNpm(args, { captureStdout = false, timeoutMs = NPM_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.nodeBin, [this.npmCli, ...args], {
        // npm 缓存强制放在 userData 下：宿主机的 ~/.npm 可能因历史 sudo
        // 安装而权限异常，独立缓存目录可避免安装/热更新因此失败。
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
               npm_config_cache: path.join(this.runtimeDir, 'npm-cache') },
        // stdout 默认丢弃：pipe 而不消费在输出量大时会撑满管道造成死锁。
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      if (captureStdout) child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      // 无超时兜底：网络挂起时不能让首次安装/热更新永久卡住。
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`npm ${args[0]} 超时（${timeoutMs / 60000} 分钟）`));
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`npm ${args[0]} 失败（退出码 ${code}${signal ? `，信号 ${signal}` : ''}）：${stderr.slice(-500)}`));
      });
    });
  }

  /** 串行化生命周期操作，崩溃自愈与热更新不会并发启动两个后端。 */
  _serialize(fn) {
    const run = this._op.then(fn, fn); // 前序操作失败也继续排队
    this._op = run.catch(() => {});
    return run;
  }

  /** 启动 `dsh web --port <空闲端口> --no-open` 并等待带令牌的 GUI URL。 */
  start() {
    return this._serialize(() => this._start());
  }

  async _start() {
    this.stopping = false;
    this.port = await getFreePort(this.host);
    // --no-open：阻止 dsh 自动打开系统浏览器，GUI 只出现在壳窗口里。
    // --expose-internals：cordis-plugin-loader 的 HMR 服务要求该标志
    //（dsh 官方启动即带它）；Electron 纯 Node 模式默认不带，缺失会导致
    // 后端就绪后崩溃（profile 中挂载了 cordis-plugin-hmr 时必现）。
    const child = spawn(this.nodeBin,
      ['--expose-internals', this.binPath, 'web', '--port', String(this.port), '--no-open'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
               // V8 编译缓存：跨启动复用字节码，加快 dsh 核心（大量 JS）加载。
               NODE_COMPILE_CACHE: path.join(this.runtimeDir, 'compile-cache') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    this.child = child;
    child.on('exit', (code) => {
      // 非主动停止的异常退出：通知主进程决定是否重启。
      if (!this.stopping && this.child === child) this.emit('crashed', code);
    });
    child.stderr.on('data', (d) => this.emit('log', String(d)));
    try {
      // dsh web 就绪后在 stdout 打印 “dsh web: http://host:port/?token=xxx”，
      // 该 URL 携带启动令牌（首访换取登录 Cookie），壳必须加载它而非裸根路径。
      const urlPromise = waitForPrintedUrl(child, 60_000);
      await waitForServer(this.host, this.port, 60_000);
      this.url = await urlPromise;
    } catch (err) {
      // 启动失败必须回收子进程，否则重试会覆盖引用、留下孤儿 dsh web。
      this.child = null;
      child.kill('SIGKILL');
      throw err;
    }
    this.onStatus('就绪');
    return { port: this.port, url: this.url };
  }

  stop() {
    return this._serialize(() => this._stop());
  }

  async _stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child) await terminateChild(child, 5_000);
  }

  /** 热更新后的重启：旧进程退出 → 新端口启动 → 通知主进程加载新令牌 URL。 */
  restart() {
    return this._serialize(async () => {
      await this._stop();
      const result = await this._start();
      this.emit('restarted', result);
      return result;
    });
  }
}

/** 解析子进程 stdout 中 “dsh web: <url>” 一行的带令牌 URL。 */
function waitForPrintedUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等待 dsh web 打印带令牌 URL 超时'));
    }, timeoutMs);
    const onData = (d) => {
      buf += d;
      const m = buf.match(/^dsh web: (https?:\/\/\S+)$/m);
      if (m) {
        cleanup();
        resolve(m[1]);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
    };
    child.stdout.on('data', onData);
  });
}

/** 向系统申请一个空闲回环端口，避免与用户终端里的 `dsh web`（3080）冲突。 */
function getFreePort(host) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 轮询 HTTP 直到 dsh web 就绪（首启需装载全部插件，可能较慢）。
 *  任何 HTTP 应答（含鉴权 401）都说明服务已在监听。
 *  轮询间隔刻意取小值：间隔越长，就绪信号的平均延迟越高（实测后端
 *  约 1s 即可就绪，800ms 间隔会凭空多出最多 ~0.8s 死等时间）。 */
async function waitForServer(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
      return; // 收到任何状态码即视为就绪
    } catch { /* 尚未就绪 */ }
    if (Date.now() > deadline) throw new Error('dsh 后端启动超时');
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** 优雅终止子进程：先 SIGTERM，超时升级 SIGKILL；已退出的直接返回。 */
function terminateChild(child, timeoutMs) {
  return new Promise((resolve) => {
    // 进程在 stop 前已自行退出时，'exit' 不会再触发，必须直接放行。
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
