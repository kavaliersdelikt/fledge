---
title: Backups and object storage
---

# Backups and object storage

## Object storage

Server backups, restores, failover and file transfers of large files use an S3-compatible bucket. Turn it on under
**Settings → Panel → Object storage**: bucket, region, endpoint, access key and secret key. **Test connection**
writes, reads and deletes a probe object. The secret key is stored encrypted in the database. *Path-style addressing* stays on for MinIO and most self-hosted storage; turn it off only for AWS S3 buckets with dots in the name if needed.

::: warning The endpoint must be reachable by everyone who transfers data
Presigned URLs go to **node agents and to browsers**. A Docker-only hostname such as `minio` or `localhost` will not
work from remote nodes. Use TLS outside private test networks.
:::

The `S3_*` variables in `.env` only seed the form before the first save. For a trial there is a bundled SeaweedFS
service:

```sh
docker compose --profile bundled-s3 up -d
```

Without object storage, backups, restores and backup schedules return `503`; everything else works, and file
transfers are spooled on the API host (`TRANSFER_DIR`, a Compose volume).

## How server backups work

- Backups are verified `tar.gz` archives. Scheduled verification checks integrity and safe extraction (it does not
  boot the game).
- On nodes with [disk limits](/agent/disk-limits), a running server is backed up from a frozen point-in-time snapshot of
  its volume while it keeps running (Minecraft first flushes and pauses world saving).
- Elsewhere the game is stopped cleanly for the archive.
- Retention is per server: automatic backups older than the configured number of days are deleted (0 keeps everything).
- Restore stages files and swaps them into place where the filesystem allows.

Backups are crash-consistent, not game-aware. Validate recovery with your game before relying on it.

See [Backups and restore](/panel/backups) for the user view.

## Backing up the panel itself

The panel database holds accounts, servers, schedules, plugin state and the audit log.

```sh
docker compose exec -T postgres pg_dump -U fledge fledge | gzip > fledge-$(date +%F).sql.gz
```

Also keep `.env` (especially `ENCRYPTION_KEY`). Updates take a dump automatically into `.backups/`, but that is not a
substitute for a backup stored elsewhere.

To restore into a fresh install, start the stack, stop the `api`, load the dump into the empty `fledge` database,
start the `api` again, and use the original `.env`.

## Cross-node recovery

Re-creating a server on another node from a backup is automated by [failover](/operate/failover). A manual recovery:
create a replacement server on another node, restore the backup, verify the game, then update any DNS or port
records players use.
