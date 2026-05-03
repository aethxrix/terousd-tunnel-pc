# Terousd Tunnel PC Admin

Compact Firebase Hosting admin panel for forked PC builds.

It manages only:

- HTTP proxy servers
- SOCKS5 proxy servers
- Name-only bug-host groups
- PC usage counters

## Configure Your Fork

Create your own Firebase project, enable Firestore, enable Firebase Authentication with the Google provider, then update:

```text
public/firebase-config.js
firestore.rules
.firebaserc
```

Replace `YOUR_FIREBASE_PROJECT_ID` and the other `YOUR_FIREBASE_*` placeholders with your Firebase Web App config. Replace `you@example.com` with the Google account that should be allowed to manage servers.

## Deploy

```powershell
firebase login
firebase deploy --project YOUR_FIREBASE_PROJECT_ID
```

After deploy, open your Firebase Hosting URL, sign in, add servers and bug-host groups, then click `Publish` so the PC client can download `pcPublic/config`.
