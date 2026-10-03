# Uninstall

Removes the product from the Server and from managed machines. Order matters:
revoke access first, then tear down.

## 1. Revoke machines (Server side)

In the Web UI, remove each machine. This deletes its record, deletes the
Server-side SSH private key, and closes any live channels immediately.

> Removing a machine cannot delete files on a target that is currently
> unreachable; finish the per-machine step below when it is reachable again.

## 2. Clean up each managed machine

On every machine that was enrolled:

```sh
terminal-agent stop              # stop the background Agent, if running
terminal-agent uninstall         # removes the oh-my-tui:* authorized_keys entry and service config
```

`uninstall` only touches lines carrying this application's marker; unrelated
`authorized_keys` entries and options are preserved.

## 3. Stop and remove the Server

```sh
# keep data (volume) for inspection
docker compose -f deploy/docker-compose.prod.yml down

# or delete containers + the data volume (irreversible)
docker compose -f deploy/docker-compose.prod.yml down -v
```

Remove the image if desired:

```sh
docker image rm oh-my-tui/server:0.1.0
```

## 4. Remove the agent package (optional)

```sh
npm uninstall -g @oh-my-tui/agent
rm -rf ~/.config/terminal-agent        # Linux
rm -rf "$HOME/Library/Application Support/terminal-agent"   # macOS
```

## 5. Infrastructure

This product does not create or modify WireGuard, the VPS relay, or
administrative SSH. Leave them as they were.
