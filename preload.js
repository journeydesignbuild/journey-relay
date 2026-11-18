const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getDefaults: () => ipcRenderer.invoke('settings:defaults'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  clipRead: () => ipcRenderer.invoke('clip:read'),
  clipWrite: (t) => ipcRenderer.invoke('clip:write', t),
  call: (body) => ipcRenderer.invoke('claude:call', body),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  info: () => ipcRenderer.invoke('app:info'),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (o) => ipcRenderer.invoke('sessions:save', o),
  newWindow: () => ipcRenderer.invoke('window:new'),
  hostFocus: () => ipcRenderer.invoke('host:focus'),
  driveInfo: () => ipcRenderer.invoke('drive:info'),
  driveList: () => ipcRenderer.invoke('drive:list'),
  driveMove: (o) => ipcRenderer.invoke('drive:move', o),
  host: () => ipcRenderer.invoke('app:host'),
  statusUpdate: (st) => ipcRenderer.invoke('status:update', st),
  driveSave: (o) => ipcRenderer.invoke('drive:save', o),
  driveOpen: (folder) => ipcRenderer.invoke('drive:open', folder),
  pane: (i, method, args) => ipcRenderer.invoke('pane:call', i, method, args),
  onPaneEvent: (fn) => ipcRenderer.on('pane:event', (_e, d) => fn(d))
});
