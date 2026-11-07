/* 纸间 · 预加载桥：把主进程能力以最小面暴露给页面 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('PJDesktop', {
  /** WebDAV 请求：{ method, url, headersJson, bodyB64 } → { status, headers, body } 或 { error } */
  davRequest: (payload) => ipcRenderer.invoke('pj:dav', payload),
  /** 运行环境信息 */
  info: () => ipcRenderer.invoke('pj:info'),
  isDesktop: true
});
