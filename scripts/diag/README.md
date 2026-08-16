# Diagnostics for the native-Windows loopback stall

On native Windows, several Chromium instances loading the app over a real HTTP
server on `127.0.0.1` used to miss their 30s page-load timeout, which forced the
suite to run one worker at a time there. It now serves over TLS on that platform
and runs in parallel like everywhere else. These are the probes that took the
problem apart, kept because the conclusion is only as trustworthy as the
measurements behind it, and because the same tools answer the next question of
this shape.

Everything here observes; nothing changes a system setting. Output goes to
`scripts/diag/out/`, which is git-ignored.

## What was found (2026-08-16)

The stall is **an HTTP content inspector holding plain-text loopback payload**.
Measured, with repetitions rather than single samples:

- The TCP connection is accepted immediately (3ms), stays `Established` on both
  sides, and then the server waits **9.5s, 10s, 20s, 30s, 40s** — multiples of a
  ~10s quantum — for the request bytes. Both ends are idle for that whole time.
- It is not Chromium-specific: a plain Node HTTP client on the same loopback,
  polling while the browsers are stalled, hits the same ~10s wait. Its `connect`
  completes in 3ms and the first response byte arrives 9.6s later.
- Without a browser running it never happens: 4 concurrent Node clients × 30
  rounds = 120 requests, 0 stalled, median 23ms.
- Renaming Chromium's binary changes nothing (3/3 runs still stalled), so
  whatever selects this traffic is not keying on the executable's name.
- Avast is registered in the Windows Filtering Platform with
  `FWP_ACTION_CALLOUT_TERMINATING` on all TCP, at `FWPM_LAYER_STREAM_V4/V6`
  (payload inspection, where data can be held), `ALE_AUTH_CONNECT_V4/V6` (which
  matches an observed 11.5s `connect`) and `ALE_CONNECT_REDIRECT_V4/V6`.
- **Serving the same suite over TLS removes it entirely.** Cross-controlled
  against the port, so the scheme is the only variable that matters:

  | scheme | port | 3 browsers × 3 repetitions |
  |--------|------|----------------------------|
  | HTTP   | 8123 | 3/3, 3/3, 3/3 stalled |
  | HTTP   | 8443 | 3/3, 3/3, 3/3 stalled |
  | HTTPS  | 8443 | 0/3, 0/3, 0/3 |
  | HTTPS  | 8123 | 0/3, 0/3, 0/3 |

  The whole suite then runs **103/103 in 1.4 min with 4 workers**, against
  2m45s serially over HTTP. That is why `playwright.config.js` serves over
  `https` on win32 only, with the certificate made on demand by
  `scripts/make-test-cert.mjs`; no other platform pays anything for it.

Ruled out earlier, so don't re-test: the GPU, DNS and the 41k-line hosts file,
`localhost` vs `127.0.0.1`, proxy auto-discovery, the port number, ephemeral
port exhaustion, `NetworkServiceSandbox`, background networking, and
`scripts/serve.mjs` itself.

## The probes

| file | what it answers |
|------|-----------------|
| `loopback-stall-probe.mjs` | Reproduces the stall and varies one thing at a time: browser processes vs pages in one browser vs no browser at all (`--mode`), the binary launched (`--exe`), the scheme and port (`--https`, `--port`), plus a Node client polling during the stall (`--poll`), the server's own timestamps (`--trace`) and Chromium's netlog (`--netlog`). |
| `connection-owners.ps1` | Runs the probe and samples the TCP table while it runs, joining "who owns the client end of each connection, and which states it passes through" with "how long the server waited for its request bytes". |
| `trace-start.ps1` / `trace-stop.ps1` | ETW session on TCPIP, Winsock-AFD and WFP (elevated), decoded down to the events naming the server's port. |
| `wfp-inventory.ps1` | Enumerates the Windows Filtering Platform callouts and the vendors that registered them (elevated, read-only). |

`--https` runs `scripts/serve.mjs --tls`, the same server the suite itself uses,
rather than a TLS copy of it: two servers would drift apart and the comparison
between transports would stop meaning anything.

`scripts/serve.mjs` also grew `--tls` and a `SERVE_TRACE=<file>` environment variable, off
unless set, which records when each connection is accepted, each request
arrives and each response finishes. That is the measurement that split the
problem in half, by showing the request bytes arriving at the server ten
seconds after the client had written them.

## Method notes

Two conclusions in this investigation were wrong on a single sample and only
survived repetition:

- "One browser process with four pages doesn't stall" — it did, in 2 of 4 runs.
  Every configuration here is run at least three times.
- A sampling window that started 13 seconds after the probe had finished
  reported "no established connections during the stall", which looked like a
  finding and was an artefact. `connection-owners.ps1` now starts the probe
  itself so the two cannot drift apart.

Before trusting any comparison, check that the run being compared against
actually reproduces the stall in the same session.
