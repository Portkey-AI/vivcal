const { app, BrowserWindow, Tray, ipcMain, shell, screen, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

// Configure electron-log
log.transports.file.resolvePath = () => path.join(app.getPath('userData'), 'logs/main.log');
log.transports.file.level = 'info';
log.transports.console.level = 'info';

// Override console.log
console.log = log.log;

// Log some initial information
log.info('Application starting...');
log.info(`App version: ${app.getVersion()}`);
log.info(`Electron version: ${process.versions.electron}`);
log.info(`Chrome version: ${process.versions.chrome}`);
log.info(`Node version: ${process.versions.node}`);
log.info(`App path: ${app.getAppPath()}`);
log.info(`User data path: ${app.getPath('userData')}`);

// Use app.getAppPath() to get the base directory of your app
const BASE_PATH = app.getAppPath();

const TOKEN_PATH = path.join(BASE_PATH, 'token.json');
const CREDENTIALS_PATH = path.join(BASE_PATH, 'google-creds.json');
const ICON_PATH = path.join(BASE_PATH, 'icon.png');

// Read credentials
let credentials;
try {
  credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  log.info('Credentials loaded successfully');
} catch (error) {
  log.error('Error loading credentials:', error);
  app.quit();
}

let google;
try {
  const { google: googleApi } = require('googleapis');
  google = googleApi;
  log.info('Google API loaded successfully');
} catch (error) {
  log.error('Error loading Google API:', error);
}

const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

let lastDismissedEventId = null;
let updateTrayInterval;
let reminderWindow;

function showNotification(title, message, url, eventId) {
  const notification = new Notification({
    title: title,
    body: url ? "Click to join" : "No meeting link found",
    actions: [{ text: 'Join Meeting', type: 'button' }],
    closeButtonText: 'Dismiss',
    urgency: "critical"
  });

  const handleShow = () => {
    lastDismissedEventId = eventId;
  };

  const handleAction = () => {
    shell.openExternal(url);
  };

  const handleClose = () => {
    lastDismissedEventId = eventId;
  };

  const handleClick = () => {
    log.info('notif was clicked');
    shell.openExternal(url);
    lastDismissedEventId = eventId;
    notification.close();
  };

  notification.once('show', handleShow);
  notification.once('action', handleAction);
  notification.once('close', handleClose);
  notification.once('click', handleClick);

  notification.show();

  // Clean up listeners after a certain time (e.g., 1 minute)
  setTimeout(() => {
    notification.removeListener('show', handleShow);
    notification.removeListener('action', handleAction);
    notification.removeListener('close', handleClose);
    notification.removeListener('click', handleClick);
  }, 60000);
}

function createReminderWindow(eventDetails, meetingLink, eventId) {
  log.info("Creating the reminder window");
  if (reminderWindow) {
    reminderWindow.webContents.send('update-content', eventDetails, meetingLink, eventId);
    return;
  }

  const currDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = currDisplay;

  let xcoord = Math.round(workArea.x + (workArea.width - 400) / 2);

  reminderWindow = new BrowserWindow({
    width: 400,
    height: 100,
    x: xcoord,
    y: workArea.y + 30,
    alwaysOnTop: true,
    frame: false,
    focusable: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  const windowHTML = `
  <!-- HTML content remains the same -->
  `;

  reminderWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(windowHTML));
  reminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  reminderWindow.on('closed', () => {
    log.info("The reminder window was closed");
    reminderWindow = null;
  });
}

function createWindow() {
  log.info("Creating the main window");
  mainWindow = new BrowserWindow({
    width: 450,
    height: 550,
    show: false,
    frame: false,
    fullscreenable: false,
    resizable: true,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const indexPath = path.join(BASE_PATH, 'index.html');

  mainWindow.loadFile(indexPath);
  log.info(`Loading index.html from: ${indexPath}`);

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    if (mainWindow) mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function authenticate() {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.readonly']
    });

    const server = http.createServer(async (req, res) => {
      if (req.url.indexOf('/auth/google/callback') > -1) {
        const qs = new URL(req.url, `http://localhost:${7175}`).searchParams;
        res.end('Authentication successful! Please return to the app.');
        server.destroy();
        try {
          const { tokens } = await oAuth2Client.getToken(qs.get('code'));
          oAuth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          resolve(oAuth2Client);
        } catch (error) {
          console.error("Could not resolve the oAuth client");
          reject(error);
        }
      }
    }).listen(7175);

    destroyer(server);

    log.info('Opening the browser for authentication', authUrl);
    require('electron').shell.openExternal(authUrl);
  });
}

function extractMeetingLink(description) {
  if (!description) return null;

  const linkPatterns = [
    /https:\/\/[a-zA-Z0-9]+\.zoom\.us\/j\/[^\s"<>]+/,
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s]+/,
    /https:\/\/[A-Za-z0-9-.]+\.webex\.com\/[^\s]+/
  ];

  for (const pattern of linkPatterns) {
    const match = pattern.exec(description);
    if (match) return match[0];
  }

  return null;
}

function createTimeString(event) {
  const startTime = new Date(event.start.dateTime || event.start.date);
  const timeDiff = startTime - new Date();
  const minutesDiff = Math.floor(timeDiff / 60000);
  const hoursDiff = Math.floor(minutesDiff / 60);
  const minutesLeft = minutesDiff % 60;

  if (hoursDiff <= 0 && minutesLeft <= 0) return "now";

  let timeString = 'in ';
  if (hoursDiff > 0) timeString += `${hoursDiff}h `;
  if (minutesLeft > 0 && hoursDiff < 1) timeString += `${minutesLeft}m`;

  return timeString;
}

async function getNextEvent(auth) {
  const calendar = google.calendar({ version: 'v3', auth });
  try {
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: (new Date()).toISOString(),
      maxResults: 20,
      singleEvents: true,
      orderBy: 'startTime',
    });
    const events = response.data.items;

    if (events.length === 0) {
      return { event: null, nextEvent: null, events: [] };
    }

    const now = new Date();
    const currentEvent = events[0];
    const nextEvent = events.length > 1 ? events[1] : null;

    return {
      event: currentEvent,
      nextEvent: nextEvent && new Date(currentEvent.end.dateTime) > now ? nextEvent : null,
      events: events
    };

  } catch (error) {
    console.error('The API returned an error: ' + error);
    return { event: null, nextEvent: null, events: [] };
  }
}

