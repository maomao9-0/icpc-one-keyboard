# One Keyboard

A React + Vite app for ICPC teams practising remotely with the one-keyboard rule. Teams create a short session code, share a join link, claim/release the keyboard, and keep a simple audit log.

Sessions are retained for ten hours after their last activity, including when every participant has the page minimized. Leaving a session is explicit; backgrounding or closing a page does not remove its member. Production sessions are stored in Upstash Redis with a refreshed ten-hour TTL, so they survive Vercel cold starts and function scaling.

## Test Locally

Install dependencies:

```sh
npm install
```

Run the Vite development server:

```sh
npm run dev
```

The Vite development server includes the local `/api/session` handler and uses an in-memory development adapter, so creating and joining sessions works without a separate backend process.

Create a production build:

```sh
npm run build
```

Run the Playwright browser test suite (it builds the Vite client first):

```sh
npm run test:e2e
```

The npm test runner starts an isolated local server on a free port for each run, so concurrent `npm run test:e2e` invocations do not fight over `127.0.0.1:4173`.

To test against `vercel dev`, start Vercel on a separate port and point Playwright at it:

```sh
vercel dev --listen 127.0.0.1:4174
PLAYWRIGHT_BASE_URL=http://127.0.0.1:4174 npm run test:e2e
```

To manually test with Vercel's local runtime, install the Vercel CLI if needed:

```sh
npm i -g vercel
```

Run the app locally:

```sh
vercel dev
```

Open the local URL shown by the CLI, usually:

```txt
http://localhost:3000
```

Recommended manual test:

1. Create a session and copy the join link.
2. Open the link in another browser or incognito window.
3. Claim, release, and request the keyboard from both windows.
4. Enable the timer in settings and confirm the audit log uses contest-relative timestamps.

## Deploy To Vercel

From this directory:

```sh
vercel
```

For production:

```sh
vercel --prod
```

No environment variables are required locally. Production requires the Redis integration below.

## Production storage

Install the **Upstash Redis** integration from the Vercel Marketplace and connect it to this project. Vercel may inject either `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` or the compatible `KV_REST_API_URL` / `KV_REST_API_TOKEN`; both are supported. Production intentionally fails fast if those credentials are absent rather than silently using ephemeral session storage.

## Files

- `src/App.jsx`: application composition and UI components
- `src/hooks/useSessionController.js`: API calls, polling, identity, notifications, and error state
- `src/hooks/useLiveNow.js`: timer, request-expiry, and presence scheduling
- `src/lib/`: pure session and storage utilities
- `public/styles.css`: the preserved monochrome interface, served without weakening the CSP
- `vite.config.js`: Vite + React configuration
- `api/session.js`: atomic Redis-backed session API
- `api/session-store.js`: Upstash Redis and explicit local-test storage adapters
- `vercel.json`: Vercel config
