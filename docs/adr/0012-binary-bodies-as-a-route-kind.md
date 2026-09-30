# 12. Files cross the module boundary as a kind of route, never as a stream

**Status:** accepted

## Context

The module contract was written with two things recorded as *known not to fit*:
notifications and binary request/response bodies. Notifications got a consumer and became
`notify` (ADR-0008). Files have one now too: the owner wants to show the agent a screenshot or
a photo from the device they are typing on — dropped from Finder, pasted, or picked on the
phone — and the agent reads it from the host's disk.

`http.ts` already said what the right shape would be: *a narrow kernel capability (store a
blob, serve a blob by id), not handing over the socket.* Three shapes were weighed:

| Shape | Why not |
|---|---|
| `ModuleContext.blobs`, a kernel store with routes of its own | The kernel would learn what an "attachment" is, the ids would be its own and the module would translate them, and the context would grow to eight fields with no need |
| Handing `IncomingMessage` to marked routes | That is handing over the socket — exactly what `http.ts` exists to prevent |
| `RouteHandler \| UploadRoute` as the value of `RouteTable`, `ModuleResponse` as a union | **Measured in the spec's first revision: it does not compile.** A value that is no longer always callable, and a response variant without `body`, broke every test that calls a handler or reads `.body` — in modules the kernel does not own |

## Decision

**An upload is a kind of route, and a file is a kind of response.** Both are additive:

```ts
uploadRoute(maxBytes, handler)   // still a RouteHandler, marked with `upload: { maxBytes }`
ModuleRequest.file?              // { path, bytes } — where the kernel put the bytes
ModuleResponse.file?             // an absolute path inside the module's stateDir
```

`FactotumModule` keeps five fields and `ModuleContext` keeps seven. `modules/example` and every
existing test compiled without a change.

## Why this shape

- **The module never sees a stream.** The kernel reads the body into
  `<stateDir>/.incoming/<uuid>.part` — a name it chose, capped at the route's `maxBytes`, itself
  capped at `MAX_UPLOAD_BYTES` (32 MiB) when the daemon starts — and hands the handler a path.
  What the handler does not move away is deleted, even when it throws. A module keeps a file with
  a `rename` on the same disk, which is atomic: an upload only ever has a name once it is whole.
- **The kernel decides how a file is served, not the module.** It opens the file once, with
  `O_NOFOLLOW`, checks that the inode it opened is the one whose real path is inside the module's
  directory, and takes the type from the first bytes: PNG, JPEG, GIF and WebP are painted inline;
  everything else — SVG and HTML above all — is a download. Every file carries
  `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox` and
  `cache-control: no-store`. The module's own `body` and `headers` are ignored for a file.
- **The route is resolved before the body is read.** It has to be: an upload reads bytes into a
  file and every other route reads JSON. For JSON routes the order of answers did not move — a 413
  or a 400 still comes before a 404 or a 501 — and tests written against the old code, before the
  change, pin it.

## What was measured before deciding

- **The CLI reads a file outside the session's folder, with no approval.** `@<path>` makes it
  embed the file in the prompt, with no tool call at all; a bare path makes it `Read` it, and the
  gate allows reads (ADR-0006). The attachment is a reference in the text, and nothing about how
  `claude` is invoked changed.
- **`tailscale serve` passes 20 MiB through whole, keeps `content-length` when the client sends
  it, and forwards `chunked` as `chunked`.** Chrome sends `content-length` for a `File`. So a
  length is a shortcut to an early 413, never a requirement, and the kernel counts bytes itself.
- **A refused body with bytes still in flight is "413 or a cut connection".** When the kernel
  stops reading — past the ceiling, or past `DRAIN_MAX_BYTES` (4 MiB) of draining — Node destroys
  the socket, and the client may see `EPIPE` instead of the answer. What is guaranteed is that
  nothing reaches the disk and the daemon stops reading; the client checks the size before
  sending.
- Draining had been throwing out of a `for await`, which destroyed the request and left the drain
  waiting on a dead stream: a 413 of 2 MB took six seconds to arrive. It no longer throws.

## What this costs

- **The daemon writes to disk from the network, with no credential.** The origin check is still
  the boundary (ADR-0007). The ceilings, the kernel-chosen name and the containment are what keep
  it narrow.
- **What is served comes from the origin that approves permissions.** That is why the type comes
  from the bytes, why only four raster formats are ever painted, and why `sandbox`.
- **The `Host` gap is worth more now.** DNS rebinding was already not covered
  (`docs/networking.md`); behind it there are now photos and documents, not only history text.

## What this still does not do

- No multipart, and one file per request.
- No `Range`, no partial responses, no upload progress.
- No quota: the module that keeps files decides what to delete, and when.
