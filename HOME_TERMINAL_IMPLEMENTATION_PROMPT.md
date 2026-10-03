# Implementation prompt: personal terminal Server and npm Agent

You are responsible for executing and completing the Personal Terminal Server and Agent implementation. You must not spawn any subagent or worker.

Build a working, tested project from this brief, not just a plan or visual prototype. This document is self-contained; no preceding conversation is needed. Read the destination repository's instructions and inspect its state before editing. Preserve unrelated work. Use the repository supplied with this assignment; this document's location does not automatically designate the implementation directory. If no destination is supplied or discoverable, ask for it.

Communicate with the owner in concise Chinese. Use English for identifiers, comments, and technical documentation, and Simplified Chinese for the initial product UI and CLI messages. Make routine choices independently and continue through implementation, packaging, and verification. Missing production addresses or credentials must not block local implementation: use configurable examples and isolated fixtures. Report verified limitations honestly.

## 1. Confirmed requirements

- This is a personal, single-owner remote terminal manager, similar in purpose to a lightweight bastion service.
- One owner accesses several machines from phone, tablet, and desktop browsers. Multi-user accounts, organizations, invitations, and RBAC are outside the current scope.
- Deliver two installable components: a Server and a machine-side Agent. Browsers are the owner interface, not the machine-side Agent.
- The Server runs in Docker on a home Ubuntu server, called Home.
- An existing WireGuard link connects Home to a low-resource Alibaba Cloud VPS. The VPS only forwards traffic. Application processing, authentication, credentials, database, and session management stay on Home.
- An existing public SSH endpoint already forwards through the VPS to Home. Preserve that infrastructure. It establishes that a relay path exists; it is not automatically the product's enrollment API.
- Managed machines can be inside unrelated private LANs. Every considered machine can initiate a connection through the public relay to Home. Home does not need inbound reachability into those LANs.
- There are exactly two independently configurable product entrances: a browser-access port and an Agent-access port. Separate paths or hostnames on one public port do not satisfy this requirement.
- The Agent is distributed through npm. Its primary registration command is terminal-agent register --server <AGENT_SERVER_URL>.
- Running that command waits for interactive input of a Server-generated registration Token. Enter submits it. Successful verification saves device credentials, connects the Agent, and makes the machine appear online.
- Subsequent Agent starts use saved credentials; they do not require registration again.
- The owner can open and resume real TUI sessions, dictate text with the phone keyboard, and continue a session from another browser.

## 2. Selected implementation

These are concrete implementation choices for the confirmed product, not claims about existing live configuration.

Use TypeScript and Node.js for Server and Agent. Reuse SSH for terminal execution and tmux for persistent remote sessions. Use HTTPS and outbound WebSockets on the dedicated Agent port for enrollment, presence, and reverse transport. The Agent manages the connection so the owner does not manually allocate a reverse SSH port per machine.

The baseline Agent relays SSH bytes between the Server and its own machine's loopback SSH service. The Server requests a remote PTY; the target's sshd provides it. Consequently, the baseline npm Agent does not need node-pty or a mandatory native PTY dependency. This is a real interactive terminal path, not a text-output simulation.

| Component | Technology |
| --- | --- |
| Runtime/language | A supported Node.js LTS release and TypeScript |
| Repository | npm workspaces, checked-in lockfile |
| Server HTTP | Fastify with two distinct listeners and route sets |
| WebSockets | ws on Server/Agent; browser-native WebSocket |
| SSH | ssh2 on the Server, using an Agent-provided duplex transport |
| Database | SQLite, better-sqlite3 on the Server, versioned migrations |
| Owner authentication | @simplewebauthn/server and @simplewebauthn/browser |
| Frontend | React, TypeScript, Vite, straightforward CSS |
| Terminal rendering | @xterm/xterm and @xterm/addon-fit |
| Session lifetime | tmux on the managed machine |
| Agent distribution | Compiled JavaScript npm package with a terminal-agent executable |
| Server distribution | Multi-stage Docker image and Compose |
| Verification | Focused TypeScript tests, Playwright, real OpenSSH/tmux integration fixtures |

Check current compatibility and pin supported dependencies and build images. Do not invent version numbers or depend on floating latest tags for reproducible builds. The Server's SQLite native dependency can be compiled within its controlled Docker build. Keep mandatory native build dependencies out of the distributed Agent baseline.

