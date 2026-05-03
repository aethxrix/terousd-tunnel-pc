# Terousd Tunnel PC

PC-only open-source tunnel client and compact Firebase admin website.

This repository is meant for people who fork it and run their own PC tunnel project. It ships with placeholder Firebase values, so a fork will not work until you create your own Firebase project and replace those placeholders.

## What Is Included

- `pc-client`: Windows Electron client for HTTP and SOCKS5 proxy VPN mode
- `pc-admin-site`: Firebase Hosting admin site for PC servers and name-only bug-host groups
- Firestore rules for public config reads, admin-only server edits, and PC usage heartbeats

This repo intentionally does not include Android source code, the Android admin website, SSH, V2Ray, or OpenVPN.

## Fork Setup

1. Fork or clone this repository.
2. Create a new Firebase project for your fork.
3. Create a Firestore database. The default config uses database id `(default)`.
4. Enable Firebase Authentication and turn on the Google provider.
5. Create a Firebase Web App and copy its web config values.
6. Replace every `YOUR_FIREBASE_*` placeholder with your own Firebase values.
7. Replace `you@example.com` with your own Google admin email.

The Firebase web API key is not treated as a private secret by Firebase, but your Firestore rules are the real security boundary. Do not leave the admin email placeholder in production.

## Files To Configure

Admin website:

```text
pc-admin-site/public/firebase-config.js
pc-admin-site/firestore.rules
pc-admin-site/.firebaserc
```

PC client:

```text
pc-client/src/config/firebaseProject.js
```

Use the same Firebase project in both the admin website and the PC client. The admin site publishes config to `pcPublic/config`, and the PC client reads that document.

## Deploy The Admin Site

Install the Firebase CLI, sign in, then deploy from the admin site folder:

```powershell
cd pc-admin-site
firebase login
firebase deploy --project YOUR_FIREBASE_PROJECT_ID
```

After deployment, open your Firebase Hosting URL, sign in with the admin email you configured, add HTTP/SOCKS5 servers, add bug-host groups if you need them, then click `Publish`.

## Run The PC Client

```powershell
cd pc-client
npm install
npm start
```

The app asks for Windows admin permission because full-device TUN mode needs elevated network changes.

## Build The PC Client

```powershell
cd pc-client
npm run check
npm run package:win
```

The Windows build is created in:

```text
pc-client/dist
```

## Firestore Collections

- `pcPublic/config`: published public config read by the PC app
- `pcServers`: admin-only draft server list
- `pcBugHosts`: admin-only name-only bug-host groups
- `usageUsers`: PC client heartbeat documents

## Security Notes For Forks

This is an open-source PC client, so anyone can inspect and modify the Firebase project settings in their own build. If you need stronger control for a commercial/private service, put config delivery behind your own backend gate and add your own device/app authorization checks.

Never commit private service account files, signing keys, `.env` files, or production-only secrets to a public fork.

## License

MIT
