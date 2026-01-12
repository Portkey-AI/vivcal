# Deploy VivCal

## Build and install the application:

```bash
# 1. Build the distributable
npm run dist

# 2. Kill the running VivCal app (if running)
pkill -9 -f "VivCal.app" || true

# 3. Remove old app and copy fresh (avoids symlink issues)
rm -rf /Applications/VivCal.app && cp -r dist/mac-arm64/VivCal.app /Applications/

# 4. Run the application
open /Applications/VivCal.app
```

## Troubleshooting

**If macOS blocks the app:**
- Go to System Preferences → Security & Privacy → click "Open Anyway"

**If you get a "damaged app" error:**
```bash
xattr -cr /Applications/VivCal.app
```

**Check logs:**
```bash
tail -f ~/Library/Logs/vivcal/main.log
```

## Quick dev mode (skip build):
```bash
npm start
```