async function handleReminderWindow(eventsObj) {
  const { event, nextEvent } = eventsObj;

  if (!event) {
    if (reminderWindow) {
      reminderWindow.hide();
      reminderWindow.close();
    }
    return;
  }

  const now = new Date();
  const startTime = new Date(event.start.dateTime || event.start.date);
  const endTime = new Date(event.end.dateTime || event.end.date);
  const nextEventStartTime = nextEvent ? new Date(nextEvent.start.dateTime || nextEvent.start.date) : null;

  const inCurrentEvent = startTime <= now && endTime > now;

  let reminderForEvent = null;
  if (inCurrentEvent && nextEventStartTime && nextEventStartTime - now <= 30 * 60 * 1000) {
    if (nextEventStartTime - now <= 2 * 60 * 1000) {
      reminderForEvent = nextEvent;
    }
  } else if (!inCurrentEvent && startTime - now <= 60 * 1000) {
    reminderForEvent = event;
  }

  if (reminderForEvent && reminderForEvent.id !== lastDismissedEventId) {
    const meetingLink = reminderForEvent.hangoutLink || extractMeetingLink(reminderForEvent.description) || null;
    createReminderWindow(reminderForEvent.summary, meetingLink, reminderForEvent.id);
  } else if (reminderWindow && now - startTime >= 5 * 60 * 1000) {
    reminderWindow.hide();
    reminderWindow.close();
  }
}

async function updateTrayTitle() {
  try {
    const events = await getNextEvent(authClient);
    const { event, nextEvent } = events;
    let eventName = event ? `${event.summary} ${createTimeString(event)}` : 'No upcoming events';

    if (event && nextEvent) {
      const now = new Date();
      const nextEventStartTime = new Date(nextEvent.start.dateTime || nextEvent.start.date);
      if (nextEventStartTime - now <= 30 * 60 * 1000) {
        log.info("Next event is within 30 mins");
        eventName = `${nextEvent.summary} in ${createTimeString(nextEvent)}`;
      }
    }

    tray.setTitle(eventName);
    handleReminderWindow(events);

    if (mainWindow) {
      mainWindow.webContents.send('update-events', events.events);
    }

  } catch (error) {
    log.error('Error updating tray:', error);
    tray.setTitle('Error updating event');
  }
}

async function startApp() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      log.info('Token found, setting credentials');
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oAuth2Client.setCredentials(token);
      authClient = oAuth2Client;
    } else {
      log.info('No token found, starting authentication');
      authClient = await authenticate();
    }

    updateTrayTitle();
    updateTrayInterval = setInterval(updateTrayTitle, 5000);

  } catch (error) {
    console.error('Error:', error);
    tray.setTitle('Authentication Error');
  }
}

function cleanup() {
  if (updateTrayInterval) {
    clearInterval(updateTrayInterval);
  }
  if (tray) {
    tray.destroy();
  }
  if (mainWindow) {
    mainWindow.close();
  }
  if (reminderWindow) {
    reminderWindow.close();
  }
}

app.on('ready', async () => {
  try {

    tray = new Tray(ICON_PATH);
    log.info('Vivcal is ready!');

    if (!google) {
      throw new Error('Google API not loaded');
    }

    await startApp();
    createWindow();

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          const position = getWindowPosition(tray, mainWindow);
          mainWindow.setPosition(position.x, position.y, false);
        }
      }
    });

    ipcMain.on('close-reminder', (event, eventId) => {
      if (reminderWindow) {
        log.info("User clicked on reminder window close");
        lastDismissedEventId = eventId;
        reminderWindow.close();
      }
    });

    ipcMain.on('open-link', (event, url, eventId) => {
      shell.openExternal(url);
      if (reminderWindow) {
        lastDismissedEventId = eventId;
        reminderWindow.close();
      }
    });

    ipcMain.on('log', (event, logMessage, additionalInfo) => {
      log.info("Log:", logMessage, additionalInfo);
    });

  } catch (err) {
    log.error('Error in app.on("ready"):', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup();
    app.quit();
  }
});

app.on('before-quit', cleanup);

function getWindowPosition(tray, window) {
  const trayBounds = tray.getBounds();
  const windowBounds = window.getBounds();
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height);
  return { x, y };
}

// Add this at the end of your file
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});