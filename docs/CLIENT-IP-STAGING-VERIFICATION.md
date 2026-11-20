# Client IP behind Railway: what is known, and the staging test required

Status: INVESTIGATION ONLY. Nothing in the code or in any Railway variable has been changed for this. `TRUST_PROXY_HOPS`
stays as it is. The `X-Forwarded-For` replacement proposed earlier is NOT implemented, because the trusted source of the
client address is not established.

## Why it matters

Every per-IP limit in the API (OTP sends per IP, password sign-in per IP, join lookups per IP) reads `req.ip`, which Express
derives from `X-Forwarded-For` and `TRUST_PROXY_HOPS`. Two wrong outcomes:

- Too few hops trusted: every visitor appears to come from one Railway address, so all parents share one limit and a
  small burst locks everyone out.
- Too many hops trusted: a caller can write their own `X-Forwarded-For` and be treated as any address, so per-IP limits
  can be bypassed.

Two traffic paths exist and may need different handling:

1. Browser -> Railway edge -> portal web-server (`apps/web-server`) -> API over the private network.
2. Mobile app -> Railway edge -> API directly (the Expo app calls the API's public address).

## What Railway says (sources conflict)

Official page, https://docs.railway.com/networking/public-networking/specs-and-limits (read 2026-11-19):
- Documents `X-Real-IP` ("for identifying client's remote IP"), `X-Forwarded-Proto`, `X-Forwarded-Host`.
- Says nothing about `X-Forwarded-For`, whether a caller's value is kept, appended to or replaced, or how many proxies exist.
- States "This information is subject to change at any time."

Railway staff on the community forum (not documentation, and they disagree):
- 2026-06-12 (staff): the edge strips `X-Forwarded-For` so clients cannot overwrite it; the first value is the real
  connecting IP; "another hop" may appear inside Railway's network; no hop count given; `X-Real-IP` is the single source of truth.
- 2026-03-09 (staff): the edge appends to the chain, the real client is the LEFTMOST entry, and clients can send a spoofed
  `X-Forwarded-For`; `X-Real-IP` was then set to a CDN edge address (a bug they were tracking).
- Community replies report: append not strip; "typically 1 hop"; proxy peers in `100.0.0.0/8`; and in one case an
  `X-Forwarded-For` with no client address at all (a Railway IP then a Cloudflare IP).
- No source gives a guarantee.

Consequence: "leftmost entry" is only safe if the edge STRIPS caller values. If it only APPENDS, the leftmost entry is
whatever the caller wrote. Both claims cannot be true, so this must be measured, not assumed.

## Required staging verification (no production traffic, no secrets)

Use a throwaway Railway service in a staging environment, with a generated `*.up.railway.app` domain, that only echoes the
request's headers and socket address as JSON (never cookies or Authorization). Delete it afterwards. Run each test from a
network whose public IP you know (note it from a separate "what is my IP" check) and, if possible, from a second network
(mobile data), because routing through different edges changed the results in the reports above.

| # | Test | What to record |
|---|------|----------------|
| 1 | `curl` the echo service with no extra headers | `X-Forwarded-For` (all entries, in order), `X-Real-IP`, socket peer address |
| 2 | Same, sending `X-Forwarded-For: 203.0.113.7` | Is `203.0.113.7` absent, first, or last? Is the true client IP present, and where? |
| 3 | Same, sending `X-Forwarded-For: 203.0.113.7, 203.0.113.8` and `X-Real-IP: 203.0.113.9` | Which of these survive; does `X-Real-IP` equal your true IP? |
| 4 | Repeat 1-3 ten times and from the second network | Is the result stable? Does `X-Real-IP` ever show a CDN address instead of your IP? |
| 5 | Put a second echo service behind a minimal copy of the portal proxy (private network) and repeat 1-3 through it | How many entries the proxy adds; what the API-side peer address is |
| 6 | From another service in the same environment, call the echo service over `*.railway.internal` with spoofed headers | Confirms that private-network callers can set any header (so the API must not trust client-IP headers from a caller it cannot identify) |
| 7 | Send the same requests with the mobile app's HTTP client (or a script that sends its headers) | The mobile path matches the browser path at the API |

Pass criteria for choosing a source:
- A header whose value equals your true IP in all runs of tests 1-4 AND is unchanged by the spoofed values in tests 2-3
  (that header is edge-controlled), or a fixed position in `X-Forwarded-For` that does the same.
- Document the observed hop count (entries added by the edge, and by the portal proxy in test 5).

## Design options once a source is proven (not implemented)

- If the edge strips or overwrites caller values and a stable position or `X-Real-IP` holds the true IP, set
  `TRUST_PROXY_HOPS` to the measured number for the direct (mobile) path.
- For the portal path, the web-server must not just append. It should compute the client IP from the proven source and send
  ONE value to the API, and the API must trust that value only from the portal servers. Because any service on the private
  network can send headers (test 6), the portal servers would prove who they are with a shared secret in a header that the
  API checks (a Railway variable shared by the API and the portals; set only after approval).
- If no header is trustworthy, per-IP limits are unreliable and the protection must rest on the per-email and per-account
  limits that live in the database, plus a coarse limit keyed on the immediate peer.

Until this is measured, do not change `TRUST_PROXY_HOPS` and do not route the mobile app or the browser through a different path.

## Implemented for the portal-only launch (in code; NOT verified on Railway)

The initial launch has no public API domain, no mobile app and one traffic path: browser -> Railway edge -> portal web server ->
private API. The code now follows the "send ONE value" option above:

- `apps/web-server/src/client-ip.js` picks one address from what the edge reported, using the required setting
  `CLIENT_IP_SOURCE` (`xff:<n>`, `x-real-ip` or `peer`; production refuses to start without it and nothing guesses it), validates it
  with `net.isIP`, writes IPv4-mapped IPv6 as IPv4, sends it as the only `X-Forwarded-For`, and removes `Forwarded`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP` and the other client-address headers. Anything that is not exactly one valid
  address falls back to the connecting address.
- The API trusts exactly one hop: `TRUST_PROXY_HOPS=1` is required in production (0 is refused). With one trusted hop Express takes
  the rightmost entry, which is the one address the web server sent.
- Residual risk, accepted for this launch: any other service in the same private network could send the API a header of its own.
  Only the five frontend services and the database exist in this project. If that changes, add the shared-secret proof described above.

What staging must still decide (the only Railway-dependent facts): which entry of what the edge reports is the visitor
(`CLIENT_IP_SOURCE`), whether the edge's `X-Real-IP` can be used, and whether the connecting address is the edge's. Use the tests
above on the PORTAL path (tests 1-5) with the real web server, a private echo API with `TRUST_PROXY_HOPS=1`, and confirm that the
address the API sees is the real visitor, that a forged `X-Forwarded-For` or `X-Real-IP` changes nothing, and that per-IP limits count
each visitor separately. Record the observed hop count and the chosen value here.
