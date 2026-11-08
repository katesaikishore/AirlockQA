# Encrypted local-to-cloud sync

`airlock sync` uploads the files a local run produces — traces, checkpoints, healing logs, fixtures and bug capsules —
to your Airlock Cloud account. Everything is encrypted **on your machine** before it leaves the process. The service
never receives `AIRLOCK_SYNC_KEY` and cannot read the files.

## What is uploaded

| Kind | Default directory |
| :--- | :--- |
| `trace` | `.airlock/traces/*.json` |
| `checkpoint` | `.airlock/checkpoints/*.json` |
| `healing` | `.airlock/dataset/**` |
| `fixtures` | `.airlock/shadow/*.json` |
| `capsule` | `.airlock/capsules/*.json` |

Files larger than 2 MB are skipped. Each workspace can store 200 artifacts and 50 MB in total.

## Commands

```bash
# Required on the machine that uploads and downloads. At least 12 characters.
export AIRLOCK_SYNC_KEY='a long passphrase only you know'

airlock sync                              # upload every kind
airlock sync --kind trace,checkpoint      # only those kinds
airlock sync --dry-run                    # list files, send nothing
airlock sync --json                       # machine-readable result

airlock sync list                         # metadata only
airlock sync download sync_abc123 --out ./checkpoint.json
```

The upload is AES-256-GCM with a scrypt-derived key (16-byte salt, 12-byte IV, authentication tag). The server stores
the envelope as opaque bytes plus metadata: kind, display name, plaintext size, stored size, SHA-256 (of the plaintext,
computed by the client), content type and creation time. It cannot verify that hash; it is for display and integrity
checks after decryption.

## What the server sees

- The account/workspace and the API key used.
- The display name (a relative path such as `.airlock/traces/checkout.json`), kind, sizes, timestamps.
- The ciphertext. Not the plaintext, cookies, storage, DOM, URLs or event contents.

## Limits and honest caveats

- **Losing `AIRLOCK_SYNC_KEY` means the uploaded artifacts cannot be recovered.** There is no key escrow and no reset.
- **Checkpoints and capsules are sensitive.** They can contain cookies, session storage, DOM content and form values. The
  upload is encrypted, but review what a checkpoint contains before syncing it.
- The server cannot scan encrypted content for secrets or malware. Treat it as an opaque blob store.
- Sync does not make a checkpoint available to a hosted run. It is a backup/transfer path, not cross-run state.
- The console lists the metadata and downloads the encrypted envelope; decrypt it with `airlock sync download`.
- Deleting an artifact removes the metadata and the ciphertext file; it cannot be undone.

## HTTP API

`POST /v1/sync/artifacts` takes `{ kind, name, contentType, plaintextSize, sha256, payloadBase64, encrypted: true }`.
`GET /v1/sync/artifacts` lists metadata, `GET /v1/sync/artifacts/:id` returns the ciphertext and
`DELETE /v1/sync/artifacts/:id` removes it. All routes require an API key or a signed-in session and are scoped to the
owning workspace.
