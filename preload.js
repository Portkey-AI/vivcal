const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  closeReminderWindow: (eventId) => ipcRenderer.send('close-reminder', eventId),
  openLink: (url, eventId) => ipcRenderer.send('open-link', url, eventId),
  addQuickEvent: (text) => ipcRenderer.send('quick-add-event', text),
  openQuickAdd: () => ipcRenderer.send('open-quick-add'),
  searchContacts: (query) => ipcRenderer.invoke('search-contacts', query),
  snoozeReminder: (eventId, minutes) => ipcRenderer.send('snooze-reminder', eventId, minutes),
  onUpdateContent: (callback) => ipcRenderer.on('update-content', (event, title, link, id) => callback(title, link, id))
});

// Add electronAPI for window operations
contextBridge.exposeInMainWorld('electronAPI', {
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', width, height)
});