The initial supported environment is Home Ubuntu/Linux and managed Linux/macOS machines with a supported Node.js runtime, enabled local SSH service, and tmux. These OS prerequisites are not automatically installed by npm. Preflight must identify missing prerequisites and exact remediation without silently changing privileged host settings.

No new VPN, FRP deployment, native mobile app, cloud speech recognizer, LLM command generator, general-purpose TCP proxy product, or multi-user platform is required. Do not build parallel terminal backends speculatively. If a verified constraint requires replacing the selected SSH backend, explain the constraint before changing it.

## 3. Two-port networking

Example public addresses, not actual production values:

~~~text
Browser: https://terminal.example.com:443
Agent:   https://terminal.example.com:8443
~~~

Example application listeners:

~~~text
WEB_LISTEN_HOST=0.0.0.0
WEB_PORT=8080
AGENT_LISTEN_HOST=0.0.0.0
AGENT_PORT=8081
~~~

Public/internal port numbers can differ because of forwarding. Configure both external origins independently. Reject configuration that merges the Server listeners into the same address/port.

~~~text
Browser
  -> public WEB port on VPS
  -> existing WireGuard/forwarding
  -> Home Server WEB listener

Managed machine Agent
  -> public AGENT port on VPS
  -> existing WireGuard/forwarding
  -> Home Server AGENT listener

Server
  -> SSH over Agent-initiated data stream
  -> Agent's local TCP connection
  -> target sshd
  -> remote PTY and tmux
~~~

The WEB listener serves the UI, owner login, management APIs, and browser terminal WebSockets. It does not accept Agent registration or device channels.

The AGENT listener handles registration, device authentication, control connections, heartbeats, and SSH transport channels. It does not serve the owner UI or authorize management access using browser cookies. Port separation does not replace authentication.

Both public entrances require TLS. Supply a two-port Home proxy/TLS example compatible with the existing relay model. Do not imply that the existing SSH port speaks HTTPS or already exposes these application listeners.

Use ordinary Docker bridge networking for the Server. It does not need Home loopback reverse listeners, host networking, privileged mode, the Docker socket, or access to host sshd configuration. Publish the two application ports on an appropriately restricted host interface for the Home proxy. Run non-root and persist only application data. Preserve existing WireGuard and administrative SSH.

## 4. Exact registration and lifecycle

The package scope below is a placeholder; terminal-agent is the intended executable name.

~~~text
$ npm install -g @your-scope/terminal-agent
$ terminal-agent register --server https://terminal.example.com:8443

请输入服务端生成的注册 Token：********
正在验证……
注册成功，已连接服务端。
~~~

Required behavior:

1. Validate the Agent server URL and protocol compatibility. A WEB-port URL produces an actionable error.
2. Preflight the runtime, writable private configuration directory, local SSH availability, intended OS account, and tmux. Detect unsupported host authentication policy rather than changing it silently.
3. Wait for Token input without echo. Do not require secrets in command-line arguments, URLs, shell history, or environment variables for ordinary use.
4. Redeem the Token through the AGENT listener over verified TLS. Invalid/expired tokens allow another attempt and are never printed.
5. Save the Agent URL, stable machine identity, and device credential atomically with restrictive permissions.
6. Complete the SSH trust/key setup below, establish the authenticated Agent connection, and test terminal readiness.
7. Show success only after registration and connection acknowledgement. Distinguish registered, connected, and terminal-ready states; a missing SSH prerequisite must not look like a working terminal.

After successful registration, remain connected in the foreground by default so the machine is usable immediately. Explain that Ctrl-C stops the foreground Agent but preserves its registration.

Provide these commands:

- terminal-agent register --server <URL>: interactive initial enrollment, then foreground connection.
- terminal-agent start: reconnect using saved registration, no Token prompt.
- terminal-agent status: report local registration/service/connection state truthfully.
- terminal-agent doctor: diagnose server reachability, credentials, local SSH and tmux.
- terminal-agent service install: explicit background/startup integration.

Do not silently install privileged services during registration or npm installation. Prevent duplicate Agent processes from competing for one identity. On Linux, generate systemd integration with an explicit non-root runtime user, restart policy, and documented user-service versus boot-service requirements. On macOS, provide a LaunchAgent and state its login dependence. Do not silently switch identity or service mechanism when privileges are missing.

