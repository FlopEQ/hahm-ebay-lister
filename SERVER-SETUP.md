# AI eBay Lister: server setup

This package contains the updated source application, not a prebuilt executable.
Build it on the destination server so dependencies match that server's operating system.
Node.js 22 or a compatible newer version, npm, and persistent writable local storage
with hard-link support (NTFS on Windows) are required.

## New installation

1. Extract the zip. Open a terminal in its `ai-ebay-lister` folder.
2. Create `.env` by copying `.env.example` (Linux: `cp .env.example .env`; Windows PowerShell: `Copy-Item .env.example .env`).
3. Edit `.env`. Select `AI_PROVIDER=openai` or `anthropic` and add that provider's API key.
   Set `APP_SECRET` to an access code. Production API requests require it.
   For eBay, set `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, and `EBAY_RU_NAME` from the same Production keyset.
   Set `SESSION_SECRET` to a random secret of at least 32 characters. Generate one with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Set `APP_URL=https://your-domain.example` to your own public HTTPS hostname.
   If you have no enabled eBay inventory location, set `EBAY_LOCATION_POSTAL_CODE` to your actual shipping ZIP.
4. Install, build, and start:

```sh
npm ci
npm run build
npm start
```

The app listens on port **3001**. Keep it running with your server's service manager if it must survive terminal closure or reboot.
For verification after building: `npm test` and `npm run typecheck`.

## Higher-resolution eBay photos

New photos keep a separate bounded JPEG up to 2400 pixels for eBay, without
upscaling small originals. AI analysis stays at 1024 pixels and sorting uses
360-pixel thumbnails, so larger listing photos do not enlarge AI requests.
Single-item listings, including books, support up to 24 selected photos.

Photo uploads now use eBay's Media API and the existing inventory permission.
Confirmed upload receipts are preserved on interruption, and creating photos
is never automatically retried after an uncertain response. Review the item
and retry the unfinished upload when ready.

Higher-resolution JPEGs are stored privately under data/photo-assets/ (or that
folder within WORKSPACE_DATA_DIR). Back up the entire data folder: batch JSON
alone cannot restore these photos. Duplicated batches share immutable photos;
unused photos are removed after a seven-day grace period. Active, archived,
duplicated, and legacy saved batches protect all photos they reference, even
after the items are posted to eBay. Reusing a photo resets its cleanup age.

Cleanup begins after the first authenticated app use following a restart and
checks hourly while the server runs. Removing a saved photo reference or
deleting a batch also triggers a scan. Unreadable batch files or cleanup
metadata pause deletion. Newly imported, unsaved photos get the same grace
period. Cleanup is not a deleted-batch undo feature; keep backups.

Back up all of data/, including photo-cleanup.json, together. These checks
run within the app and require ordinary local storage directories; no external
scheduled task or cloud service is needed.

Old batches keep their existing resolution and upload receipts. Add the
original photos again to get higher-resolution uploads on those items.
An unreadable or missing saved JPEG stops the upload rather than lowering
photo quality. No apparel pricing or cloud storage changes are included.

## Balanced Claude and cost tracking

With AI_PROVIDER=anthropic, choose Recommended default for both selectors under
Model Settings to use Sonnet 5.5 for sorting and listing writing. Explicit saved
choices from an earlier version are preserved until you change them.
Classification and specifics also use Sonnet 5.5. Sonnet extraction has no
up-front thinking, retries stay on the chosen model, and no automatic premium
escalation occurs. Opus 5.5 remains a manual option for difficult items; Haiku
sorting is an optional trial whose accuracy should be compared on your photos.

The app shows estimated AI cost per item and per batch using reported token
and cache usage. Missing usage or unknown prices display Unavailable. Estimates
use standard global list prices as of October 8, 2026, not invoice totals. Old
batches have no retroactive estimates; a lost response can still be billed.

Update the application source and both dependency files from this release,
then reinstall and rebuild. Keep your .env and data directory. This release
needs the updated Anthropic SDK included in package-lock.json.

## Cloudflare Tunnel and eBay

- Public hostname: `your-domain.example`
- Path: leave blank
- Service type: **HTTP**
- Service URL: `localhost:3001` (or `127.0.0.1:3001`)
- Full local service: `http://127.0.0.1:3001`

Use localhost only if cloudflared runs on the same server as this app.
Visitors use the public HTTPS address. The direct local app does not serve HTTPS on port 3001.
Keep your existing tunnel if it is already configured correctly; Caddy is unnecessary for this direct tunnel route.

Configure the app's corresponding eBay RuName with OAuth:

- Accepted URL: `https://your-domain.example/api/ebay/callback`
- Declined URL: `https://your-domain.example/?ebay=declined`
- Privacy URL: `https://your-domain.example/privacy`

Open the public HTTPS address and use Connect eBay from that same address.
Restart the app after changing environment variables.
To publish: Prepare for eBay, review category/condition/specifics, then stage or publish.

## Updating an existing installation

Stop the existing app and back up its folder first. Extract this release into a new folder.
Copy your existing `.env` and entire `data/` directory into the new folder, or set
`WORKSPACE_DATA_DIR` to the existing persistent data directory. Keep the same
`SESSION_SECRET` if retaining the browser's encrypted eBay connection.
Confirm `APP_URL` matches the public HTTPS hostname, then run the installation commands above.
Do not copy Windows `node_modules` or `.next` to a Linux server; install and build there.
Retain the old folder until the new installation is verified.

## Included and excluded

Source code, locked dependencies, tests, license, README, and a placeholder-only environment example are included.
Real `.env` files, credentials, saved photos/batches, node_modules, build output, machine-specific Caddy configuration,
and the Windows Caddy executable are excluded. Your original project files are unchanged by packaging.

Back up `.env` and the persistent data directory securely. Saved batches and operation receipts require
writable persistent storage; this package does not add cloud background drafting or multi-server coordination.
The code passed 331 automated tests, TypeScript checks, and a production build before packaging.
This release includes Anthropic SDK 0.132.1, Next.js 15.5.27, sharp 0.35.5,
source-map-js 1.2.2, and Vitest 4.1.11. The dependency audit reported zero known
vulnerabilities on October 8, 2026.
Those tests used mocked external services; they do not certify live seller-account configuration.
