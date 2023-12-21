const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  closeReminderWindow: (eventId) => ipcRenderer.send('close-reminder', eventId),
  openLink: (url, eventId) => ipcRenderer.send('open-link', url, eventId)
});