## 5. Registration Token and machine identity

- The owner creates a short-lived, single-use Token in the authenticated WEB UI. Display plaintext only at creation and store a suitable hash on the Server.
- Consume Tokens transactionally on the AGENT listener. Concurrent redemption must not create multiple registrations.
- Issue a unique, high-entropy, revocable device credential. Transfer it over TLS, store it privately on the Agent, and store a non-recoverable verifier on the Server where practical.
- Scope the credential to one machine. It cannot authorize owner actions, enumerate other machines, or attach to another machine's streams.
- Make partial enrollment recoverable: avoid duplicate identities and key entries, persist pending state safely, and define recovery for a lost enrollment response. Do not pretend remote filesystem writes and a database transaction are one atomic operation.
- A valid Token authorizes enrollment; do not insert an additional routine browser-approval step after redemption.
- Machine names are display metadata, not authentication identifiers.
- Revocation closes that device's active control/data connections and prevents reconnect.
- Browser sessions and device credentials remain separate.

## 6. Automatic SSH setup and host trust

Once prerequisites are satisfied, the owner supplies the Server URL and Token; the application handles the rest of the connection configuration.

For each machine, generate a separate SSH login keypair on the Server. Its private key remains in protected Server storage. Return only the public key to the enrolling Agent.

The Agent runs as the OS user whose terminal will be controlled. Safely append that public key to the user's authorized_keys with an application-owned marker. Preserve unrelated entries, options, comments, permissions, and metadata. Registration must be idempotent. If the host uses another authorized-key source or an incompatible authentication policy, report the actual prerequisite instead of modifying system SSH policy.

The Agent sends the local SSH host public key(s), obtained from local files or its loopback SSH endpoint, over the authenticated enrollment channel. Enrollment is the explicit trust event for this local machine. Pin the keys to the stable machine ID. Later key changes require an owner trust update; normal reconnection and metadata updates cannot silently replace them.

Use ssh2 host-key verification on every terminal connection. Never disable verification to work around a reconnect problem.

The Agent relays only to its locally configured SSH endpoint, normally loopback port 22. Browser or Server channel requests cannot select arbitrary LAN destinations. It is not a general-purpose proxy.

Document key locations and precise cleanup of application-owned remote authorized-key entries. Disabling a machine immediately closes product access, but cannot be claimed to remove files on an unreachable target. Private keys, credentials, and Tokens must not appear in routine APIs, logs, browser storage, or source control.

## 7. Control channel and SSH transport

Use a small versioned application protocol over standard TLS/WebSocket. Reuse SSH for terminal cryptography and execution rather than inventing either protocol.

Suggested flow:

1. Agent opens an authenticated control WebSocket on the AGENT listener and reports its identity, protocol/Agent version, OS, terminal username, and readiness.
2. Maintain heartbeats and last-seen state. Reconnect with bounded exponential backoff and jitter. Stale connections must not overwrite the current generation's state.
3. An authenticated browser requests a terminal session on the WEB listener.
4. Server asks the correct Agent to open a transport. Agent initiates a separate binary WebSocket on the same AGENT port, connecting it to its configured local SSH TCP socket.
5. Bind the data channel to the machine identity, pending request, current control-connection generation, and short-lived one-use channel authorization. Reject unsolicited, replayed, expired, wrong-device, and revoked channels.
6. Adapt the ordered binary WebSocket stream to a Node duplex stream. Supply it as ssh2's sock transport. Authenticate with the machine-specific SSH private key and verify the pinned host key.
7. Request a remote PTY, start/attach tmux, and stream terminal bytes to the authenticated browser WebSocket on the WEB listener.

Multiple connections still use one AGENT port. Do not allocate a public or Home loopback TCP port per machine/session.

Validate and bound control messages. Preserve binary data and ordering. Implement backpressure, bounded queues, cancellation, timeouts, half-close/error behavior, and disconnect cleanup. Avoid unlimited output buffering or silent input loss.

Possession of a terminal/session ID is not authorization. Check the owner session on attachment/takeover. Browser revocation closes that browser's live access; device revocation closes the relevant Agent channels. Recheck authorization at state changes, not only initial login.

## 8. Durable sessions and multiple clients

