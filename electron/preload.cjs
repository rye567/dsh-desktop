// preload（CJS）：沙箱渲染进程的 preload 不支持 ESM，必须用 CommonJS。
// 只暴露启动状态通道给加载页，不开放 Node 能力。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshShell', {
  onBootStatus: (cb) => ipcRenderer.on('boot-status', (_e, text) => cb(text)),
  getBackendInfo: () => ipcRenderer.invoke('get-backend-info'),
});
