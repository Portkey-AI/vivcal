//main.js
const { app, BrowserWindow, Tray, ipcMain, shell, screen, Notification, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { globalShortcut } = require('electron');
const log = require('electron-log');
const http = require('http');
const destroyer = require('server-destroy');
const localtunnel = require('localtunnel');
const crypto = require('crypto');
const CalendarClient = require('./calendar-client');
const chrono = require('chrono-node');
require('dotenv').config()
// lightweight dynamic import of node-fetch (keeps commonjs)
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

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

const TOKEN_PATH = path.join(app.getPath('userData'), 'token.json');
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

const calendarClient = new CalendarClient(credentials);

let lastDismissedEventId = null;
let updateTrayInterval;
let reminderWindow;

let webhookServer;
let channelExpiration;

let mainWindow = null;
let tray = null;

// Quick Add Window reference
let quickAddWindow = null;

// Cached contacts list
let cachedEmails = null;

// ---------------- Portkey Quick-Add API ------------------
const PORTKEY_URL = 'https://api.portkey.ai/v1/prompts/pp-dateparse-d0b165/completions';
const PORTKEY_API_KEY = process.env.PORTKEY_API_KEY;

async function callPortkey(text) {
  try {
    const body = {
      stream: false,
      variables: {
        today: new Date().toISOString(),
        input: text
      }
    };

    const res = await fetch(PORTKEY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-portkey-api-key': PORTKEY_API_KEY
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      throw new Error(`Portkey request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Portkey returns OpenAI-style completion envelope; extract JSON from content
    let messageContent = data?.choices?.[0]?.message?.content || '';
    messageContent = messageContent.trim();
    if (messageContent.startsWith('```')) {
      // strip markdown fences if present
      messageContent = messageContent.replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    }
    let parsed;
    try {
      parsed = JSON.parse(messageContent);
    } catch (e) {
      log.error('Failed to parse Portkey content:', messageContent);
      throw e;
    }
    return parsed;
  } catch (err) {
    log.error('Portkey API error:', err);
    throw err;
  }
}

function isoToRFC(dateStr) {
  return new Date(dateStr).toISOString().replace(/[-:]|\.\d{3}/g, '').slice(0, 15) + 'Z';
}

function buildCalendarUrlFromPortkey(eventObj) {
  const {
    summary,
    start,
    end,
    timezone,
    details,
    location,
    guests,
    recurrence,
    calendarId
  } = eventObj;

  if (!summary || !start || !end) {
    throw new Error('Portkey response missing required fields');
  }

  const params = new URLSearchParams();
  params.append('text', summary);
  params.append('dates', `${isoToRFC(start)}/${isoToRFC(end)}`);

  if (timezone) params.append('ctz', timezone);
  if (details) params.append('details', details);
  if (location) params.append('location', location);
  if (Array.isArray(guests) && guests.length) params.append('add', guests.join(','));
  if (recurrence) params.append('recur', recurrence);
  if (calendarId) params.append('src', calendarId);

  return `https://calendar.google.com/calendar/u/0/r/eventedit?${params.toString()}`;
}

async function setupWebhook(auth) {
  // Cleanup existing webhook server if it exists
  if (webhookServer) {
    webhookServer.destroy();
  }

  const calendar = calendarClient.calendar;

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
    // log.info('notif was clicked');
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
    reminderWindow.webContents.send('update-content', eventDetails, meetingLink, eventId);
    return;
  }

  const currDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = currDisplay;

  let xcoord = Math.round(workArea.x + (workArea.width - 380) / 2);

  reminderWindow = new BrowserWindow({
    width: 380,
    height: 180,
    x: xcoord,
    y: workArea.y + 40,
    alwaysOnTop: true,
    frame: false,
    focusable: true,
    resizable: false,
    transparent: true,
    hasShadow: true,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  const windowHTML = `
  <html>
    <head>
      <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
      <style>
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        
        body {
          font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
          background: transparent;
          overflow: hidden;
        }
        
        .container {
          background: linear-gradient(145deg, #1a1a1a 0%, #0d0d0d 100%);
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.08);
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
          padding: 16px;
          height: 100vh;
          display: flex;
          flex-direction: column;
          -webkit-app-region: drag;
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 12px;
        }
        
        .time-badge {
          background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
          color: white;
          padding: 4px 10px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 5px;
          animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.8; }
        }
        
        .time-badge::before {
          content: '⏰';
          font-size: 10px;
        }
        
        .close-btn {
          -webkit-app-region: no-drag;
          width: 24px;
          height: 24px;
          border-radius: 8px;
          border: none;
          background: rgba(255, 255, 255, 0.05);
          color: rgba(255, 255, 255, 0.5);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          transition: all 0.2s ease;
        }
        
        .close-btn:hover {
          background: rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }
        
        .event-title {
          font-size: 16px;
          font-weight: 600;
          color: #f0f0f0;
          margin-bottom: 16px;
          line-height: 1.3;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        
        .actions {
          display: flex;
          gap: 8px;
          margin-top: auto;
          -webkit-app-region: no-drag;
        }
        
        .btn {
          flex: 1;
          padding: 10px 16px;
          border-radius: 10px;
          border: none;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          font-family: inherit;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
        }
        
        .btn-join {
          background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
          color: white;
        }
        
        .btn-join:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4);
        }
        
        .btn-snooze {
          background: rgba(255, 255, 255, 0.08);
          color: #a0a0a0;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .btn-snooze:hover {
          background: rgba(255, 255, 255, 0.12);
          color: #f0f0f0;
        }
        
        .snooze-dropdown {
          position: relative;
        }
        
        .snooze-options {
          display: none;
          position: absolute;
          bottom: 100%;
          left: 0;
          right: 0;
          background: #1a1a1a;
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          padding: 6px;
          margin-bottom: 6px;
          box-shadow: 0 -10px 30px rgba(0, 0, 0, 0.3);
        }
        
        .snooze-options.show {
          display: block;
          animation: slideUp 0.2s ease;
        }
        
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        .snooze-option {
          padding: 8px 12px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 11px;
          color: #a0a0a0;
          transition: all 0.15s ease;
        }
        
        .snooze-option:hover {
          background: rgba(99, 102, 241, 0.2);
          color: #818cf8;
        }
        
        .no-meeting {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #5a5a5a;
          font-size: 11px;
        }
        
        .drag-hint {
          position: absolute;
          bottom: 6px;
          left: 50%;
          transform: translateX(-50%);
          width: 40px;
          height: 4px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 2px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="time-badge">Starting now</div>
          <button class="close-btn" onclick="closeWindow()" title="Dismiss">×</button>
        </div>
        
        <div class="event-title" id="event-title">${eventDetails}</div>
        
        <div class="actions">
          ${meetingLink ? `
            <button class="btn btn-join" onclick="openMeetingLink('${meetingLink}')">
              <span>🎥</span> Join Meeting
            </button>
          ` : `
            <div class="no-meeting">No meeting link</div>
          `}
          <div class="snooze-dropdown">
            <button class="btn btn-snooze" onclick="toggleSnooze()">
              <span>⏰</span> Snooze
            </button>
            <div class="snooze-options" id="snooze-options">
              <div class="snooze-option" onclick="snoozeFor(1)">1 minute</div>
              <div class="snooze-option" onclick="snoozeFor(5)">5 minutes</div>
              <div class="snooze-option" onclick="snoozeFor(10)">10 minutes</div>
            </div>
          </div>
        </div>
        
        <div class="drag-hint"></div>
      </div>
      
      <script>
        const eventId = '${eventId}';
        
        function closeWindow() {
          window.api.closeReminderWindow(eventId);
        }
        
        function openMeetingLink(url) {
          window.api.openLink(url, eventId);
        }
        
        function toggleSnooze() {
          const options = document.getElementById('snooze-options');
          options.classList.toggle('show');
        }
        
        function snoozeFor(minutes) {
          window.api.snoozeReminder(eventId, minutes);
        }
        
        // Close snooze dropdown when clicking outside
        document.addEventListener('click', (e) => {
          if (!e.target.closest('.snooze-dropdown')) {
            document.getElementById('snooze-options').classList.remove('show');
          }
        });
        
        // Update content handler
        window.api && window.api.onUpdateContent && window.api.onUpdateContent((title, link, id) => {
          document.getElementById('event-title').textContent = title;
          // Update meeting link button if needed
        });
      </script>
    </body>
  </html>`;

  reminderWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(windowHTML));
  reminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  reminderWindow.on('closed', () => {
    reminderWindow = null;
  });
}

function createWindow() {
  // log.info("Creating the main window");
  if (mainWindow) {
    // log.info("Window already exists, showing it");
    mainWindow.show();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 450,
    height: 550,
    show: true,
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
  log.info(`Loading index.html from: ${indexPath}`);

  try {
    mainWindow.loadFile(indexPath);
    log.info('File loaded successfully');
  } catch (error) {
    log.error('Error loading file:', error);
  }

  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('blur', () => {
    // log.info('Window blurred');
    if (mainWindow) mainWindow.hide();
  });

  mainWindow.on('closed', () => {
    // log.info('Window closed');
    mainWindow = null;
  });

  mainWindow.on('show', () => {
    // log.info('Window shown');
  });

  mainWindow.on('hide', () => {
    // log.info('Window hidden');
  });

  // Add this to ensure window is ready before being shown
  mainWindow.once('ready-to-show', () => {
    // log.info('Window ready to show');
    mainWindow.show();
  });
}

function authenticate() {
  return new Promise((resolve, reject) => {
    const authUrl = calendarClient.auth.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
        'https://www.googleapis.com/auth/contacts.other.readonly',
        'https://www.googleapis.com/auth/directory.readonly'
      ]
    });

    const server = http.createServer(async (req, res) => {
      if (req.url.indexOf('/auth/google/callback') > -1) {
        const qs = new URL(req.url, `http://localhost:${7175}`).searchParams;
        res.end('Authentication successful! Please return to the app.');
        server.destroy();
        try {
          // log.info('Getting token with code');
          const { tokens } = await calendarClient.auth.getToken(qs.get('code'));
          // log.info('Got tokens, setting credentials');
          calendarClient.setCredentials(tokens);
          
          // Add debug logging for token writing
          // log.info('Writing token to:', TOKEN_PATH);
          try {
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
            // log.info('Token written successfully');
          } catch (writeError) {
            log.error('Error writing token:', writeError);
          }
          
          resolve(calendarClient);
        } catch (error) {
          log.error("Error in auth callback:", error);
          reject(error);
        }
      }
    }).listen(7175);

    destroyer(server);

    log.info('Opening the browser for authentication', authUrl);
    require('electron').shell.openExternal(authUrl);
  });
}

