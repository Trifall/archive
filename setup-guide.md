# Archive Local Setup Guide

This guide walks through a fresh local setup using Docker Compose for infrastructure and Node.js for the application process.

## Prerequisites

- Node.js 24+
- npm 11+
- Docker with Docker Compose
- A Google Cloud project with YouTube Data API v3 enabled
- A YouTube channel or Brand Account you can authorize with OAuth
- A Kick channel to archive

## 1. Start Infrastructure

Start PostgreSQL/TimescaleDB, PgBouncer, Redis, and FlareSolverr:

```bash
docker compose up -d
```

Check service health:

```bash
docker compose ps
```

Expected local endpoints:

- PostgreSQL: `localhost:5432`
- PgBouncer: `localhost:6432`
- Redis: `localhost:6379`
- FlareSolverr: `localhost:8191`

Verify PgBouncer connectivity:

```bash
node --input-type=module -e "import pg from 'pg'; const { Pool } = pg; const pool = new Pool({ connectionString: 'postgresql://archive:archive@localhost:6432/archive' }); await pool.query('select 1'); await pool.end(); console.log('pgbouncer ok');"
```

Verify FlareSolverr:

```bash
curl -X POST 'http://localhost:8191/v1' \
  -H 'Content-Type: application/json' \
  -d '{"cmd":"sessions.list"}'
```

## 2. Install Dependencies

Install Node dependencies:

```bash
npm install
```

If your user-level npm config has a `before` date that blocks recently published packages, bypass that config for this install only:

```bash
NPM_CONFIG_USERCONFIG=/dev/null npm install
```

## 3. Create `.env`

Create a local environment file:

```bash
cp .env.example .env
```

For the compose-backed local setup, use these values:

```bash
NODE_ENV=development
PORT=3030
HOST=0.0.0.0
LOG_LEVEL=info

REDIS_URL=redis://localhost:6379

META_DATABASE_URL=postgresql://archive:archive@localhost:5432/archive
PGBOUNCER_URL=postgresql://archive:archive@localhost:6432/archive

FLARESOLVERR_BASE_URL=http://localhost:8191

REQUIRE_CLOUDFLARE_IP=false

TMP_PATH=./storage/tmp
VOD_PATH=./storage/vods
LIVE_PATH=./storage/live
```

Generate local secrets:

```bash
openssl rand -hex 32
```

Use one generated value for `ENCRYPTION_MASTER_KEY` and another for `HEALTH_TOKEN`.

Important: `ENCRYPTION_MASTER_KEY` must be exactly 64 hex characters. Do not change it after OAuth credentials have been stored, because encrypted tenant secrets depend on it.

Create local storage directories:

```bash
mkdir -p storage/tmp storage/vods storage/live
```

## 4. Configure Google OAuth

This project uses OAuth Client credentials, not a service account. Service accounts generally cannot upload to a normal YouTube channel because YouTube uploads require user or Brand Account consent.

In Google Cloud Console:

1. Create or select a project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen.
4. Add your Google account as a test user if the OAuth app is in testing mode.
5. Create an **OAuth client ID**.
6. Use **Desktop app** or **Web application**.
7. If using Web application, add redirect URI `http://localhost:9999/callback`.

Put the OAuth values in `.env`:

```bash
YOUTUBE_CLIENT_ID=<your-oauth-client-id>
YOUTUBE_CLIENT_SECRET=<your-oauth-client-secret>
```

The YouTube upload channel is chosen later during OAuth authorization. When the browser opens, select the Google account or Brand Account that owns the target YouTube channel.

## 5. Create A Tenant

A tenant is the channel being tracked, recorded, archived, and uploaded. Each tenant has a metadata record and its own streamer database.

Run the interactive wizard:

```bash
npm run create:tenant
```

Recommended values for a local Kick-to-YouTube setup:

- Tenant ID: lowercase letters, numbers, and underscores only, max 25 chars.
- Display name: public channel name, with normal capitalization.
- Enable Twitch: usually `no` for Kick-only setup.
- Enable Kick: `yes`.
- Kick user ID: numeric Kick user ID.
- Kick username: public Kick username.
- Main platform: `yes` for Kick if Kick is the only enabled platform.
- Description template: text appended to generated YouTube descriptions, for example `Recorded live on Kick: https://kick.com/<username>`.
- YouTube VOD visibility: `unlisted`, `private`, or `public`.
- YouTube game visibility: `unlisted`, `private`, or `public`.
- Enable VOD uploads: `yes`.
- Per-game upload: optional. Use `no` unless you specifically want game/chapter clips uploaded separately.
- Split duration: seconds per YouTube part. Six hours is `21600`.
- Live upload: optional. Use `no` for simpler post-stream uploads.
- Multi-track audio upload: optional. Use `no` unless your source files need it.
- Domain name: for local-only setups, `localhost:3030` is acceptable. For real public descriptions, use your public archive domain.
- Timezone: use an IANA timezone like `America/New_York`.
- Download chat logs: `yes` if you want chat replay data.
- Download VODs: `yes` if you want the system to produce uploadable files after streams end.
- Save HLS: `no` if you do not want to keep local HLS archives.
- Save MP4: `no` if you do not want to keep local MP4 archives after processing/upload.
- CDN: `no` for local-only setup.

