# OmniAI Studio Desktop (Electron — Windows & Cross-Platform)

This directory contains the hardened Electron desktop shell and Windows packaging configuration for OmniAI Studio.

## Security Model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`.
- Only folders explicitly selected via the native OS folder picker (or explicitly verified recent project history) are added to `authorizedWorkspaces`.
- All file operations validate containment with `resolveSafeProjectPath` (blocks `..`, `.git`, `node_modules`, `.env*`, and private key extensions).
- All terminal commands pass `validateDesktopCommand` (blocks shell metacharacters, enforces `npm`, `npx`, `node`, `git` allowlist, blocks dangerous git flags such as `-c`, `--upload-pack`, `--exec`), and require native user confirmation.
- Mutating Git commands (`commit`, `pull`, `push`, `checkout`) trigger confirmation and pre-sync snapshot backups in `.omniai-backups/`.
- External links opened via `shell.openExternal` are validated (`http://localhost`, `http://127.0.0.1`, or `https://github.com`).

## Running Locally on Windows

1. Build the OmniAI Studio web bundle from the repository root:

```powershell
npm install
npm run build
```

2. Install Electron desktop dependencies and compile TypeScript:

```powershell
cd desktop
npm install
npm run build
```

3. Start the OmniAI Studio backend server from the repository root (in Terminal 1):

```powershell
npm run dev
```

4. Launch Electron pointed at the local server (Terminal 2, PowerShell):

```powershell
cd desktop
$env:OMNIAI_DESKTOP_URL="http://localhost:3000"
npm start
```

## Windows Installer & Portable Packaging

To generate Windows installers (`.exe` NSIS installer and portable executable) in `desktop/release/`:

```powershell
cd desktop
npm run dist:unpacked   # Verify unpacked layout first
npm run package:win     # Build NSIS installer + portable executable
```

Note: Building Windows `.exe` installers requires Windows (or Wine + `electron-builder` on Linux/macOS) and an internet connection for Electron binaries during packaging.
