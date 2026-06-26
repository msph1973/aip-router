# AIP Router

Router API pribadi yang mem-proxy ke **Ingrazzio** (production endpoint). Mendukung multi-token, format translation (OpenAI ↔ Anthropic), streaming, dan berbagai fitur penghemat token.

## Fitur

- **Multi-Token Support** — routing model dengan prefix token: `aip/claude-sonnet-4-6`, `junp36/claude-sonnet-4-6`, `junp300/claude-sonnet-4-6`
- **Token Fallback** — jika token pertama gagal (401/429/403), auto-try token berikutnya
- **Format Translation** — OpenAI API → Anthropic API (dan sebaliknya), termasuk streaming SSE
- **RTK (Raw Token Killer)** — kompresi otomatis tool result di context (git diff, log, dll)
- **Caveman Mode** — prompt injection untuk respon super-ringkas (lite/full/ultra)
- **Ponytail Mode** — prompt injection untuk output kode minimal tanpa penjelasan
- **Headroom Mode** — inject warning ke user message saat context window mendekati penuh
- **CLI & TUI** — interactive menu (`aip-router`) dan dashboard blessed (`aip-tui`)

## Instalasi

```bash
git clone https://github.com/msph1973/aip-router.git
cd aip-router
npm install
npm link   # bikin global symlink untuk aip-router dan aip-tui
```

## Konfigurasi

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AIP_TOKENS` | `""` | Multi-token: `name1:token1,name2:token2` |
| `PORT` | `20129` | Port server |
| `RTK_ENABLED` | `true` | Aktifkan RTK compression |
| `CAVEMAN_ENABLED` | `false` | Aktifkan Caveman mode |
| `CAVEMAN_LEVEL` | `full` | Level: `lite`, `full`, `ultra` |
| `PONYTAIL_ENABLED` | `false` | Aktifkan Ponytail mode |
| `HEADROOM_ENABLED` | `false` | Aktifkan Headroom mode |
| `HEADROOM_THRESHOLD` | `80` | Threshold % context window |

### Token Sources

Token bisa didapat dari:
- IDE → Help → AI License → Copy token (format `perm-xxx`)
- File `~/.junie/secure_credentials.json`

Tipe token yang sudah terverifikasi:

| Token | License Type | Limit |
|---|---|---|
| AIP 1M CREDITS | `AIP` | ~998K CREDITS |
| JUNP $36 | `JUNP` | $36.06 USD |
| JUNP $300 | `JUNP` | $299.99 USD |

> **Catatan**: JUNP tokens mengabaikan license headers (`X-Accept-EAP-License`, `X-Accept-Release-License`) — selalu return `licenseType: JUNP`.

### Config File

CLI/TUI menyimpan konfigurasi di `~/.aip-router/config.json`.

## Cara Pakai

### CLI

```bash
aip-router
```

Menu interaktif:
- `1-4` — Toggle fitur (RTK/Caveman/Ponytail/Headroom)
- `t` — Set token
- `p` — Set port
- `s` — Start server
- `x` — Stop server
- `l` — Lihat logs
- `q` — Quit

### TUI Dashboard

```bash
aip-tui
```

Dashboard blessed dengan panel config, request log, dan real-time stats.

### API (OpenAI-compatible)

Setelah server jalan, gunakan sebagai drop-in replacement untuk OpenAI API:

```bash
curl -X POST http://localhost:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "aip/claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

Model prefix syntax:
- `aip/claude-sonnet-4-6` — pake token `aip`
- `junp36/claude-sonnet-4-6` — pake token `junp36`
- `junp300/claude-sonnet-4-6` — pake token `junp300`
- `claude-sonnet-4-6` — pake token default (token pertama)

Streaming didukung penuh dengan SSE baik untuk OpenAI maupun Anthropic models.

#### Health Check

```bash
curl http://localhost:20129/health
```

Returns status server, tokens terkonfigurasi, dan status fitur.

## Fitur Detail

### RTK (Raw Token Killer)

Otomatis mendeteksi dan mengompresi tool result besar di context:

| Filter | Detection | Behavior |
|---|---|---|
| `gitDiff` | `diff --git` header | Hanya simpan metadata file, line stats, header |
| `gitStatus` | `On branch`, `nothing to commit` | Compact ke 1 baris per state |
| `grep` | `filepath:line:content` | Max 10 match per file |
| `find` | Path-like entries | Max 10 per dir, 20 total |
| `ls` | `total N`, permission rows | Group by extension, skip noise dirs |
| `dedupLog` | Default fallback untuk non-empty text | Hapus line duplikat berurutan, max 2000 lines |
| `smartTruncate` | ≥250 lines text tanpa match lain | Head 120 lines + tail 60 lines + "... truncated" |

Threshold: skip if <500 bytes or >10MB raw.

### Caveman Mode

3 level prompt injection untuk respon lebih ringkas:

| Level | Style | Contoh |
|---|---|---|
| `lite` | Tenses tanpa filler | Drop "just/really/basically/sure" |
| `full` | Caveman grammar | Drop articles, fragments OK |
| `ultra` | Telegraphic | Abbrev, arrows (X → Y), 1 word |

Semua level menjaga boundaries: code blocks, paths, commands, errors, URLs tetap eksak.

### Ponytail Mode

System prompt "lazy senior dev" — output kode minimal, tanpa penjelasan, tanpa kode nganggur.

### Headroom Mode

Estimasi context window (karakter ÷ 3.5 = tokens), inject warning ke last user message jika melebihi threshold (default 80% dari 200K atau 100K window).

## Arsitektur

```
aip-router/
├── bin/
│   ├── aip-router      # Interactive CLI (readline)
│   └── aip-tui          # TUI dashboard (blessed)
├── prompts/
│   ├── caveman.js       # Caveman prompt injection
│   └── ponytail.js      # Ponytail prompt injection
├── rtk/
│   ├── index.js         # Kompresi engine
│   ├── constants.js     # Threshold constants
│   ├── autodetect.js    # Auto-detect filter by content
│   ├── applyFilter.js   # Safe filter application
│   └── filters/         # Individual filters
│       ├── gitDiff.js
│       ├── gitStatus.js
│       ├── grep.js
│       ├── find.js
│       ├── ls.js
│       ├── dedupLog.js
│       └── smartTruncate.js
├── config.js            # Multi-token env parser
├── headroom.js          # Context window estimator
├── ingrazzio.js         # Proxy + format translation
├── server.js            # Express server + routing
└── package.json
```

### Alur Request

1. Client → `POST /v1/chat/completions` (OpenAI format)
2. `server.js` resolve model + pilih token
3. **RTK** compress tool result di messages
4. **Caveman/Ponytail/Headroom** inject system prompts
5. Jika model Anthropic → `ingrazzio.js` translate OpenAI → Anthropic
6. `tryProxy()` loop through tokens sampai sukses
7. Response: streaming (SSE) atau non-streaming, dengan format translation jika perlu

### Endpoint

- `https://ingrazzio-cloud-prod.labs.jb.gg` — production only
- Anthropic path: `/v1/messages`
- OpenAI path: `/v1/chat/completions`
- Auth: `Authorization: Bearer <perm-token>` (no OAuth)
- Required headers: `X-LLM-Model`, `X-Keep-Path`, license headers

### Catatan Penting

- GPT models pake `max_completion_tokens` bukan `max_tokens` — router auto-convert
- GPT streaming auto-add `stream_options: { include_usage: true }`
- $300 token mungkin punya trailing dot di token string — hapus titiknya