`vodDownload` controls whether the app downloads the VOD to create uploadable files. `saveMP4` and `saveHLS` control whether local archive copies are retained after processing.

## 6. Manual Tenant Creation Fallback

If the interactive tenant wizard cannot run in your shell, create the tenant manually.

Create the streamer database:

```bash
docker compose exec -T postgres createdb -U archive <tenant_id>
```

Apply the streamer schema:

```bash
docker compose exec -T postgres psql -U archive -d <tenant_id> < scripts/migrations/streamer-schema.sql
```

Insert the tenant metadata row:

```bash
docker compose exec -T postgres psql -U archive -d archive -c "
INSERT INTO tenants (id, display_name, kick, youtube, database_name, settings, status)
VALUES (
  '<tenant_id>',
  '<Display Name>',
  '{"enabled":true,"id":"<kick_user_id>","username":"<kick_username>","mainPlatform":true}'::jsonb,
  '{"description":"Recorded live on Kick: https://kick.com/<kick_username>","vodVisibility":"unlisted","gameVisibility":"unlisted","vodUpload":true,"perGameUpload":false,"restrictedGames":[],"splitDuration":21600,"liveUpload":false,"multiTrack":false,"upload":true}'::jsonb,
  '<tenant_id>',
  '{"domainName":"localhost:3030","timezone":"America/New_York","chatDownload":true,"vodDownload":true,"saveHLS":false,"saveMP4":false,"cdn":{"enabled":false,"baseUrl":""}}'::jsonb,
  'active'
);
"
```

Verify the tenant:

```bash
docker compose exec -T postgres psql -U archive -d archive -c "SELECT id, display_name, database_name, kick, youtube, settings FROM tenants WHERE id = '<tenant_id>';"
```

Verify the streamer DB through PgBouncer:

```bash
node --input-type=module -e "import pg from 'pg'; const { Pool } = pg; const pool = new Pool({ connectionString: 'postgresql://archive:archive@localhost:6432/<tenant_id>' }); const result = await pool.query('select count(*)::int as vods from vods'); console.log(result.rows[0]); await pool.end();"
```

## 7. Authorize YouTube Uploads

After the tenant exists and `.env` contains `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`, authorize the tenant:

```bash
npm run auth:youtube -- <tenant_id> --open
```

When the browser opens:

1. Select the Google account or Brand Account for the desired YouTube channel.
2. Approve the requested YouTube scopes.
3. The callback server listens on `http://localhost:9999/callback`.
4. The script stores the OAuth token encrypted in the tenant metadata row.

If browser callback mode does not work, run without `--open` and paste the returned callback URL or authorization code into the terminal:

```bash
npm run auth:youtube -- <tenant_id>
```

## 8. Optional YouTube Playlist

To add each uploaded video to a YouTube playlist, set `youtube.playlistId` on the tenant.

Find the playlist ID from a playlist URL. Examples:

- `https://www.youtube.com/playlist?list=<playlist_id>`
- `https://studio.youtube.com/playlist/<playlist_id>/videos`

Update the tenant:

```bash
docker compose exec -T postgres psql -U archive -d archive -c "
UPDATE tenants
SET youtube = jsonb_set(youtube, '{playlistId}', to_jsonb('<playlist_id>'::text), true),
    updated_at = CURRENT_TIMESTAMP
WHERE id = '<tenant_id>';
"
```

Verify it:

```bash
docker compose exec -T postgres psql -U archive -d archive -c "SELECT youtube ->> 'playlistId' AS playlist_id FROM tenants WHERE id = '<tenant_id>';"
```

Playlist insertion happens after a successful YouTube upload. If playlist insertion fails, the upload job logs the playlist error but does not fail the upload, avoiding duplicate videos on retry.

## 9. Run The App

Run only the API:

```bash
npm run api
```

Run workers:

```bash
npm run workers
```

Run both API and workers:

```bash
npm run all
```

The API serves Swagger docs in development at:

```text
http://localhost:3030/docs
```

## 10. Verification Commands

After setup or code changes, run:

```bash
npm exec -- tsc --noEmit
npm run lint
npm test
npm run format
```

A short API startup smoke test:

```bash
timeout 8s npm run api
```

## 11. Useful Maintenance Commands

Stop infrastructure:

```bash
docker compose down
```

Stop infrastructure and remove local database/Redis volumes:

```bash
docker compose down -v
```

View service logs:

```bash
docker compose logs <service>
```

Examples:

```bash
docker compose logs postgres
docker compose logs pgbouncer
docker compose logs redis
docker compose logs flaresolverr
```

## 12. Notes And Gotchas

- `.env` is ignored by git and should contain local secrets.
- Do not commit OAuth client secrets, health tokens, encryption keys, or tenant-specific OAuth tokens.
- Keep `ENCRYPTION_MASTER_KEY` stable once encrypted credentials have been stored.
- `REQUIRE_CLOUDFLARE_IP=false` is appropriate for local-only testing.
- `saveMP4=false` and `saveHLS=false` reduce retained local files, but temporary processing files are still created while jobs run.
- YouTube uploads require OAuth user consent; service accounts are not appropriate for normal channel uploads.
- If the OAuth app remains in Google testing mode, refresh tokens may expire according to Google testing-app behavior.
