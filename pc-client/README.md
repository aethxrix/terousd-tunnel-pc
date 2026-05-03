# Terousd Tunnel PC Client

Open-source Windows desktop client for forked HTTP and SOCKS5 proxy VPN builds.

## Features

- Windows full-device TUN mode powered by `sing-box`
- HTTP proxy outbound
- SOCKS5 proxy outbound
- Firebase-hosted PC config
- PC usage heartbeat after 60 seconds connected
- Automatic TUN restart if the engine exits unexpectedly
- Single-instance tray app
- Desktop logo and app icon

The PC client intentionally does not include Android code, SSH, V2Ray, or OpenVPN.

## Configure Your Fork

Update the Firebase project settings in:

```text
src/config/firebaseProject.js
```

Use the same Firebase project as your admin website. The PC app reads published config from:

```text
pcPublic/config
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

Only HTTP and SOCKS5 server records are used by the client.

## License

MIT
