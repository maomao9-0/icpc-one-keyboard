# One Keyboard

A tiny vanilla HTML/CSS/JS app for ICPC teams practising remotely with the one-keyboard rule. Teams create a short session code, share a join link, claim/release the keyboard, and keep a simple audit log.

Sessions are retained for ten hours after their last activity, including when every participant has the page minimized. Leaving a session is explicit; backgrounding or closing a page does not remove its member. State is stored in an ephemeral `/tmp` file from the Vercel function, so sessions may still reset after redeploys, cold starts, or serverless instance changes.

## Test Locally

Install dependencies:

```sh
npm install
```

Run the Playwright browser test suite:

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

No environment variables or database setup are required.

## Files

- `index.html`: app shell
- `styles.css`: minimal monochrome interface
- `app/`: frontend modules
- `app/main.js`: bootstrap, network calls, event wiring
- `app/state.js`: shared state and constants
- `app/helpers.js`: pure formatting, session, and collection helpers
- `app/views.js`: UI templates for the join screen, session screen, and modals
- `app/live.js`: timer, request countdown, and member presence live updates
- `api/session.js`: ephemeral session API
- `vercel.json`: Vercel config
