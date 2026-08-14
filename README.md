# @vcjdeboer/apple-podcasts-transcript

Headless Apple Podcasts transcript fetcher for [swamp](https://swamp-club.com).
Finds episodes — either in the local Apple Podcasts library (`MTLibrary.sqlite`)
or in Apple's public catalog — and downloads their TTML transcripts via the
[FetchTranscript](https://github.com/dado3212/apple-podcast-transcript-downloader)
binary, with a Podcasting 2.0 `<podcast:transcript>` RSS fallback for shows
that publish transcripts in their feed.

Pure subprocess + HTTP. No GUI, no window management.

### Do I need the Podcasts app open?

**No — and for new episodes you should not rely on it.** The transcript download
(`fetch`) needs only a `storeId`, a network connection, and a signed-in Apple ID
— never the app, never the local library. The one part that reads the local
library is `search source=library` (the default): it can only see episodes the
Podcasts app has already **synced**, so a brand-new episode you have not opened
the app for is invisible to it — and with no `storeId`, you cannot start a fetch.

Use **`search source=catalog`** to look the episode up in Apple's public catalog
instead. It needs no app, no library, and no sign-in, so it finds episodes the
moment Apple lists them — then hand the returned `storeId` to `fetch`.

## Requirements

- macOS with Apple Podcasts installed and signed in (populates `MTLibrary.sqlite`).
- **You must be signed in to your Apple ID on this Mac** (Apple menu → System
  Settings → Apple ID). `FetchTranscript` authenticates by asking `amsd`, the
  Apple Media Services daemon, to sign the transcript request on your behalf.
  If you sign out, `amsd` has no identity to sign with and `FetchTranscript`
  fails. Signing back in restores it; nothing in this extension caches the
  underlying credentials.
- `FetchTranscript` binary on `PATH` (or full path via the `fetchTranscriptBin`
  global argument). Build from source:

  ```
  git clone https://github.com/dado3212/apple-podcast-transcript-downloader
  cd apple-podcast-transcript-downloader
  clang -Wno-objc-method-access -framework Foundation \
    -F/System/Library/PrivateFrameworks -framework AppleMediaServices \
    FetchTranscript.m -o FetchTranscript
  cp FetchTranscript ~/.local/bin/
  ```

  Confirmed working on macOS 15.5+. Older releases are documented not to work.

- `sqlite3` CLI (ships with macOS).

## Model

Type: `@vcjdeboer/apple-podcasts-transcript`

### Global arguments

| Name                | Default                                                                                                     | Purpose                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `mtlibraryPath`     | `$HOME/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite`            | Local Apple Podcasts library.      |
| `fetchTranscriptBin`| `FetchTranscript`                                                                                           | Binary to invoke; must be on PATH. |
| `outputDir`         | `./transcripts`                                                                                             | Where TTML + plaintext are written.|
| `feedTimeoutSec`    | `30`                                                                                                        | RSS fetch timeout.                 |

### Methods

**`search`** — find candidate episodes. Returns a `matches` resource with each
episode's store ID, title, feed URL, and enclosure URL. Two sources via the
`source` argument:

- `source=library` (default) — substring-match the local `MTLibrary.sqlite`.
  Only sees episodes the Podcasts app has synced.
- `source=catalog` — substring-match Apple's public catalog
  (`itunes.apple.com`). No app, library, or sign-in required; finds un-synced
  episodes. Requires a `podcast` term (the show name); `episode` narrows within
  the show; `limit` caps rows.

**`fetch`** — download a transcript by Apple `storeId`. Tries `FetchTranscript`
first (covers everything Apple has auto-transcribed); if that returns nothing,
tries the show's RSS `<podcast:transcript>` element. Writes a
`transcript_<id>.ttml` and a slugified `.txt` into `outputDir` and records an
`episode` resource with paths, byte counts, and the source used
(`fetchtranscript` or `rss`).

Fails when neither path yields a transcript — Apple has no TTML AND the RSS
feed has no `<podcast:transcript>` element. Returns an explicit HTTP 404 from
`FetchTranscript` so the failure reason is legible.

## Example: Adam Jacob on The Changelog

Adam Jacob (founder of Chef, System Initiative) went on The Changelog to talk
about the swamp project itself — "Automation at the speed of Swamp" (2026-05-13).
Fitting example.

Find the episode:

```
swamp model @vcjdeboer/apple-podcasts-transcript method run search jacob \
  --input '{ "podcast": "Changelog", "episode": "Swamp", "limit": 3 }'

swamp data get jacob matches --json | jq -r '.content.matches[] |
  "\(.storeId)  \(.episodeTitle)  (\(.publishedAt))"'
```

Output:

```
1000767804132  Automation at the speed of Swamp (Friends)  (2026-05-13 21:00:00)
```

Fetch its transcript:

```
swamp model @vcjdeboer/apple-podcasts-transcript method run fetch jacob \
  --input '{ "storeId": "1000767804132" }'

swamp data get jacob episode --json | jq '{
  source: .content.source,
  ttmlBytes: .content.ttmlBytes,
  textChars: .content.textChars,
  textPath: .content.textPath
}'
```

Output:

```json
{
  "source": "fetchtranscript",
  "ttmlBytes": 2296968,
  "textChars": 144844,
  "textPath": "./transcripts/The-Changelog-Software-Development-Open-Source_Automation-at-the-speed-of-Swamp-Friends.txt"
}
```

Sub-second after the FetchTranscript bearer token is cached (first call caches
it for 30 days).

## Example: a brand-new episode, without opening the app

You want the latest episode of a show you follow, but you have not opened the
Podcasts app since it published — so `source=library` finds nothing. Look it up
in the public catalog instead, then fetch by the `storeId` it returns:

```
swamp model @vcjdeboer/apple-podcasts-transcript method run search pe \
  --input '{ "source": "catalog", "podcast": "The Pragmatic Engineer", "limit": 3 }'

swamp data get pe matches --json | jq -r '.content.matches[] |
  "\(.storeId)  \(.publishedAt)  \(.episodeTitle)"'
# 1000782993949  2026-08-12 16:45:07  Stop being skeptical about AI for development ...

swamp model @vcjdeboer/apple-podcasts-transcript method run fetch pe \
  --input '{ "storeId": "1000782993949" }'
```

No app, no sync, no sign-in for the lookup — only `fetch` needs the Apple ID.

## License

MIT — see [LICENSE.md](./LICENSE.md).
