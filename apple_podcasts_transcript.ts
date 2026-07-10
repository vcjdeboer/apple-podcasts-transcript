/**
 * @vcjdeboer/apple-podcasts-transcript — headless Apple Podcasts transcript fetcher.
 *
 * Two methods:
 *
 *   `search` — substring-match the local MTLibrary.sqlite by podcast and/or
 *   episode title, return matching episodes as a `matches` data version.
 *
 *   `fetch` — by episode `storeId`, download the TTML transcript. Tries in
 *   order:
 *     1. FetchTranscript binary (Apple's private AppleMediaServices + Mescal
 *        signing — same source Podcasts.app hits) — covers every Apple-
 *        transcribed episode; produces byte-identical TTML.
 *     2. Podcasting 2.0 `<podcast:transcript>` element in the show's RSS feed —
 *        covers shows that self-publish transcripts (Transistor et al).
 *   Writes TTML + a stripped plaintext to `outputDir` and records the episode's
 *   metadata as an `episode` data version.
 *
 * Why headless: previous flow drove Podcasts.app via cliclick + AppleScript
 * (mouse warp, scroll wheel, click Transcript pane). It worked but blocked the
 * GUI, took 20-30 s/episode, and collided under parallel invocations. This
 * extension replaces that entire dance with a subprocess call — sub-second
 * after the FetchTranscript bearer token is cached (30-day cache).
 *
 * Dependencies (macOS):
 *   - `FetchTranscript` binary on PATH (or full path via `fetchTranscriptBin`).
 *     Source: https://github.com/dado3212/apple-podcast-transcript-downloader
 *     Build: clang -Wno-objc-method-access -framework Foundation
 *            -F/System/Library/PrivateFrameworks -framework AppleMediaServices
 *            FetchTranscript.m -o FetchTranscript
 *   - `sqlite3` CLI (macOS ships one).
 *   - Apple Podcasts app installed and signed in (MTLibrary populated).
 *
 * @module
 */
import { z } from "npm:zod@4";

const DEFAULT_MTLIBRARY = `${
  Deno.env.get("HOME") ?? ""
}/Library/Group Containers/243LU875E5.groups.com.apple.podcasts/Documents/MTLibrary.sqlite`;

const GlobalArgsSchema = z.object({
  /** Full path to MTLibrary.sqlite. */
  mtlibraryPath: z.string().default(DEFAULT_MTLIBRARY),
  /** FetchTranscript binary — on PATH by default. */
  fetchTranscriptBin: z.string().default("FetchTranscript"),
  /** Where to write transcript_<id>.ttml + <slug>.txt files. */
  outputDir: z.string().default("./transcripts"),
  /** RSS fetch timeout, seconds. */
  feedTimeoutSec: z.number().int().min(1).default(30),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/* =============================================================================
 * search
 * ========================================================================== */
const SearchArgsSchema = z.object({
  /** Substring match against podcast title (case-insensitive). */
  podcast: z.string().default(""),
  /** Substring match against episode title (case-insensitive). */
  episode: z.string().default(""),
  /** Cap on returned rows. */
  limit: z.number().int().min(1).max(500).default(20),
});

const EpisodeRefSchema = z.object({
  storeId: z.string(),
  podcastTitle: z.string(),
  episodeTitle: z.string(),
  publishedAt: z.string(),
  feedUrl: z.string().default(""),
  enclosureUrl: z.string().default(""),
});

const SearchResultSchema = z.object({
  query: z.object({ podcast: z.string(), episode: z.string() }),
  count: z.number().int(),
  matches: z.array(EpisodeRefSchema),
  searchedAt: z.string(),
});

/* =============================================================================
 * fetch
 * ========================================================================== */
const FetchArgsSchema = z.object({
  /** Apple store track ID (from MTLibrary ZSTORETRACKID or a share URL). */
  storeId: z.string().min(1),
});

const EpisodeSchema = z.object({
  storeId: z.string(),
  podcastTitle: z.string().default(""),
  episodeTitle: z.string().default(""),
  publishedAt: z.string().default(""),
  feedUrl: z.string().default(""),
  enclosureUrl: z.string().default(""),
  source: z.enum(["fetchtranscript", "rss"]),
  ttmlPath: z.string(),
  textPath: z.string(),
  ttmlBytes: z.number().int(),
  textChars: z.number().int(),
  fetchedAt: z.string(),
});

/* =============================================================================
 * Helpers
 * ========================================================================== */

/** Sanitize an id/title into a safe filename slug. */
export function slugify(s: string): string {
  return (s || "episode")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "episode";
}

/** Sanitize for use as a swamp instance name. */
export function safeName(s: string): string {
  return (s || "instance").replace(/[^A-Za-z0-9_-]/g, "_");
}

interface Ctx {
  globalArgs: GlobalArgs;
  writeResource: (
    resource: string,
    instance: string,
    data: unknown,
  ) => Promise<{ version: number }>;
  logger: { info: (m: string, p?: Record<string, unknown>) => void };
}

/** Run a command and return {stdout, stderr, code}. */
async function run(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const cmd = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    cwd,
  });
  const out = await cmd.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
    code: out.code,
  };
}

