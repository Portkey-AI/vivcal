//main.js
const { app, BrowserWindow, Tray, ipcMain, shell, screen, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const http = require('http');
const destroyer = require('server-destroy');
const localtunnel = require('localtunnel');
const crypto = require('crypto');

// Configure electron-log
log.transports.file.resolvePathFn = () => path.join(app.getPath('userData'), 'logs/main.log');
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
const WEBHOOK_PORT = 8085;
const WEBHOOK_PATH = '/calendar-webhook';
const CHANNEL_ID = crypto.randomUUID();

const trayIcon = nativeImage.createFromPath(
  path.join(__dirname, "iconTemplate.png")
);

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

let webhookServer;
let channelExpiration;

async function setupWebhook(auth) {
  // Cleanup existing webhook server if it exists
  if (webhookServer) {
    webhookServer.destroy();
  }

  const calendar = google.calendar({ version: 'v3', auth });

  // Create webhook server
  webhookServer = http.createServer(async (req, res) => {
    console.log("Webhook server received request:", req.url);
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
      let body = '';
      req.on('data', chunk => { body += chunk;});

      req.on('end', async () => {
        res.writeHead(200);
        res.end();

        // Update tray on notification
        await updateTrayTitle();
      });
    }
  });

  // Enable server cleanup on destroy
  destroyer(webhookServer);
  
  // Start the server
  webhookServer.listen(WEBHOOK_PORT, () => {
    log.info(`Webhook server is running on port ${WEBHOOK_PORT}`);
  });

  // Setup localtunnel
  try {
    const tunnel = await localtunnel({
      port: WEBHOOK_PORT,
      subdomain: 'major-lies-drop'
    });

    log.info(`Localtunnel URL: ${tunnel.url}`);

    // Handle tunnel errors
    tunnel.on('error', err => {
      log.error('Localtunnel error:', err);
      fallbackToPolling();
    });

    tunnel.on('close', () => {
      log.info('Localtunnel closed');
      fallbackToPolling();
    });

    // Set up push notifications
    try {
      const response = await calendar.events.watch({
        calendarId: 'primary',
        resource: {
          id: CHANNEL_ID,
          type: 'web_hook',
          address: `${tunnel.url}${WEBHOOK_PATH}`
        }
      });

      channelExpiration = new Date(parseInt(response.data.expiration));
      log.info(`Webhook set up with expiration: ${channelExpiration}`);

      // Schedule webhook renewal before expiration
      const renewalTime = new Date(channelExpiration.getTime() - 60 * 1000);
      setTimeout(() => setupWebhook(auth), renewalTime.getTime() - Date.now());
    } catch (error) {
      log.error('Error setting up webhook:', error);
      fallbackToPolling();
    }
  } catch (error) {
    log.error('Error setting up localtunnel:', error);
    fallbackToPolling();
  }
}

// Helper function for fallback
function fallbackToPolling() {
  log.info('Falling back to polling mechanism');
  updateTrayTitle();
  if (!updateTrayInterval) {
    updateTrayInterval = setInterval(updateTrayTitle, 30000);
  }
}

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
  if (reminderWindow) {
    log.info("Creating the reminder window");
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
  <html>
    <head>
      <style>
        body {
          margin: 0;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background-color: #FFF;
          font-size: 16px;
          font-weight: 500;
          height: 100vh;
        }
        #close-button {
          position: absolute;
          top: 5px;
          right: 10px;
          border: 1px solid #eee;
          border-radius: 10px;
          background-color: transparent;
          cursor: pointer;
          font-size: 18px;
          line-height: 20px;
          opacity: 0.7;
        }
        #close-button:hover {
          opacity: 1;
        }
        #event {
          margin-bottom: 15px; /* Space between event and button */
        }
        #meeting-link > a {
          display: inline-block;
          background-color: #007bff;
          color: white;
          padding: 5px 10px;
          text-decoration: none;
          border-radius: 3px;
          font-size: 12px;
          transition: background-color 0.3s;
        }
        #meeting-link > a:hover {
          background-color: #0056b3;
        }
      </style>
    </head>
    <body>
      <div id="event">${eventDetails}</div>
      ${meetingLink ? `<div id="meeting-link"><a href="#" onclick="openMeetingLink('${meetingLink}')">Join Meeting</a></div>` : ''}
      <button id="close-button" onclick="closeWindow()" title="Close reminder window">×</button>
      <script>
        function closeWindow() {
          window.api.closeReminderWindow('${eventId}');
        }
        function openMeetingLink(url) {
          window.api.openLink(url,'${eventId}');
        }
        // Function to play a sound
        function playSound() {
          var audio = new Audio('alert.wav'); // Add the correct path to your sound file
          audio.play();
        }
        playSound();
      </script>
    </body>
  </html>`;

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
  const minutesLeft = Math.round((minutesDiff % 60) / 10) * 10;

  if (hoursDiff <= 0 && minutesLeft <= 0) return "now";

  let timeString = 'in ';
  if (hoursDiff > 0) timeString += `${hoursDiff}h `;
  if (minutesLeft > 0) timeString += `${minutesLeft}m`;

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

function elipsis(text, maxLength) {
  return text.length > maxLength ? text.substring(0, maxLength - 3).trim() + '..' : text;
}

async function updateTrayTitle() {
  console.log("Updating tray title");
  try {
    const events = await getNextEvent(authClient);
    const { event, nextEvent } = events;
    let eventName = event ? `${event.summary} ${createTimeString(event)}` : 'No upcoming events';

    if (event && nextEvent) {
      const now = new Date();
      const nextEventStartTime = new Date(nextEvent.start.dateTime || nextEvent.start.date);
      if (nextEventStartTime - now <= 30 * 60 * 1000) {
        log.info("Next event is within 30 mins");
        eventName = `${elipsis(nextEvent.summary, 20)} ${createTimeString(nextEvent)}`;
      }
    }

    console.log(eventName);

    tray.setTitle(eventName);
    handleReminderWindow(events);

    if (typeof mainWindow?.webContents?.send === 'function') {
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

    await createWindow();
    await updateTrayTitle();

    // Setup webhook
    await setupWebhook(authClient);

    // updateTrayInterval = setInterval(updateTrayTitle, 30000);

  } catch (error) {
    console.error('Error:', error);
    tray.setTitle('Authentication Error');
  }
}

function cleanup() {
  if (updateTrayInterval) {
    clearInterval(updateTrayInterval);
  }
  if (webhookServer) {
    webhookServer.destroy();
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

  // Stop webhook notifications if channel exists
  if (authClient && channelExpiration && channelExpiration > new Date()) {
    console.log("Stopping webhook notifications");
    const calendar = google.calendar({ version: 'v3', auth: authClient });
    calendar.channels.stop({
      requestBody: {
        id: CHANNEL_ID,
        resourceId: 'primary'
      }
    }).catch(err => log.error('Error stopping webhook:', err));
  }
}

app.on('ready', async () => {
  try {

    let icon = trayIcon.resize({ width: 16, height: 16 });
    icon.setTemplateImage(true);

    tray = new Tray(icon);
    log.info('Vivcal is ready!');

    if (!google) {
      throw new Error('Google API not loaded');
    }

    await startApp();

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

    ipcMain.on('quit-app', () => {
      app.quit();
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