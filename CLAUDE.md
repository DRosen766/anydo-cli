# anydo-cli

Unofficial Any.do CLI. Single-file Node.js project — all logic lives in `bin.js`.

## Architecture

Everything is in `bin.js`. No build step. Run directly with `node bin.js <command>`.

**Key globals:**
- `cli` — meow instance, parses `cli.input[0]` (command) and `cli.flags`
- `config` — conf instance, persists auth token at `~/Library/Preferences/` (outside repo)
- `postForm` / `postJSON` — promise-based HTTPS helpers (no external HTTP lib)
- `syncData(auth)` — wraps `anydo.sync` in a Promise, returns full body with `models.task` and `models.category`

**Command routing** is a `switch` on `cli.input[0]` at the bottom of the file.

## API

Base host for reads (via `anydo` npm package): `sm-prod2.any.do`
Base host for writes and OAuth: `sm-prod4.any.do`

**Endpoints in use:**
- `POST /login` — email/password login (via anydo package)
- `POST /google-login` — Google OAuth exchange, body: `{ id_token, platform, referrer, create_predefined_data }`
- `POST /microsoft-login` — Microsoft OAuth exchange (endpoint unconfirmed — may 404)
- `POST /api/v2/me/sync?updatedSince=0` — read tasks + categories; also used to create tasks by including them in `models.task.items`

**Auth:** `X-Anydo-Auth` header on all API calls. Token format is `base64(email:timestamp:hash)` — email is extractable via `Buffer.from(auth, 'base64').toString().split(':')[0]`.

**Token storage:** `config.get/set('anydo.auth')` — stored by `conf`, never in the repo.

## Commands

| Command | Description |
|---|---|
| `login` | Email/password login |
| `login-google` | Google OAuth device flow (requires `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` env vars) |
| `login-microsoft` | Microsoft OAuth device flow using Any.do's Azure app ID — device flow currently blocked by Azure (AADSTS70002) |
| `add "title"` | Create task; `--list "Name"` to specify list, defaults to Personal |
| `done "partial title"` | Mark a task as done (partial title match, like `delete`) |
| `tasks` / default | List tasks with due dates; flags: `--done`, `--deleted`, `--undated`, `--checked` |
| `logout` | Clears stored auth token |

## Auth setup (current working method)

Microsoft device flow is blocked. Manual token injection works:
1. Log into app.any.do in browser
2. DevTools → Network → filter `sm-prod4.any.do` → copy `X-Anydo-Auth` request header
3. `node -e "new (require('conf'))().set('anydo.auth', 'TOKEN')"`

Token expires periodically — repeat when `node bin.js` returns an auth error.

## Known limitations

- `login-microsoft` device flow blocked (Any.do's Azure app not registered as public/mobile client)
- `login-google` requires user to create a Google Cloud OAuth Desktop app
- No due date support on `add` command yet
- `anydo` npm package hardcodes `sm-prod2.any.do` — may break if that host is deprecated

## Dependencies

- `anydo` — unofficial API wrapper (login + sync)
- `meow` — CLI arg parsing
- `conf` — persistent config storage
- `update-notifier` — checks npm for new versions
- Node built-ins: `https`, `querystring`, `crypto`