function extractMeetingLink(event) {
  // Support both old signature (string) and new signature (event object)
  if (typeof event === 'string') {
    return extractMeetingLinkFromText(event);
  }
  
  // If event is not an object, return null
  if (!event || typeof event !== 'object') {
    return null;
  }

  // Priority order for checking meeting links:
  // 1. Google Meet from hangoutLink
  if (event.hangoutLink) {
    return event.hangoutLink;
  }

  // 2. Conference data from Google Calendar API v3
  if (event.conferenceData && event.conferenceData.entryPoints) {
    for (const entryPoint of event.conferenceData.entryPoints) {
      if (entryPoint.entryPointType === 'video' && entryPoint.uri) {
        return entryPoint.uri;
      }
    }
  }

  // 3. Check location field for meeting links
  if (event.location) {
    const locationLink = extractMeetingLinkFromText(event.location);
    if (locationLink) {
      return locationLink;
    }
  }

  // 4. Check description field for meeting links
  if (event.description) {
    const descriptionLink = extractMeetingLinkFromText(event.description);
    if (descriptionLink) {
      return descriptionLink;
    }
  }

  // 5. Check htmlLink for calendar event (sometimes contains meeting info)
  if (event.htmlLink) {
    const htmlLink = extractMeetingLinkFromText(event.htmlLink);
    if (htmlLink) {
      return htmlLink;
    }
  }

  return null;
}

