#!/usr/bin/env node
/**
 * VivCal Setup Script
 * Helps users set up the required configuration for VivCal
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT_DIR = path.join(__dirname, '..');
const CREDS_PATH = path.join(ROOT_DIR, 'google-creds.json');
const ENV_PATH = path.join(ROOT_DIR, '.env');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

function printHeader() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    VivCal Setup Wizard                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
}

function printStep(num, title) {
  console.log(`\n📌 Step ${num}: ${title}`);
  console.log('─'.repeat(50));
}

async function checkGoogleCreds() {
  printStep(1, 'Google Calendar Credentials');
  
  if (fs.existsSync(CREDS_PATH)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
      if (creds.installed?.client_id && creds.installed?.client_secret) {
        console.log('✅ google-creds.json found and valid!');
        return true;
      }
    } catch (e) {
      console.log('⚠️  google-creds.json exists but appears invalid');
    }
  }
  
  console.log('❌ google-creds.json not found or invalid\n');
  console.log('To set up Google Calendar credentials:');
  console.log('');
  console.log('  1. Go to https://console.cloud.google.com/');
  console.log('  2. Create a new project (or select existing)');
  console.log('  3. Enable the "Google Calendar API"');
  console.log('  4. Go to "APIs & Services" → "Credentials"');
  console.log('  5. Click "Create Credentials" → "OAuth client ID"');
  console.log('  6. Select "Desktop app" as application type');
  console.log('  7. Download the JSON and save as google-creds.json');
  console.log('');
  console.log('  Make sure redirect_uris includes:');
  console.log('    http://localhost:7175/auth/google/callback');
  console.log('');
  
  const answer = await question('Press Enter when ready, or type "skip" to continue: ');
  return answer.toLowerCase() !== 'skip' && fs.existsSync(CREDS_PATH);
}

async function checkPortkeyKey() {
  printStep(2, 'Portkey API Key (Optional)');
  
  // Check if .env exists and has PORTKEY_API_KEY
  if (fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    if (envContent.includes('PORTKEY_API_KEY=') && !envContent.includes('PORTKEY_API_KEY=your_')) {
      console.log('✅ Portkey API key configured!');
      return true;
    }
  }
  
  console.log('ℹ️  Portkey API key not configured\n');
  console.log('The Portkey API enables AI-powered natural language event creation.');
  console.log('Without it, VivCal will use basic date parsing (still works!).\n');
  
  const key = await question('Enter your Portkey API key (or press Enter to skip): ');
  
  if (key && key.trim()) {
    const envContent = `# Portkey API Key for AI-powered quick event creation\nPORTKEY_API_KEY=${key.trim()}\n`;
    fs.writeFileSync(ENV_PATH, envContent);
    console.log('✅ Portkey API key saved to .env');
    return true;
  }
  
  console.log('⏭️  Skipped - VivCal will use basic date parsing');
  return false;
}

async function runSetup() {
  printHeader();
  
  console.log('This wizard will help you configure VivCal.\n');
  
  const hasGoogleCreds = await checkGoogleCreds();
  const hasPortkey = await checkPortkeyKey();
  
  console.log('\n' + '═'.repeat(50));
  console.log('\n📋 Setup Summary:\n');
  console.log(`  Google Credentials: ${hasGoogleCreds ? '✅ Ready' : '❌ Missing'}`);
  console.log(`  Portkey API Key:    ${hasPortkey ? '✅ Configured' : '⏭️  Skipped (optional)'}`);
  
  if (hasGoogleCreds) {
    console.log('\n🚀 You\'re ready to run VivCal!\n');
    console.log('  Start the app with: npm start');
    console.log('  Or build it with:   npm run dist\n');
  } else {
    console.log('\n⚠️  Please configure google-creds.json before running VivCal.\n');
  }
  
  rl.close();
}

runSetup().catch(err => {
  console.error('Setup error:', err);
  rl.close();
  process.exit(1);
});

