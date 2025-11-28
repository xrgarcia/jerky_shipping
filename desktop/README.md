# Jerky Ship Connect

macOS desktop application for warehouse printer management. Connects to ship.jerky.com to receive print jobs in real-time.

## Features

- Sign in with Google Workspace (@jerky.com only)
- Select a packing station
- Discover and register local macOS printers
- Receive and print shipping labels automatically via WebSocket

## Development

### Prerequisites

- Node.js 18+
- macOS (for printer discovery and printing)

### Setup

1. Install dependencies:
   ```bash
   cd desktop
   npm install
   ```

2. Create a `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Configure environment variables:
   - `SERVER_URL` - The ship.jerky.com server URL
   - `WS_URL` - The WebSocket URL for desktop clients
   - `GOOGLE_CLIENT_ID` - Google OAuth client ID (from Google Cloud Console)

4. Start development:
   ```bash
   npm run dev
   ```

   In a separate terminal, start Electron:
   ```bash
   npm start
   ```

### Building

Build the macOS app:
```bash
npm run dist
```

The built application will be in the `release/` directory.

## Architecture

### Main Process (`src/main/`)
- `index.ts` - Application entry point, window management, IPC handlers
- `auth.ts` - Google OAuth PKCE flow with secure token storage
- `websocket.ts` - WebSocket client for real-time print jobs
- `printer.ts` - macOS printer discovery and printing
- `api.ts` - REST API client for server communication
- `preload.ts` - Secure bridge between main and renderer

### Renderer Process (`src/renderer/`)
- React-based UI with Tailwind CSS
- Pages: Login, Station Selection, Dashboard
- Real-time state updates via IPC

### Shared (`src/shared/`)
- Type definitions shared between main and renderer
- Configuration constants

## Security

- API tokens stored in macOS Keychain via `keytar`
- OAuth PKCE flow (no client secret needed)
- Domain restriction to @jerky.com accounts
- Context isolation enabled in Electron