/**
 * Query MTLibrary.sqlite via the `sqlite3` CLI, one row per line, tab-separated.
 * Using the CLI avoids pulling a native sqlite binding into the extension.
 */
async function queryMtlibrary(
  g: GlobalArgs,
  where: string,
  bindings: string[],
  limit: number,
): Promise<Array<z.infer<typeof EpisodeRefSchema>>> {
  // sqlite3 CLI has no clean parameter-binding for one-shot invocations.
  // Bindings here are LIKE-patterns / store IDs we construct ourselves, so
  // inline-quoting them as SQL string literals is safe.
  const inlined = where.split("?").reduce(
    (acc, part, i) =>
      acc + part + (i < bindings.length ? sqlQuote(bindings[i]) : ""),
    "",
  );
  const sql = `SELECT
      ep.ZSTORETRACKID,
      COALESCE(pod.ZTITLE, ''),
      COALESCE(ep.ZTITLE, ''),
      COALESCE(datetime(ep.ZPUBDATE + 978307200, 'unixepoch'), ''),
      COALESCE(pod.ZFEEDURL, ''),
      COALESCE(ep.ZENCLOSUREURL, '')
    FROM ZMTEPISODE ep
    LEFT JOIN ZMTPODCAST pod ON pod.ZUUID = ep.ZPODCASTUUID
    WHERE ${inlined}
    ORDER BY ep.ZPUBDATE DESC
    LIMIT ${limit};`;
  // Dot-commands (.mode) must be passed via -cmd; they can't share the SQL arg.
  const r = await run(
    "sqlite3",
    ["-cmd", ".mode tabs", g.mtlibraryPath, sql],
  );
  if (r.code !== 0) {
    throw new Error(`sqlite3 failed: ${r.stderr.trim() || "code " + r.code}`);
  }
  const rows: Array<z.infer<typeof EpisodeRefSchema>> = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3 || !parts[0]) continue;
    rows.push({
      storeId: parts[0],
      podcastTitle: parts[1] ?? "",
      episodeTitle: parts[2] ?? "",
      publishedAt: parts[3] ?? "",
      feedUrl: parts[4] ?? "",
      enclosureUrl: parts[5] ?? "",
    });
  }
  return rows;
}

/** SQL string-literal quoting for inline-substituted LIKE patterns. */
export function sqlQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

/**
 * Try FetchTranscript. Returns `{ ttmlPath }` on success, or `{ stderr }` with
 * the binary's diagnostic output when no file was written. Callers use the
 * stderr to distinguish "Apple has no TTML for this episode" (HTTP 404 JSON)
 * from "not signed in to an Apple ID → amsd refused to sign the request".
 */
export async function tryFetchTranscript(
  g: GlobalArgs,
  storeId: string,
): Promise<{ ttmlPath: string } | { stderr: string }> {
  // FetchTranscript communicates success via a file written to cwd, not exit
  // code — nothing on stdout on success; on failure it logs to stderr.
  const r = await run(
    g.fetchTranscriptBin,
    [storeId, "--cache-bearer-token"],
    g.outputDir,
  );
  const ttml = `${g.outputDir}/transcript_${storeId}.ttml`;
  try {
    const st = await Deno.stat(ttml);
    if (st.isFile && st.size > 0) return { ttmlPath: ttml };
  } catch {
    /* not written */
  }
  return { stderr: r.stderr.trim() };
}

/**
 * Fallback: find `<podcast:transcript>` element in the show's RSS feed and
 * download it. Prefers text/plain; falls back to text/vtt.
 */
