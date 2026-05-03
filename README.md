# Terousd Tunnel PC

Open-source PC-only tunnel client and compact admin website.

This repository contains only:

- `pc-client`: Windows Electron client for HTTP/SOCKS5 proxy VPN mode
- `pc-admin-site`: Firebase Hosting admin site for PC HTTP/SOCKS5 servers

It does not include Android source code, the Android admin website, SSH, V2Ray, or OpenVPN.

## Live PC Admin Site

```text
Deploy your Firebase Hosting site and put the URL here.
```

## Firebase Project

```text
YOUR_FIREBASE_PROJECT_ID
```

Firestore database:

```text
(default), asia-south1
```

## Run PC Client

```powershell
cd pc-client
npm install
npm start
```

## Build PC Client

```powershell
cd pc-client
npm run package:win
```

## Deploy PC Admin Website

```powershell
cd pc-admin-site
firebase deploy --project YOUR_FIREBASE_PROJECT_ID
```

Enable Firebase Authentication -> Google provider for the admin website. Then set your admin email in:

```text
pc-admin-site/public/firebase-config.js
```

## Security Note

This is an open-source PC client. Anyone can inspect and modify the Firebase project settings in the source. For a private commercial build, put config delivery behind your own backend gate and rotate project IDs/keys for each deployment.

## License

MIT
