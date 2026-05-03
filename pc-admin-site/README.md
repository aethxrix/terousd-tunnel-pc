# Terousd Tunnel PC Admin

Compact Firebase Hosting admin panel for the PC client.

It manages only:

- HTTP proxy servers
- SOCKS5 proxy servers
- PC usage counters

## Firebase

Project created for this PC build:

```text
YOUR_FIREBASE_PROJECT_ID
```

Firestore database:

```text
(default), asia-south1
```

Deploy rules and hosting:

```powershell
firebase deploy --project YOUR_FIREBASE_PROJECT_ID
```

## Auth

Enable Firebase Authentication -> Google provider in the Firebase Console, then set your admin email in `public/firebase-config.js`.

```text
you@example.com
```