- Request a real xterm-256color remote PTY and implement window-size changes.
- Create application-managed tmux sessions on the target. Derive safe tmux identifiers from stable IDs, not unescaped display names.
- Persist machine/session/tmux mappings on the Server. Work processes and files stay on the target.
- Browser disconnect, Agent restart, network loss, or Server container recreation must detach transports without intentionally killing remote tmux sessions.
- Reconnect with a fresh transport to the same surviving tmux session and allow tmux to redraw the screen.
- Target reboot or a missing tmux session must show ended/unavailable, not pretend a newly created session is the old one.
- Distinguish disconnect from terminate-session. Preserve unrelated tmux sessions.
- Support independent sessions across machines and browsers. One terminal session has one active controller with explicit takeover; stop input from the old controller and notify it.
- Handle reconnect/takeover races atomically. Collaborative spectators and multi-user sharing are outside the MVP.
- Quote remote command arguments safely and validate structured fields. Never interpolate arbitrary names, paths, or usernames into shell commands unsafely.

## 9. Owner authentication and mobile UI

Maintain one owner identity with multiple passkeys and revocable browser sessions. Bootstrap ownership with a short-lived one-use setup token generated by a local Server administrative command. Public visitors cannot claim an uninitialized Server without that token. Provide local administrative recovery for lost passkeys without an unauthenticated network bypass.

Use a fixed configured WebAuthn RP ID and WEB origin, verified one-use challenges, appropriate user verification, and opaque server-side sessions with production Secure/HttpOnly/SameSite cookies. Apply CSRF protection and WebSocket Origin validation. A synchronized passkey is not a physical device inventory.

Deliver a responsive UI with:

- Machine list, connected/offline status, separate terminal-readiness errors, and last seen.
- Registration Token creation, machine rename/disable/removal.
- Session create/resume/disconnect/terminate and explicit controller takeover.
- xterm.js terminal, real multiline textarea, Enter/Tab/Escape/Ctrl-C/arrow controls.
- Correct layout and input behavior with phone software keyboards, orientation changes, Unicode, and Chinese IME.

Use phone keyboard dictation into the textarea. Do not transmit unfinished IME composition or append Enter when dictation completes. Separate paste/send-text and Enter actions. Use xterm's paste behavior and negotiated bracketed paste correctly; newline handling in real shells/TUIs must be tested.

Provide a web app manifest and icons for home-screen installation on supported browsers. A service worker is optional, not a prerequisite. If used, cache only public versioned shell assets, never authenticated APIs, terminal streams, credentials, or enrollment data. The terminal is network-dependent.

## 10. Packaging and deployment

A suitable repository layout is:

~~~text
apps/server/        # two-port Server, owner auth, SQLite, SSH/session management
apps/web/           # React and xterm.js
packages/agent/     # publishable terminal-agent CLI/runtime
packages/protocol/  # shared schemas, types, protocol version
deploy/             # Docker, Compose, two-port proxy examples
tests/integration/  # real SSH, network, enrollment fixtures
~~~

Publish compiled JavaScript and required assets. Configure package bin/files/engines and a deterministic build/pack workflow. Published Agent dependencies must resolve outside the monorepo: no sibling source imports or unresolved workspace links. Test the npm pack tarball with a global installation into a clean temporary prefix outside the checkout.

npm installation must not start daemons, enroll machines, change SSH settings, or request sudo. Node.js is a documented prerequisite. SSH and tmux are documented OS prerequisites. If a verified requirement introduces a native Agent dependency later, revisit prebuilt/fallback behavior and the clean-install matrix explicitly.

Build a multi-stage Server Docker image containing Node.js, production dependencies, and the built frontend. Run non-root, persist SQLite and key material, and provide migrations. Do not run Vite's development server in production. Document consistent SQLite backup/restore including WAL and credential files.

Document both public origins, both listeners/ports, proxy/TLS assumptions, persistent paths, WebAuthn settings, Token expiry, heartbeat/reconnect policy, and UID/GID. Agent settings include Agent URL, private credential, machine identity, local SSH endpoint, and service paths. Use examples rather than inventing the owner's addresses, ports, or fingerprints.

Supply README, setup, upgrade, uninstall, recovery, and troubleshooting documentation. Use license metadata consistent with the repository or owner choice. Do not invent an author identity or claim an npm scope is available. Actual publication is separate from producing a release-ready package.