function extractMeetingLinkFromText(text) {
  if (!text) return null;

  // Define regex patterns for various meeting platforms
  const patterns = [
    // Zoom patterns (multiple variations)
    /https:\/\/[a-zA-Z0-9\-]+\.zoom\.us\/j\/[^\s"<>]+/,  // Regular meeting
    /https:\/\/[a-zA-Z0-9\-]+\.zoom\.us\/my\/[^\s"<>]+/, // Personal room
    /https:\/\/[a-zA-Z0-9\-]+\.zoom\.us\/s\/[^\s"<>]+/,  // Webinar
    /https:\/\/[a-zA-Z0-9\-]+\.zoom\.us\/w\/[^\s"<>]+/,  // Webinar alternative
    
    // Microsoft Teams patterns
    /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^>\s]+/,
    /https:\/\/teams\.live\.com\/meet\/[^\s"<>]+/,
    
    // Google Meet patterns
    /https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/,
    /https:\/\/meet\.google\.com\/[a-z\-]+/,
    
    // Webex patterns
    /https:\/\/[a-zA-Z0-9\-]+\.webex\.com\/[a-zA-Z0-9\-]+\/j\.php\?[^\s"<>]+/,
    /https:\/\/[a-zA-Z0-9\-]+\.webex\.com\/meet\/[^\s"<>]+/,
    /https:\/\/[a-zA-Z0-9\-]+\.webex\.com\/join\/[^\s"<>]+/,
    
    // Slack Huddle patterns
    /https:\/\/[a-zA-Z0-9\-]+\.slack\.com\/huddle\/[^\s"<>]+/,
    /slack:\/\/huddle\/[^\s"<>]+/,
    
    // Discord patterns
    /https:\/\/discord\.gg\/[^\s"<>]+/,
    /https:\/\/discord\.com\/invite\/[^\s"<>]+/,
    
    // Skype patterns
    /https:\/\/join\.skype\.com\/[^\s"<>]+/,
    
    // GoToMeeting patterns
    /https:\/\/[a-zA-Z0-9\-]+\.gotomeeting\.com\/join\/[^\s"<>]+/,
    /https:\/\/global\.gotomeeting\.com\/join\/[^\s"<>]+/,
    
    // Whereby patterns
    /https:\/\/whereby\.com\/[^\s"<>]+/,
    
    // Jitsi Meet patterns
    /https:\/\/meet\.jit\.si\/[^\s"<>]+/,
    /https:\/\/[a-zA-Z0-9\-]+\.jitsi\.net\/[^\s"<>]+/,
    
    // Around patterns
    /https:\/\/meet\.around\.co\/[^\s"<>]+/,
    
    // Vowel patterns
    /https:\/\/vowel\.com\/[^\s"<>]+/,
    
    // Loom patterns (for recorded meetings)
    /https:\/\/www\.loom\.com\/share\/[^\s"<>]+/,
    /https:\/\/loom\.com\/share\/[^\s"<>]+/
  ];

  // Try each pattern and return the first match
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let link = match[0];
      // Clean up common artifacts
      link = link.replace(/[>]+$/, ''); // Remove trailing '>'
      link = link.replace(/[,;\.]+$/, ''); // Remove trailing punctuation
      return link;
    }
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
  const calendar = calendarClient.calendar;
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
    const meetingLink = extractMeetingLink(reminderForEvent);
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
    const events = await getNextEvent(calendarClient);
    const { event, nextEvent } = events;
    let eventName = event ? `${elipsis(event.summary, 20)} ${createTimeString(event)}` : 'No upcoming events';

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
    // log.info('Checking for token at:', TOKEN_PATH);
    if (fs.existsSync(TOKEN_PATH)) {
      // log.info('Token found, reading credentials');
      try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
        // log.info('Token read successfully');
        calendarClient.setCredentials(token);
      } catch (readError) {
        log.error('Error reading token:', readError);
        // log.info('Starting fresh authentication');
        await authenticate();
      }
    } else {
      // log.info('No token found, starting authentication');
      await authenticate();
    }

    await createWindow();
    await updateTrayTitle();

    // Always start polling as a baseline - updates every 30 seconds
    if (!updateTrayInterval) {
      updateTrayInterval = setInterval(updateTrayTitle, 30000);
      log.info('Started polling interval (30s)');
    }

    // Setup webhook (will provide faster updates when it works)
    await setupWebhook(calendarClient);

    // Add tray click handler here after window is created
    tray.on('click', async () => {
      // log.info('Tray clicked');
      try {
        if (!mainWindow) {
          // log.info('mainWindow is null, creating new window');
          await createWindow();
          return;
        }

        // log.info('mainWindow exists, isVisible:', mainWindow.isVisible());
        if (mainWindow.isVisible()) {
          // log.info('Hiding mainWindow');
          mainWindow.hide();
        } else {
          // log.info('Showing mainWindow');
          const position = getWindowPosition(tray, mainWindow);
          // log.info('Setting position to:', position);
          mainWindow.setPosition(position.x, position.y, false);
          mainWindow.show();
        }
      } catch (error) {
        log.error('Error in tray click handler:', error);
      }
    });

  } catch (error) {
    log.error('Error in startApp:', error);
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

  // Unregister all shortcuts
  try {
    globalShortcut.unregisterAll();
  } catch (e) {
    log.error('Error unregistering global shortcuts:', e);
  }

  // Stop webhook notifications if channel exists
  if (calendarClient && channelExpiration && channelExpiration > new Date()) {
    // console.log("Stopping webhook notifications");
    const calendar = calendarClient.calendar;
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

    // Register global shortcut for quick add (Command+N / Ctrl+N)
    const registeredQuickAdd = globalShortcut.register('Alt+N', () => {
      createQuickAddWindow();
    });
    if (!registeredQuickAdd) {
      log.error('Global shortcut registration failed for Alt+N');
    }

    // Register global shortcut for main panel toggle (Option+C / Alt+C)
    const registeredMainPanel = globalShortcut.register('Alt+C', () => {
      toggleMainWindow();
    });
    if (!registeredMainPanel) {
      log.error('Global shortcut registration failed for Alt+C');
    }

    await startApp();

    ipcMain.on('close-reminder', (event, eventId) => {
      if (reminderWindow) {
        // log.info("User clicked on reminder window close");
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
      // log.info("Log:", logMessage, additionalInfo);
    });

    ipcMain.on('quick-add-event', (event, text) => {
      handleQuickAddInput(text);
    });

    ipcMain.on('open-quick-add', () => {
      createQuickAddWindow();
    });

    ipcMain.on('snooze-reminder', (event, eventId, minutes) => {
      if (reminderWindow) {
        reminderWindow.close();
      }
      // Set a timeout to show the reminder again
      setTimeout(() => {
        // Re-fetch and show reminder for the event
        updateTrayTitle();
      }, minutes * 60 * 1000);
      log.info(`Snoozed reminder for ${eventId} for ${minutes} minutes`);
    });

    ipcMain.on('quit-app', () => {
      app.quit();
    });

    ipcMain.handle('search-contacts', async (event, query) => {
      // Refresh contacts every 5 minutes or if we have very few contacts
      const shouldRefresh = !cachedEmails || cachedEmails.length <= 5 || 
                           (Date.now() - (global.lastContactsRefresh || 0)) > 5 * 60 * 1000;
      
      if (shouldRefresh) {
        global.lastContactsRefresh = Date.now();
        // log.info('Refreshing contacts cache...');
      }
      
      const emails = await loadContacts(shouldRefresh);
      if (!query) return emails.slice(0, 10);
      return emails.filter(e => e.toLowerCase().includes(query.toLowerCase())).slice(0, 10);
    });

    ipcMain.on('resize-window', (event, width, height) => {
      if (quickAddWindow) {
        quickAddWindow.setSize(width, height);
      }
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

async function toggleMainWindow() {
  try {
    if (!mainWindow) {
      await createWindow();
      return;
    }

    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      const position = getWindowPosition(tray, mainWindow);
      mainWindow.setPosition(position.x, position.y, false);
      mainWindow.show();
    }
  } catch (error) {
    log.error('Error in toggleMainWindow:', error);
  }
}

// Add this at the end of your file
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});

function formatRFCDate(date) {
  // Returns date in YYYYMMDDThhmmssZ format (UTC)
  const iso = date.toISOString(); // e.g., 2025-06-21T16:30:00.000Z
  return iso.replace(/[-:]|\.\d{3}/g, '').slice(0, 15) + 'Z';
}

function buildGoogleCalendarUrl(inputText) {
  try {
    const results = chrono.parse(inputText);
    let summary = inputText;
    let datesParam = null;

    if (results.length) {
      const res = results[0];
      const startDate = res.start.date();
      let endDate;

      if (res.end) {
        endDate = res.end.date();
      } else {
        // Default duration 1 hour
        endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
      }

      datesParam = `${formatRFCDate(startDate)}/${formatRFCDate(endDate)}`;

      // Remove the parsed text portion to make summary cleaner
      summary = inputText.replace(res.text, '').trim();
      if (!summary) summary = res.text; // fallback
    }

    const base = 'https://calendar.google.com/calendar/u/0/r/eventedit';
    const params = new URLSearchParams();
    params.append('text', summary);
    if (datesParam) params.append('dates', datesParam);

    return `${base}?${params.toString()}`;
  } catch (e) {
    log.error('Error building calendar url:', e);
    return 'https://calendar.google.com/calendar/u/0/r/eventedit';
  }
}

async function handleQuickAddInput(text) {
  if (!text) return;
  try {
    const eventObj = await callPortkey(text);
    const url = buildCalendarUrlFromPortkey(eventObj);
    shell.openExternal(url);
  } catch (err) {
    // fallback: open raw google calendar new-event page
    shell.openExternal('https://calendar.google.com/calendar/u/0/r/eventedit');
  } finally {
    if (quickAddWindow) {
      quickAddWindow.close();
    }
  }
}

function createQuickAddWindow() {
  if (quickAddWindow) {
    quickAddWindow.show();
    quickAddWindow.focus();
    return;
  }

  const currDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = currDisplay;

  quickAddWindow = new BrowserWindow({
    width: 500,
    height: 200,
    x: Math.round(workArea.x + (workArea.width - 500) / 2),
    y: workArea.y + 80,
    alwaysOnTop: true,
    frame: false,
    resizable: true,
    focusable: true,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      enableRemoteModule: false
    }
  });

  const quickAddHTML = `
    <html>
      <head>
        <meta charset="UTF-8">
        <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          
          body {
            font-family: 'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif;
            background: transparent;
            overflow: hidden;
          }
          
          .container {
            background: linear-gradient(145deg, #1a1a1a 0%, #0d0d0d 100%);
            border-radius: 16px;
            border: 1px solid rgba(255, 255, 255, 0.08);
            box-shadow: 0 25px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05) inset;
            padding: 20px;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }
          
          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            -webkit-app-region: drag;
          }
          
          .title {
            font-size: 14px;
            font-weight: 600;
            color: #f0f0f0;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          
          .title-icon {
            width: 24px;
            height: 24px;
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
          }
          
          .shortcut-hint {
            font-size: 10px;
            color: #5a5a5a;
            font-family: 'JetBrains Mono', monospace;
          }
          
          .input-wrapper {
            position: relative;
            margin-bottom: 12px;
            -webkit-app-region: no-drag;
          }
          
          textarea {
            width: 100%;
            padding: 14px 16px;
            border-radius: 12px;
            border: 2px solid rgba(99, 102, 241, 0.3);
            font-size: 15px;
            outline: none;
            resize: none;
            overflow: hidden;
            background: rgba(255, 255, 255, 0.03);
            color: #f0f0f0;
            font-family: inherit;
            min-height: 50px;
            transition: all 0.2s ease;
          }
          
          textarea::placeholder {
            color: #5a5a5a;
          }
          
          textarea:focus {
            border-color: rgba(99, 102, 241, 0.6);
            background: rgba(255, 255, 255, 0.05);
          }
          
          .examples {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 16px;
            -webkit-app-region: no-drag;
          }
          
          .example-chip {
            padding: 5px 10px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 20px;
            font-size: 11px;
            color: #8a8a8a;
            cursor: pointer;
            transition: all 0.2s ease;
          }
          
          .example-chip:hover {
            background: rgba(99, 102, 241, 0.15);
            border-color: rgba(99, 102, 241, 0.3);
            color: #a5b4fc;
          }
          
          .actions {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-top: auto;
            -webkit-app-region: no-drag;
          }
          
          .help-text {
            font-size: 11px;
            color: #5a5a5a;
          }
          
          .help-text kbd {
            background: rgba(255, 255, 255, 0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px;
          }
          
          .btn-group {
            display: flex;
            gap: 8px;
          }
          
          .btn {
            padding: 10px 20px;
            border-radius: 10px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            font-family: inherit;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          
          .btn-cancel {
            background: rgba(255, 255, 255, 0.05);
            color: #8a8a8a;
          }
          
          .btn-cancel:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #f0f0f0;
          }
          
          .btn-create {
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            color: white;
          }
          
          .btn-create:hover:not(:disabled) {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);
          }
          
          .btn-create:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          
          .spinner {
            width: 14px;
            height: 14px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top-color: white;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
          }
          
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
          
          .suggest {
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #1a1a1a;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 10px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
            z-index: 1000;
            max-height: 150px;
            overflow-y: auto;
            display: none;
            margin-top: 6px;
          }
          
          .suggest.show {
            display: block;
            animation: slideDown 0.15s ease;
          }
          
          @keyframes slideDown {
            from {
              opacity: 0;
              transform: translateY(-5px);
            }
            to {
              opacity: 1;
              transform: translateY(0);
            }
          }
          
          .suggest-item {
            padding: 10px 14px;
            cursor: pointer;
            font-size: 12px;
            color: #a0a0a0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            transition: all 0.15s ease;
            display: flex;
            align-items: center;
            gap: 8px;
          }
          
          .suggest-item:last-child {
            border-bottom: none;
          }
          
          .suggest-item:hover,
          .suggest-item.selected {
            background: rgba(99, 102, 241, 0.15);
            color: #f0f0f0;
          }
          
          .suggest-item::before {
            content: '👤';
            font-size: 12px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title">
              <span class="title-icon">✨</span>
              Quick Add Event
            </div>
            <span class="shortcut-hint">⌥N</span>
          </div>
          
          <div class="input-wrapper">
            <textarea id="quickInput" rows="1" autofocus placeholder="Meeting with John tomorrow at 3pm for 1 hour..."></textarea>
            <div class="suggest" id="suggest"></div>
          </div>
          
          <div class="examples">
            <span class="example-chip" data-text="Standup tomorrow 9am">📅 Standup tomorrow 9am</span>
            <span class="example-chip" data-text="Lunch with team Friday noon">🍽️ Lunch Friday noon</span>
            <span class="example-chip" data-text="Call with client next Monday 2pm">📞 Call Monday 2pm</span>
          </div>
          
          <div class="actions">
            <div class="help-text">
              Type <kbd>@</kbd> to add attendees
            </div>
            <div class="btn-group">
              <button class="btn btn-cancel" onclick="window.close()">Cancel</button>
              <button class="btn btn-create" id="createBtn">
                <span id="btnText">Create Event</span>
                <div class="spinner" id="spinner" style="display: none;"></div>
              </button>
            </div>
          </div>
        </div>
        
        <script>
          const input = document.getElementById('quickInput');
          const btn = document.getElementById('createBtn');
          const btnText = document.getElementById('btnText');
          const spinner = document.getElementById('spinner');
          const suggest = document.getElementById('suggest');
          
          let autocompleteTimeout;
          let selectedIndex = -1;
          
          function adjustHeight() {
            input.style.height = 'auto';
            const newHeight = Math.max(50, Math.min(120, input.scrollHeight));
            input.style.height = newHeight + 'px';
            
            const baseHeight = newHeight + 160;
            const dropdownVisible = suggest.classList.contains('show');
            const dropdownHeight = dropdownVisible ? 160 : 0;
            const windowHeight = Math.max(200, baseHeight + dropdownHeight);
            
            if (window.electronAPI) {
              window.electronAPI.resizeWindow(500, windowHeight);
            }
          }
          
          setTimeout(adjustHeight, 10);
          
          // Example chips
          document.querySelectorAll('.example-chip').forEach(chip => {
            chip.addEventListener('click', () => {
              input.value = chip.dataset.text;
              input.focus();
              adjustHeight();
            });
          });
          
          function selectSuggestion(index) {
            const items = suggest.querySelectorAll('.suggest-item');
            items.forEach((item, i) => {
              item.classList.toggle('selected', i === index);
            });
            selectedIndex = index;
          }
          
          function applySuggestion(index) {
            const items = suggest.querySelectorAll('.suggest-item');
            if (index < 0 || index >= items.length) return;
            
            const cursorPos = input.selectionStart;
            const textBefore = input.value.substring(0, cursorPos);
            const match = /@([a-zA-Z0-9._-]*)$/.exec(textBefore);
            
            if (match) {
              const start = cursorPos - match[1].length - 1;
              const end = cursorPos;
              const email = items[index].textContent.trim();
              input.value = input.value.slice(0, start) + email + ' ' + input.value.slice(end);
              suggest.classList.remove('show');
              selectedIndex = -1;
              adjustHeight();
              input.focus();
              const newPos = start + email.length + 1;
              input.setSelectionRange(newPos, newPos);
            }
          }
          
          async function handleAtAutocomplete() {
            if (autocompleteTimeout) clearTimeout(autocompleteTimeout);
            
            autocompleteTimeout = setTimeout(async () => {
              try {
                const cursorPos = input.selectionStart;
                const textBefore = input.value.substring(0, cursorPos);
                const match = /@([a-zA-Z0-9._-]*)$/.exec(textBefore);
                
                if (match) {
                  const results = await window.api.searchContacts(match[1]);
                  
                  if (results && results.length) {
                    suggest.innerHTML = results.map(e => 
                      '<div class="suggest-item">' + e + '</div>'
                    ).join('');
                    suggest.classList.add('show');
                    selectedIndex = -1;
                    adjustHeight();
                    
                    suggest.querySelectorAll('.suggest-item').forEach((item, index) => {
                      item.addEventListener('click', () => applySuggestion(index));
                    });
                  } else {
                    suggest.classList.remove('show');
                    selectedIndex = -1;
                    adjustHeight();
                  }
                } else {
                  suggest.classList.remove('show');
                  selectedIndex = -1;
                  adjustHeight();
                }
              } catch (e) {
                console.error('Autocomplete error:', e);
                suggest.classList.remove('show');
                adjustHeight();
              }
            }, 150);
          }
          
          input.addEventListener('input', () => {
            adjustHeight();
            handleAtAutocomplete();
          });
          
          function triggerCreate() {
            const text = input.value.trim();
            if (!text) return;
            
            btnText.style.display = 'none';
            spinner.style.display = 'block';
            btn.disabled = true;
            input.disabled = true;
            
            window.api.addQuickEvent(text);
          }
          
          btn.addEventListener('click', triggerCreate);
          
          input.addEventListener('keydown', (e) => {
            const dropdownVisible = suggest.classList.contains('show');
            const items = suggest.querySelectorAll('.suggest-item');
            
            if (dropdownVisible && items.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectSuggestion(selectedIndex < items.length - 1 ? selectedIndex + 1 : 0);
                return;
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectSuggestion(selectedIndex > 0 ? selectedIndex - 1 : items.length - 1);
                return;
              } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault();
                applySuggestion(selectedIndex);
                return;
              } else if (e.key === 'Escape') {
                e.preventDefault();
                suggest.classList.remove('show');
                selectedIndex = -1;
                adjustHeight();
                return;
              } else if (e.key === 'Tab' && selectedIndex >= 0) {
                e.preventDefault();
                applySuggestion(selectedIndex);
                return;
              }
            }
            
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              triggerCreate();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              window.close();
            }
          });
          
          document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              window.close();
            }
          });
          
          document.addEventListener('click', (e) => {
            if (!suggest.contains(e.target) && e.target !== input) {
              suggest.classList.remove('show');
              selectedIndex = -1;
              adjustHeight();
            }
          });
        </script>
      </body>
    </html>`;

  quickAddWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(quickAddHTML));

  quickAddWindow.on('closed', () => {
    quickAddWindow = null;
  });
}

async function loadContacts(forceRefresh = false) {
  if (cachedEmails && !forceRefresh) return cachedEmails;
  
  try {
    // log.info('Loading contacts from API...');
    const res = await calendarClient.listConnections();
    // log.info('Raw API response:', JSON.stringify(res, null, 2));
    
    const emails = [];
    if (res.connections) {
      res.connections.forEach(p => {
        (p.emailAddresses || []).forEach(e => {
          if (e.value) emails.push(e.value);
        });
      });
    }
    
    // Always use the emails we got (even if it's just 1 from People API or 200+ from calendar)
    cachedEmails = emails.length > 0 ? emails : [
      'example@gmail.com',
      'contact@company.com',
      'friend@outlook.com',
      'colleague@work.com',
      'team@startup.com'
    ];
    
    // log.info(`Loaded ${cachedEmails.length} contacts successfully:`, cachedEmails.slice(0, 5));
    return cachedEmails;
  } catch (e) {
    log.error('Error loading contacts:', e);
    // Return helpful email suggestions for autocomplete
    cachedEmails = [
      'example@gmail.com',
      'contact@company.com', 
      'friend@outlook.com',
      'colleague@work.com',
      'team@startup.com'
    ];
    return cachedEmails;
  }
}