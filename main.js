const { google } = require('googleapis');
const { app, BrowserWindow, Tray, ipcMain, shell, screen, Notification } = require('electron');
const fs = require('fs');
const path = require('path')
const http = require('http');
const destroyer = require('server-destroy');
const log = require('electron-log');

let mainWindow, tray;
const TOKEN_PATH = 'token.json'; // Path to save your token
const CREDENTIALS_PATH = path.join(__dirname, 'google-creds.json'); // Update this path
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
const { client_secret, client_id, redirect_uris } = credentials.installed;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

let reminderWindow;
let lastDismissedEventId = null;
let cacheMainWindowEvents = [];

function showNotification(title, message, url, eventId) {
  const notification = new Notification({
    title: title,
    body: url ? "Click to join": "No meeting link found",
    actions: [{ text: 'Join Meeting', type: 'button' }],
    closeButtonText: 'Dismiss',
    urgency: "critical"
  });

  notification.on('show', () => {
    lastDismissedEventId = eventId;
  })

  notification.on('action', () => {
    shell.openExternal(url);
    // Action to perform when the 'Join Meeting' button is clicked
    // console.log('Meeting button was clicked!');
  });

  notification.on('close', () => {
    // console.log('notif was closed')
    lastDismissedEventId = eventId;
  })

  notification.on('click', () => {
    log.info('notif was clicked')
    shell.openExternal(url);
    lastDismissedEventId = eventId;
    notification.close
  })

  notification.show();
}

function createReminderWindow(eventDetails, meetingLink, eventId) {
  log.info("Creating the reminder window")
  if (reminderWindow) {
    // Update the content of the existing window instead of creating a new one
    reminderWindow.webContents.send('update-content', eventDetails, meetingLink, eventId);
    return;
  }

  const currDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workAreaSize, workArea, scaleFactor } = currDisplay;

  let xcoord = Math.round(workArea.x + (workArea.width - 400) / 2);
  // console.log(workArea.width, workArea.x, workArea.y + 60, xcoord, scaleFactor)

  reminderWindow = new BrowserWindow({
    width: 400,
    height: 100,
    x: xcoord, // Center horizontally
    y: workArea.y + 30,
    alwaysOnTop: true,
    frame: false,
    focusable: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // keep this true for security
      enableRemoteModule: false // it's false by default and should remain so
    }
  });

  // Define the HTML with the close button
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
      <button id="close-button" onclick="closeWindow()">×</button>
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

  // Load the HTML content in the window
  reminderWindow.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(windowHTML));

  // Set the window to be visible on all workspaces
  reminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hide the window when it loses focus
  // reminderWindow.on('blur', () => {
  //   if (reminderWindow) reminderWindow.hide();
  // });

  // Clean up when the window is closed
  reminderWindow.on('closed', () => {
    log.info("The reminder window was closed")
    reminderWindow = null;
  });
}

function createWindow(nextEvents) {
  log.info("Creating the main window")
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

  
  mainWindow.loadFile('index.html');
  
  // Set the window to be visible on all workspaces
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('show', () => {
    // mainWindow.webContents.openDevTools();
  });

  // Hide the window when it loses focus
  mainWindow.on('blur', () => {
    if (mainWindow) mainWindow.hide();
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
          // Store the token to disk for later program executions
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
          resolve(oAuth2Client);
        } catch (error) {
          console.error("Could not resolve the oAuth client")
          reject(error);
        }
      }
    }).listen(7175);

    destroyer(server);

    log.info('Opening the browser for authentication', authUrl);

    // Open the user's default browser for authentication
    require('electron').shell.openExternal(authUrl);
  });
}

function extractMeetingLink(description) {
  if (!description) return null;

  // Regular expression for Zoom links
  const zoomLinkRegex = /https:\/\/[a-zA-Z0-9]+\.zoom\.us\/j\/[^\s"<>]+/;
  const zoomMatch = zoomLinkRegex.exec(description);
  if (zoomMatch) return zoomMatch[0];

  // Regular expression for Microsoft Teams links
  const teamsLinkRegex = /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s]+/;
  const teamsMatch = teamsLinkRegex.exec(description);
  if (teamsMatch) return teamsMatch[0];

  // Regular expression for Webex links
  const webexLinkRegex = /https:\/\/[A-Za-z0-9-.]+\.webex\.com\/[^\s]+/;
  const webexMatch = webexLinkRegex.exec(description);
  if (webexMatch) return webexMatch[0];

  return null;
}

function createTimeString(event) {
  const startTime = new Date(event.start.dateTime || event.start.date);
  const timeDiff = startTime - new Date(); // Difference in milliseconds
  const minutesDiff = Math.floor(timeDiff / 60000); // Convert milliseconds to minutes
  const hoursDiff = Math.floor(minutesDiff / 60);
  const minutesLeft = minutesDiff % 60;

  let timeString = 'in ';
  if (hoursDiff > 0) {
    timeString += `${hoursDiff}h `;
  }
  if (minutesLeft > 0 && hoursDiff < 1) {
    timeString += `${minutesLeft}m`;
  }

  if (hoursDiff<=0 && minutesLeft<=0) {
    timeString = "now"
  }

  return timeString
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
      return { event: null, nextEvent: null };
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
    return 'Error fetching events';
  }
}

