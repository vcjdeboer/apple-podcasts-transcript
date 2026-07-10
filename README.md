# @vcjdeboer/apple-podcasts-transcript

Headless Apple Podcasts transcript fetcher for [swamp](https://swamp-club.com).
Reads the local Apple Podcasts library (`MTLibrary.sqlite`) to find episodes,
and downloads their TTML transcripts via the
[FetchTranscript](https://github.com/dado3212/apple-podcast-transcript-downloader)
binary — the same source Podcasts.app hits internally, minus the app UI. Falls
back to a Podcasting 2.0 `<podcast:transcript>` RSS element when a show
publishes one.

No Podcasts.app opening. No mouse driving. No window management.

## Requirements

- macOS with Apple Podcasts installed and signed in (populates `MTLibrary.sqlite`).
- **You must be signed in to your Apple ID on this Mac** (Apple menu → System
  Settings → Apple ID). `FetchTranscript` authenticates by asking `amsd`, the
  Apple Media Services daemon, to sign the transcript request on your behalf —
  the same way Podcasts.app authenticates. If you sign out, `amsd` has no
  identity to sign with and `FetchTranscript` fails. Signing back in restores
  it; nothing in this extension caches the underlying credentials.
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

**`search`** — substring-match the local library.

```
swamp model @<type> method run search <name> \
  --input '{ "podcast": "Practical AI", "episode": "Building Durable", "limit": 5 }'
```

Writes a `matches` resource with the candidate episodes' store IDs, titles,
feed URLs, and enclosure URLs.

**`fetch`** — download a transcript by Apple `storeId`.

```
swamp model @<type> method run fetch <name> \
  --input '{ "storeId": "1000776095061" }'
```

Tries `FetchTranscript` first (covers everything Apple has auto-transcribed);
if that returns nothing, tries the show's RSS `<podcast:transcript>` element.
Writes a `transcript_<id>.ttml` and a slugified `.txt` into `outputDir` and
records an `episode` resource with paths, byte counts, and the source used
(`fetchtranscript` or `rss`).

Fails hard when neither path yields a transcript (Apple has no TTML AND the RSS
feed has no `<podcast:transcript>` element). This matches the failure surface of
the older GUI-driven flow, but with a fast, explicit HTTP 404 instead of a
silent no-op after a 20-second wait.

## Typical use

```
# 1. Find the episode.
swamp model @vcjdeboer/apple-podcasts-transcript method run search find \
  --input '{ "podcast": "Practical AI", "limit": 1 }'
swamp data get find matches --json | jq '.content.matches[0].storeId'

# 2. Fetch it.
swamp model @vcjdeboer/apple-podcasts-transcript method run fetch grab \
  --input '{ "storeId": "1000776095061" }'
swamp data get grab episode --json | jq '.content.textPath'
```

## Coverage

Byte-identical to what `Podcasts.app` caches when clicked. Verified on 9/9 known-
good TTMLs from an earlier session; the one episode without a cached TTML in the
same library returned an HTTP 404 from `FetchTranscript` — the same coverage
limit as the app.

## License

MIT — see [LICENSE.md](./LICENSE.md).
