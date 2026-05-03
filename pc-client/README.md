# Terousd Tunnel PC

Open-source Windows desktop client for HTTP and SOCKS5 proxy VPN mode.

## Features

- Windows full-device TUN mode powered by `sing-box`
- HTTP proxy outbound
- SOCKS5 proxy outbound
- Firebase-hosted PC config
- PC usage heartbeat after 60 seconds connected
- Automatic TUN restart if the engine exits unexpectedly
- Single-instance tray app
- Terousd desktop logo and app icon

The PC client intentionally does not include Android code, SSH, V2Ray, or OpenVPN.

## Firebase

Default project for this build:

```text
YOUR_FIREBASE_PROJECT_ID
```

The PC app reads published config from:

```text
pcPublic/config
```

The admin website manages draft servers in:

```text
pcServers
```

## Run

```powershell
npm install
npm start
```

## Build

```powershell
npm run package:win
```

The Windows build is written to:

```text
dist
```

## Configuration

Change the Firebase project in:

```text
src/config/firebaseProject.js
```

Only HTTP and SOCKS5 server records are used by the client.

## License

MIT