async function handleReminderWindow(eventsObj) {
  const { event, nextEvent } = eventsObj;

  if (!event) {
    if (reminderWindow) {
      reminderWindow.hide();
      reminderWindow.close();
    }
    return; // No upcoming events
  }

  const now = new Date();
  const startTime = new Date(event.start.dateTime || event.start.date);
  const endTime = new Date(event.end.dateTime || event.end.date);
  const nextEventStartTime = nextEvent ? new Date(nextEvent.start.dateTime || nextEvent.start.date) : null;

  // Determine if we're currently in an event
  const inCurrentEvent = startTime <= now && endTime > now;

  // Decide which event to remind about
  let reminderForEvent = null;
  if (inCurrentEvent && nextEventStartTime && nextEventStartTime - now <= 30 * 60 * 1000) {
    // If in an event and the next event starts within 30 mins
    if (nextEventStartTime - now <= 2 * 60 * 1000) {
      // Show reminder 2 minutes before the next event
      reminderForEvent = nextEvent;
    }
  } else if (!inCurrentEvent && startTime - now <= 60 * 1000) {
    // Show reminder if the current event starts within the next 60 seconds
    reminderForEvent = event;
  }

  if (reminderForEvent && reminderForEvent.id !== lastDismissedEventId) {
    const meetingLink = reminderForEvent.hangoutLink || extractMeetingLink(reminderForEvent.description) || null;
    createReminderWindow(reminderForEvent.summary, meetingLink, reminderForEvent.id);
  } else if (reminderWindow) {
    // Hide and close the reminder window if the current time is 5 minutes past the event's start time
    if (now - startTime >= 5 * 60 * 1000) {
      reminderWindow.hide();
      reminderWindow.close();
    }
  }
}

async function startApp() {
  let authClient;
  try {
    // Check if the token exists and set credentials
    if (fs.existsSync(TOKEN_PATH)) {
      log.info('Token found, setting credentials');
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oAuth2Client.setCredentials(token);
      authClient = oAuth2Client;
    } else {
      log.info('No token found, starting authentication');
      // Authenticate if no token found
      authClient = await authenticate();
    }

    // Function to update tray title
    const updateTrayTitle = async () => {
      try {
        const events = await getNextEvent(authClient);
        // console.log(events)
        const { event, nextEvent } = events;
        let eventName = event ? `${event.summary} ${createTimeString(event)}` : 'No upcoming events';
    
        // If there's an upcoming event within the next 30 minutes and we're in a current event
        if (event && nextEvent) {
          log.info(event.summary, nextEvent.summary)
          const now = new Date();
          const nextEventStartTime = new Date(nextEvent.start.dateTime || nextEvent.start.date);
          if (nextEventStartTime - now <= 30 * 60 * 1000) {
            log.info("Next event is within 30 mins")
            eventName = `${nextEvent.summary} in ${createTimeString(nextEvent)}`;
          }
        }
    
        tray.setTitle(eventName); // Set the tray title
        handleReminderWindow(events)

        if (cacheMainWindowEvents.join(",") !== events.events.map(e => e.id).join(",")) {
          log.info("Updating events on the main window");
          mainWindow.webContents.send('update-events', events.events);
          cacheMainWindowEvents = events.events.map(e => e.id);
        } else {
          log.info("Skipping main window event refresh")
        }

      } catch (error) {
        log.error('Error updating tray:', error);
        tray.setTitle('Error updating event');
      }
    };

    // Update tray title immediately and then at regular intervals
    updateTrayTitle();
    setInterval(updateTrayTitle, 5000); // Update every 5 seconds, adjust as needed

  } catch (error) {
    console.error('Error:', error);
    tray.setTitle('Authentication Error');
  }
}

app.on('ready', async () => {
  tray = new Tray('icon.png'); // Empty string for tray icon

  log.info('Vivcal is ready!');

  try {
    startApp()

    createWindow();

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        const position = getWindowPosition(tray, mainWindow);
        mainWindow.setPosition(position.x, position.y, false);
      }
    });

    ipcMain.on('close-reminder', (event, eventId) => {
      if (reminderWindow) {
        log.info("Use clicked on reminder window close")
        lastDismissedEventId = eventId; // Track the dismissed event
        reminderWindow.close();
      }
    });

    ipcMain.on('open-link', (event, url, eventId) => {
      shell.openExternal(url);
      if (reminderWindow) {
        lastDismissedEventId = eventId; // Track the dismissed event
        reminderWindow.close();
      }
    });

    ipcMain.on('log', (event, event2, events) => {
      log.info("Log:", event2, events)
    })

  } catch (err) {
    console.error(err);
  }
});

function getWindowPosition(tray, window) {
  const trayBounds = tray.getBounds();
  const windowBounds = window.getBounds();
  const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
  const y = Math.round(trayBounds.y + trayBounds.height);
  return { x, y };
}
