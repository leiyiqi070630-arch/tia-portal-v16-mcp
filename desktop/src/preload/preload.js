'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('consoleAPI', {
  getState: () => ipcRenderer.invoke('console:get-state'),
  setDays: (days) => ipcRenderer.invoke('console:set-days', days),
  startService: () => ipcRenderer.invoke('console:start'),
  stopService: () => ipcRenderer.invoke('console:stop'),
  openLogDir: () => ipcRenderer.invoke('console:open-log-dir'),
  getSettings: () => ipcRenderer.invoke('console:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('console:save-settings', settings),
  getTemplateInfo: () => ipcRenderer.invoke('console:get-template-info'),
  pickTemplate: () => ipcRenderer.invoke('console:pick-template'),
  openTemplate: () => ipcRenderer.invoke('console:open-template'),
  readTemplate: () => ipcRenderer.invoke('console:read-template'),
  getKnowledgeBaseInfo: () => ipcRenderer.invoke('console:get-knowledge-base-info'),
  pickKnowledgeBase: () => ipcRenderer.invoke('console:pick-knowledge-base'),
  openKnowledgeBase: () => ipcRenderer.invoke('console:open-knowledge-base'),
  copyEndpoint: () => ipcRenderer.invoke('console:copy-endpoint'),
  copyMcpConfig: () => ipcRenderer.invoke('console:copy-mcp-config'),
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onSnapshot: (callback) => subscribe('console:snapshot', callback),
  onServiceState: (callback) => subscribe('console:service-state', callback),
  onWindowState: (callback) => subscribe('window:state', callback),
});