async function tryRssTranscript(
  g: GlobalArgs,
  ep: z.infer<typeof EpisodeRefSchema>,
): Promise<{ ttmlPath: string; textPath: string } | null> {
  if (!ep.feedUrl) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), g.feedTimeoutSec * 1000);
  let xml: string;
  try {
    const res = await fetch(ep.feedUrl, { signal: ctrl.signal });
    if (!res.ok) return null;
    xml = await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
  // Find <item> whose <title> matches the episode title exactly (Apple pubDate
  // isn't in RSS, but title match is reliable enough for one-shot lookups).
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const target = items.find((it) => {
    const title = it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "";
    return title.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ===
      ep.episodeTitle.trim();
  });
  if (!target) return null;
  const els = target.match(/<podcast:transcript[^>]*\/>/g) ?? [];
  // Prefer text/plain, then text/vtt, then any.
  const pick = (type: string) => {
    const el = els.find((e) => e.includes(`type="${type}"`));
    return el?.match(/url="([^"]+)"/)?.[1];
  };
  const url = pick("text/plain") ?? pick("text/vtt") ??
    els[0]?.match(/url="([^"]+)"/)?.[1];
  if (!url) return null;
  const dl = await fetch(url);
  if (!dl.ok) return null;
  const body = await dl.text();
  // Store the raw feed transcript as the "ttml" slot (a no-op for text/plain)
  // and produce a plaintext copy alongside.
  const ttmlPath = `${g.outputDir}/transcript_${ep.storeId}.rss.txt`;
  await Deno.writeTextFile(ttmlPath, body);
  const textPath = `${g.outputDir}/${slugify(ep.podcastTitle)}_${
    slugify(ep.episodeTitle)
  }.txt`;
  await Deno.writeTextFile(textPath, ttmlToText(body));
  return { ttmlPath, textPath };
}

/**
 * Strip TTML (or plain text) to a readable transcript: drop tags, collapse
 * whitespace, put one utterance per line where possible.
 */
export function ttmlToText(ttml: string): string {
  // If it doesn't look like TTML/XML, return as-is (RSS text/plain path).
  if (!/<tt\b|<p\b|<span\b/.test(ttml)) return ttml.trim() + "\n";
  // Extract <p> content; each <p> is one utterance.
  const paras = ttml.match(/<p\b[^>]*>[\s\S]*?<\/p>/g) ?? [];
  const lines: string[] = [];
  for (const p of paras) {
    // Extract speaker label if present as <span ttm:agent="..."> or aria label
    const inner = p.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (inner) lines.push(inner);
  }
  return lines.join("\n") + "\n";
}

/** Look up an episode's metadata from MTLibrary by store_id (single row). */
async function lookupByStoreId(
  g: GlobalArgs,
  storeId: string,
): Promise<z.infer<typeof EpisodeRefSchema> | null> {
  const rows = await queryMtlibrary(g, "ep.ZSTORETRACKID = ?", [storeId], 1);
  return rows[0] ?? null;
}

/* =============================================================================
 * Model
 * ========================================================================== */

/**
 * The apple-podcasts-transcript model definition. Registers two methods
 * (`search`, `fetch`) and two resources (`matches`, `episode`). See the module
 * docstring for the overall flow and the README for usage examples.
 */
