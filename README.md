![](VivCal.png)

## How to use vivcal?

1. Clone Vivcal locally (Assumes you have node and npm installed)
```
git clone https://github.com/Portkey-AI/vivcal.git
cd vivcal
npm i
```

2. Google Cloud Console Setup

- Go to the Google Cloud Console.
- Create a new project.
- Enable the Google Calendar API for your project.
- Configure the OAuth consent screen.
- Create OAuth 2.0 credentials (client ID and client secret).
- Download the JSON file with your credentials and store it as `google-creds.json` in this folder.
- Update the redirect url

It would look something like this
```
{
  "installed": {
    "client_id": "...",
    "project_id": "...",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
    "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
    "client_secret": "...",
    "redirect_uris": ["http://localhost:7175/auth/google/callback"]
  }
}
```

3. Run Vivcal
```
npm start
```

## Packaging and running it on your local machine

1. Package the application
```
npm run dist
```

2. Run the application by going into the dist/mac-arm64 folder and clicking the VivCal.app/Electron.app file.

You should now have Vivcal running on your machine.

Logs for this are available at `~/Library/Application\ Support/vivcal/logs/main.log`