## 11. Acceptance criteria

Establish these outcomes before implementation and report actual results. Use focused behavioral tests; a working UI mockup is not evidence of a working terminal.

1. Build: TypeScript checks, relevant tests, frontend production build, Server Docker build, and npm packing pass. The packed Agent works outside the repository without dev dependencies.
2. Ports: WEB and AGENT use separate listeners; Agent enrollment cannot succeed on WEB, and owner UI/management authorization cannot succeed on AGENT. Exercise and document the two-port mapping.
3. Registration: the installed register --server command prompts without echo, submits on Enter, handles invalid/expired Token and wrong-port errors, saves credentials, connects, and reports truthful readiness.
4. Enrollment: concurrent redemption cannot create two devices; retries/partial failures do not duplicate records/keys; unrelated authorized keys remain intact; restart needs no Token.
5. Private LAN: in an isolated topology where Server cannot directly reach target SSH, Agent outbound connections enable a real SSH handshake and PTY. Prove the direct path is unavailable.
6. Host trust: the expected target key succeeds, a changed key fails, and reconnect cannot silently replace identity. Use real OpenSSH and tmux, not just mocks.
7. Terminal: test a real full-screen application or representative interactive fixture, resize, special keys, Unicode, and multiline paste.
8. Recovery: drop browser/network connections, restart Agent, and recreate Server. Reattach to the same surviving tmux session and show the original target process still exists. Also test missing-session reporting.
9. Presence/control: heartbeat expiry marks offline; reconnect restores the latest generation; stale sockets cannot override it; multiple machines/sessions and exclusive takeover work.
10. Authorization: reject unauthenticated requests, disallowed browser origins, revoked device credentials, wrong-device data channels, and replayed channel authorization. Revocation closes live access. Exercise real WebAuthn verification with a virtual authenticator where available.
11. Mobile: verify narrow-screen layout, textarea/terminal focus, Chinese composition, paste, and no unsolicited Enter. Real-phone dictation and PWA behavior require actual device testing; distinguish that from browser emulation.
12. Installation: verify a clean Ubuntu npm installation and service behavior, plus macOS installation/LaunchAgent behavior where available. Test non-root identity and persistent volume permissions. State any unavailable checks and why.

Use isolated fixtures and test credentials. If Docker, service-management privileges, a real phone, or production connectivity is unavailable, finish independent implementation and provide minimal remaining verification steps without claiming they passed.

## 12. Work boundaries and deliverables

Complete the MVP through coherent increments: deployable packages, two-port enrollment/presence, SSH-over-Agent transport, durable sessions, owner authentication, mobile interaction, installation/service integration, and recovery verification. Authenticate before external exposure. Do not stop at scaffolding while independent work remains.

Repository implementation and isolated testing are authorized by this assignment. Live infrastructure changes, npm publication, Git commits/pushes, and production deployment require applicable owner authorization. Honor authorization already given; do not infer it merely from a local implementation request. Inspect real configuration and permissions before authorized infrastructure work.

Deliver:

- Implemented Server, npm Agent, shared protocol, and web UI.
- Lockfiles, build/pack tooling, Dockerfile, Compose, and two-port proxy examples.
- Reviewable Linux/macOS service integration and cleanup artifacts.
- Configuration, deployment, recovery, and troubleshooting documentation.
- Actual verification evidence and clearly labeled unverified environment-dependent items.
- A concise Chinese report of changes and unresolved delivery issues.

## Primary references

- [npm package configuration](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
- [ssh2: SSH, PTY, and custom transport](https://github.com/mscdex/ssh2)
- [ws: WebSocket and stream integration](https://github.com/websockets/ws)
- [Fastify](https://fastify.dev/docs/latest/)
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- [SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server)
- [SimpleWebAuthn browser](https://simplewebauthn.dev/docs/packages/browser)
- [xterm.js](https://xtermjs.org/)
- [React](https://react.dev/learn/build-a-react-app-from-scratch)
- [Vite](https://vite.dev/guide/)
- [OpenSSH](https://man.openbsd.org/ssh)
- [tmux](https://github.com/tmux/tmux)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)

Prepared on 2026-09-29 from the current requirements. No production addresses, configuration, or live connectivity were verified while preparing this brief.