export const model = {
  type: "@vcjdeboer/apple-podcasts-transcript",
  version: "2026.07.10.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "matches": {
      description:
        "Result of a MTLibrary search: candidate episodes with store_id, feed and enclosure URLs",
      schema: SearchResultSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    "episode": {
      description:
        "A fetched episode: metadata + on-disk paths to the TTML and plaintext transcript",
      schema: EpisodeSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
  },
  methods: {
    search: {
      description:
        "Substring-match MTLibrary.sqlite by podcast and/or episode title; returns candidate episodes with feed and enclosure URLs",
      arguments: SearchArgsSchema,
      execute: async (
        args: z.infer<typeof SearchArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const clauses: string[] = ["1=1"];
        const binds: string[] = [];
        if (args.podcast) {
          clauses.push("LOWER(pod.ZTITLE) LIKE ?");
          binds.push(`%${args.podcast.toLowerCase()}%`);
        }
        if (args.episode) {
          clauses.push("LOWER(ep.ZTITLE) LIKE ?");
          binds.push(`%${args.episode.toLowerCase()}%`);
        }
        const rows = await queryMtlibrary(
          ctx.globalArgs,
          clauses.join(" AND "),
          binds,
          args.limit,
        );
        const instance = safeName(
          [args.podcast, args.episode].filter(Boolean).join("-") || "any",
        );
        const handle = await ctx.writeResource("matches", instance, {
          query: { podcast: args.podcast, episode: args.episode },
          count: rows.length,
          matches: rows,
          searchedAt: new Date().toISOString(),
        });
        ctx.logger.info(
          "Search podcast~{p} episode~{e}: {n} matches",
          { p: args.podcast || "*", e: args.episode || "*", n: rows.length },
        );
        return { dataHandles: [handle] };
      },
    },
    fetch: {
      description:
        "Fetch an episode's transcript by Apple store_id: FetchTranscript binary first, RSS `<podcast:transcript>` fallback; writes TTML + plaintext to outputDir",
      arguments: FetchArgsSchema,
      execute: async (
        args: z.infer<typeof FetchArgsSchema>,
        ctx: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const g = ctx.globalArgs;
        await Deno.mkdir(g.outputDir, { recursive: true });
        const ep = (await lookupByStoreId(g, args.storeId)) ?? {
          storeId: args.storeId,
          podcastTitle: "",
          episodeTitle: "",
          publishedAt: "",
          feedUrl: "",
          enclosureUrl: "",
        };

        // Path 1: FetchTranscript
        const ft = await tryFetchTranscript(g, args.storeId);
        if ("ttmlPath" in ft) {
          const body = await Deno.readTextFile(ft.ttmlPath);
          const text = ttmlToText(body);
          const textPath = `${g.outputDir}/${slugify(ep.podcastTitle)}_${
            slugify(ep.episodeTitle || args.storeId)
          }.txt`;
          await Deno.writeTextFile(textPath, text);
          const st = await Deno.stat(ft.ttmlPath);
          const handle = await ctx.writeResource(
            "episode",
            safeName(args.storeId),
            {
              storeId: args.storeId,
              podcastTitle: ep.podcastTitle,
              episodeTitle: ep.episodeTitle,
              publishedAt: ep.publishedAt,
              feedUrl: ep.feedUrl,
              enclosureUrl: ep.enclosureUrl,
              source: "fetchtranscript",
              ttmlPath: ft.ttmlPath,
              textPath,
              ttmlBytes: st.size,
              textChars: text.length,
              fetchedAt: new Date().toISOString(),
            },
          );
          ctx.logger.info(
            "Fetched {id} via FetchTranscript: {bytes} bytes TTML, {chars} chars text",
            { id: args.storeId, bytes: st.size, chars: text.length },
          );
          return { dataHandles: [handle] };
        }
        const ftStderr = ft.stderr;

        // Path 2: RSS <podcast:transcript>
        const rss = await tryRssTranscript(g, ep);
        if (rss) {
          const st = await Deno.stat(rss.ttmlPath);
          const text = await Deno.readTextFile(rss.textPath);
          const handle = await ctx.writeResource(
            "episode",
            safeName(args.storeId),
            {
              storeId: args.storeId,
              podcastTitle: ep.podcastTitle,
              episodeTitle: ep.episodeTitle,
              publishedAt: ep.publishedAt,
              feedUrl: ep.feedUrl,
              enclosureUrl: ep.enclosureUrl,
              source: "rss",
              ttmlPath: rss.ttmlPath,
              textPath: rss.textPath,
              ttmlBytes: st.size,
              textChars: text.length,
              fetchedAt: new Date().toISOString(),
            },
          );
          ctx.logger.info(
            "Fetched {id} via RSS <podcast:transcript>: {chars} chars text",
            { id: args.storeId, chars: text.length },
          );
          return { dataHandles: [handle] };
        }

        // Distinguish the "auth" failure mode (no signed-in Apple ID → amsd
        // refused to sign) from Apple's honest 404 for episodes it hasn't
        // transcribed. Both surface in FetchTranscript stderr — pattern-match.
        const looksLikeAuth =
          /Mescal|signData|AMSMescalSession|not.*signed|no.*account/i
            .test(ftStderr);
        const authHint = looksLikeAuth
          ? "\n\nHint: FetchTranscript could not sign its token request. " +
            "Confirm you are signed in to your Apple ID on this Mac " +
            "(System Settings → Apple ID) — the Apple Media Services daemon " +
            "(amsd) uses that identity to authorize the transcripts endpoint."
          : "";
        throw new Error(
          `No transcript for ${args.storeId}: FetchTranscript returned nothing ` +
            `and the RSS feed has no <podcast:transcript> element.` +
            (ftStderr ? `\n\nFetchTranscript stderr:\n${ftStderr}` : "") +
            authHint,
        );
      },
    },
  },
};
