// electron-builder afterPack 钩子：保证 macOS 产物代码签名封印完整。
//
// 背景：`identity: null` 移除后，本机构建会自动用钥匙串里的证书签名；
// 但 CI（GitHub runner）没有任何证书，electron-builder 直接跳过签名，
// 产物只剩主程序链接器签名、包封印残缺。这种包一旦被浏览器下载带上
// quarantine 隔离属性，Gatekeeper 报误导性的「文件已损坏」且右键打开
// 无效（Apple Silicon 必须有完整封印）。
//
// 策略：封印已有效（真实证书或此前已 ad-hoc）则跳过；否则用 ad-hoc
//（`-s -`）重签整个 .app，让 Gatekeeper 退回「无法验证开发者」软拦截，
// 用户可通过右键打开或系统设置放行。
const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  try {
    execSync(`codesign --verify --deep ${JSON.stringify(appPath)}`, { stdio: 'ignore' });
    return; // 封印已完整（本机证书签名等），不覆盖
  } catch {
    // 封印缺失/损坏 → 补 ad-hoc 签名
  }
  console.log(`  • ad-hoc signing (no valid seal): ${appPath}`);
  execSync(`codesign --force --deep -s - ${JSON.stringify(appPath)}`, { stdio: 'inherit' });
};
