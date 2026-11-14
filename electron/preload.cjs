// Runs in the sandboxed window. Exposes only these few desktop actions to the page.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  info: () => ipcRenderer.invoke('app-info'),
  onFolderChanged: (callback) => {
    const listener = (_event, dir) => callback(dir)
    ipcRenderer.on('folder-changed', listener)
    return () => ipcRenderer.removeListener('folder-changed', listener)
  },
})
