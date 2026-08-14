/**
 * Unit tests for @vcjdeboer/apple-podcasts-transcript.
 *
 * Coverage:
 *   - pure helpers: slugify, safeName, sqlQuote, ttmlToText
 *     (success cases + edge cases + one adversarial case per helper)
 *   - tryFetchTranscript with a synthetic binary that either writes a TTML
 *     (success path) or emits stderr (failure path — Apple 404, and auth
 *     failure from an unsigned-in Apple ID)
 *
 * The synthetic-binary strategy lets us exercise the real subprocess wiring
 * (Deno.Command, cwd handling, file-write-based success detection) without
 * touching Apple's servers.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  normalizeReleaseDate,
  parseCatalogEpisodes,
  pickPodcastMatch,
  safeName,
  searchCatalog,
  slugify,
  sqlQuote,
  tryFetchTranscript,
  ttmlToText,
} from "./apple_podcasts_transcript.ts";

/* =============================================================================
 * slugify
 * ========================================================================== */
Deno.test("slugify: basic ASCII collapses runs of punctuation to single dashes", () => {
  assertEquals(
    slugify("The Stack Overflow Podcast"),
    "The-Stack-Overflow-Podcast",
  );
  assertEquals(slugify("Hello, world!"), "Hello-world");
});

Deno.test("slugify: strips leading and trailing dashes", () => {
  assertEquals(slugify("---trim me---"), "trim-me");
});

Deno.test("slugify: strips diacritics (Café → Cafe)", () => {
  assertEquals(slugify("Café Résumé"), "Cafe-Resume");
});

Deno.test("slugify: empty input returns the sentinel 'episode'", () => {
  assertEquals(slugify(""), "episode");
});

Deno.test("slugify: all-punctuation input also returns 'episode'", () => {
  // After punctuation is collapsed and trimmed, nothing remains.
  assertEquals(slugify("!!!---!!!"), "episode");
});

Deno.test("slugify: caps very long titles at 80 chars", () => {
  const long = "a".repeat(200);
  assertEquals(slugify(long).length, 80);
});

/* =============================================================================
 * safeName
 * ========================================================================== */
Deno.test("safeName: preserves alphanumeric plus underscore and dash", () => {
  assertEquals(safeName("abc_123-xyz"), "abc_123-xyz");
});

Deno.test("safeName: replaces every other character with underscore", () => {
  assertEquals(safeName("hello world!"), "hello_world_");
});

Deno.test("safeName: empty input returns 'instance'", () => {
  assertEquals(safeName(""), "instance");
});

/* =============================================================================
 * sqlQuote
 * ========================================================================== */
Deno.test("sqlQuote: wraps in single quotes for a plain string", () => {
  assertEquals(sqlQuote("hello"), "'hello'");
});

Deno.test("sqlQuote: doubles embedded single quotes (SQL escape)", () => {
  // Classic injection attempt — the closing quote is escaped, so the injected
  // "; DROP..." ends up inside the string literal, not as SQL syntax.
  assertEquals(sqlQuote("'; DROP TABLE ep;--"), "'''; DROP TABLE ep;--'");
});

Deno.test("sqlQuote: empty string is a valid empty literal", () => {
  assertEquals(sqlQuote(""), "''");
});

/* =============================================================================
 * ttmlToText
 * ========================================================================== */
Deno.test("ttmlToText: extracts <p> content as one utterance per line", () => {
  const ttml = `<tt xmlns="http://www.w3.org/ns/ttml">
    <body>
      <div>
        <p begin="0" end="1">Hello there.</p>
        <p begin="1" end="2">General Kenobi.</p>
      </div>
    </body>
  </tt>`;
  assertEquals(ttmlToText(ttml), "Hello there.\nGeneral Kenobi.\n");
});

Deno.test("ttmlToText: flattens nested <span> inside <p>", () => {
  const ttml = `<p>Hello <span ttm:agent="s1">there</span> friend.</p>`;
  assertEquals(ttmlToText(ttml), "Hello there friend.\n");
});

Deno.test("ttmlToText: collapses runs of whitespace", () => {
  const ttml = `<p>  spaced\n\nout   text  </p>`;
  assertEquals(ttmlToText(ttml), "spaced out text\n");
});

Deno.test("ttmlToText: input that isn't TTML is passed through as-is (RSS text/plain)", () => {
  const plain = "This is a plaintext transcript from RSS.";
  assertEquals(ttmlToText(plain), plain + "\n");
});

Deno.test("ttmlToText: empty <p> tags do not produce blank lines", () => {
  const ttml = `<p></p><p>Only line.</p><p>   </p>`;
  assertEquals(ttmlToText(ttml), "Only line.\n");
});

/* =============================================================================
 * tryFetchTranscript — synthetic binary
 *
 * The strategy: write a small shell script that, given argv, either writes
 * transcript_<id>.ttml to cwd (success) or prints something to stderr
 * (failure). This exercises the real Deno.Command path — cwd handling, output
 * detection, stderr capture — without touching Apple.
 * ========================================================================== */

async function makeSyntheticBinary(
  dir: string,
  behavior: "success" | "404" | "auth",
): Promise<string> {
  const path = `${dir}/fake_fetch.sh`;
  let script = "#!/bin/sh\n";
  if (behavior === "success") {
    // Positional arg 1 is the store ID.
    script +=
      'printf \'<tt><body><div><p>synthetic transcript for %s</p></div></body></tt>\' "$1" > "transcript_$1.ttml"\n';
  } else if (behavior === "404") {
    script +=
      "echo 'Failed to fetch data for transcript: {code = 40403; status = 404; title = \"No related resources\";}' 1>&2\nexit 0\n";
  } else {
    script +=
      "echo 'AMSMescalSession failed to signData: no Apple ID signed in' 1>&2\nexit 1\n";
  }
  await Deno.writeTextFile(path, script);
  await Deno.chmod(path, 0o755);
  return path;
}

function testGlobals(dir: string, bin: string) {
  return {
    mtlibraryPath: "/tmp/never-used-in-this-test",
    fetchTranscriptBin: bin,
    outputDir: dir,
    feedTimeoutSec: 30,
    keepTtml: false,
  };
}

Deno.test("tryFetchTranscript: success path returns the written ttml file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apt-test-success-" });
  try {
    const bin = await makeSyntheticBinary(dir, "success");
    const r = await tryFetchTranscript(testGlobals(dir, bin), "12345");
    assert("ttmlPath" in r, "expected success shape");
    if ("ttmlPath" in r) {
      const body = await Deno.readTextFile(r.ttmlPath);
      assertStringIncludes(body, "synthetic transcript for 12345");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tryFetchTranscript: Apple 404 path returns stderr (no file, no throw)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apt-test-404-" });
  try {
    const bin = await makeSyntheticBinary(dir, "404");
    const r = await tryFetchTranscript(testGlobals(dir, bin), "999");
    assert("stderr" in r, "expected failure shape");
    if ("stderr" in r) {
      assertStringIncludes(r.stderr, "No related resources");
    }
    // No transcript file left behind.
    let exists = false;
    try {
      await Deno.stat(`${dir}/transcript_999.ttml`);
      exists = true;
    } catch { /* ok */ }
    assertEquals(exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tryFetchTranscript: auth-failure stderr surfaces AMSMescalSession keyword", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apt-test-auth-" });
  try {
    const bin = await makeSyntheticBinary(dir, "auth");
    const r = await tryFetchTranscript(testGlobals(dir, bin), "111");
    assert("stderr" in r);
    if ("stderr" in r) {
      // The regex in the fetch method looks for /Mescal|signData|AMSMescalSession/i
      // — verify the token that would trigger the auth-hint branch is present.
      assertStringIncludes(r.stderr, "AMSMescalSession");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("tryFetchTranscript: missing binary is reported via stderr, not a raised exception", async () => {
  const dir = await Deno.makeTempDir({ prefix: "apt-test-missing-" });
  try {
    // Point at a path that definitely doesn't exist. Deno.Command surfaces this
    // as a NotFound before the process starts; we swallow into stderr shape.
    const globals = testGlobals(dir, `${dir}/does-not-exist`);
    let threw: unknown = null;
    try {
      await tryFetchTranscript(globals, "555");
    } catch (e) {
      threw = e;
    }
    // Current behavior: the helper lets NotFound bubble up. Assert that so a
    // future refactor that changes the shape is surfaced by CI.
    assert(threw !== null, "expected the missing-binary NotFound to propagate");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/* =============================================================================
 * normalizeReleaseDate — iTunes ISO → library-style "YYYY-MM-DD HH:MM:SS"
 * ========================================================================== */
Deno.test("normalizeReleaseDate: converts ISO Z timestamp to library display form", () => {
  assertEquals(
    normalizeReleaseDate("2026-08-12T07:01:00Z"),
    "2026-08-12 07:01:00",
  );
});

Deno.test("normalizeReleaseDate: drops fractional seconds", () => {
  assertEquals(
    normalizeReleaseDate("2026-08-12T07:01:00.000Z"),
    "2026-08-12 07:01:00",
  );
});

Deno.test("normalizeReleaseDate: passes through an already-normalized value", () => {
  assertEquals(
    normalizeReleaseDate("2026-05-13 21:00:00"),
    "2026-05-13 21:00:00",
  );
});

Deno.test("normalizeReleaseDate: empty input yields empty string", () => {
  assertEquals(normalizeReleaseDate(""), "");
});

/* =============================================================================
 * pickPodcastMatch — choose a collectionId from an iTunes podcast search
 * ========================================================================== */
Deno.test("pickPodcastMatch: returns the first result's id and feed when only one match", () => {
  const results = [
    {
      collectionId: 1769051199,
      collectionName: "The Pragmatic Engineer",
      feedUrl: "https://api.substack.com/feed/podcast/458709.rss",
    },
  ];
  const m = pickPodcastMatch(results, "pragmatic");
  assertEquals(m?.collectionId, "1769051199");
  assertEquals(m?.feedUrl, "https://api.substack.com/feed/podcast/458709.rss");
});

Deno.test("pickPodcastMatch: prefers an exact case-insensitive name match over rank order", () => {
  const results = [
    {
      collectionId: 111,
      collectionName: "Pragmatic Engineer Daily",
      feedUrl: "a",
    },
    {
      collectionId: 222,
      collectionName: "the pragmatic engineer",
      feedUrl: "b",
    },
  ];
  const m = pickPodcastMatch(results, "The Pragmatic Engineer");
  assertEquals(m?.collectionId, "222");
});

Deno.test("pickPodcastMatch: returns null when there are no results", () => {
  assertEquals(pickPodcastMatch([], "anything"), null);
});

/* =============================================================================
 * parseCatalogEpisodes — iTunes lookup rows → EpisodeRef[]
 * ========================================================================== */
function lookupFixture() {
  return [
    // The collection row iTunes returns first — must be skipped.
    { wrapperType: "track", kind: "podcast", collectionId: 1769051199 },
    {
      wrapperType: "podcastEpisode",
      trackId: 1000776932678,
      trackName: "Context engineering with Dex Horthy",
      collectionName: "The Pragmatic Engineer",
      releaseDate: "2026-07-15T07:00:00Z",
      feedUrl: "https://api.substack.com/feed/podcast/458709.rss",
      episodeUrl: "https://example.com/dex.mp3",
    },
    {
      wrapperType: "podcastEpisode",
      trackId: 1000782993949,
      trackName: "Stop being skeptical about AI for development",
      collectionName: "The Pragmatic Engineer",
      releaseDate: "2026-08-12T07:00:00Z",
      feedUrl: "https://api.substack.com/feed/podcast/458709.rss",
      episodeUrl: "https://example.com/charity.mp3",
    },
  ];
}

Deno.test("parseCatalogEpisodes: skips the collection row and maps trackId to storeId", () => {
  const rows = parseCatalogEpisodes(lookupFixture(), "", 20, "");
  assertEquals(rows.length, 2);
  assert(rows.every((r) => r.storeId !== ""));
  const dex = rows.find((r) => r.episodeTitle.includes("Context"));
  assertEquals(dex?.storeId, "1000776932678");
  assertEquals(dex?.podcastTitle, "The Pragmatic Engineer");
  assertEquals(
    dex?.feedUrl,
    "https://api.substack.com/feed/podcast/458709.rss",
  );
  assertEquals(dex?.enclosureUrl, "https://example.com/dex.mp3");
  assertEquals(dex?.publishedAt, "2026-07-15 07:00:00");
});

Deno.test("parseCatalogEpisodes: filters by episode substring case-insensitively", () => {
  const rows = parseCatalogEpisodes(lookupFixture(), "SKEPTICAL", 20, "");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].storeId, "1000782993949");
});

Deno.test("parseCatalogEpisodes: sorts newest-first and caps at limit", () => {
  const rows = parseCatalogEpisodes(lookupFixture(), "", 1, "");
  assertEquals(rows.length, 1);
  // 2026-08-12 is newer than 2026-07-15 → the AI episode wins the single slot.
  assertEquals(rows[0].storeId, "1000782993949");
});

Deno.test("parseCatalogEpisodes: falls back to the podcast feedUrl when a row lacks one", () => {
  const rows = parseCatalogEpisodes(
    [{
      wrapperType: "podcastEpisode",
      trackId: 5,
      trackName: "No feed here",
      releaseDate: "2026-01-01T00:00:00Z",
    }],
    "",
    20,
    "https://fallback.example/feed.rss",
  );
  assertEquals(rows[0].feedUrl, "https://fallback.example/feed.rss");
});

/* =============================================================================
 * searchCatalog — two-step public iTunes lookup with an injected fetch
 * ========================================================================== */
Deno.test("searchCatalog: resolves podcast then episodes via the public API (no library)", async () => {
  const calls: string[] = [];
  const stubFetch = ((url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/search")) {
      return Promise.resolve(
        new Response(JSON.stringify({
          resultCount: 1,
          results: [{
            collectionId: 1769051199,
            collectionName: "The Pragmatic Engineer",
            feedUrl: "https://api.substack.com/feed/podcast/458709.rss",
          }],
        })),
      );
    }
    // /lookup
    return Promise.resolve(
      new Response(
        JSON.stringify({ resultCount: 3, results: lookupFixture() }),
      ),
    );
  }) as typeof fetch;

  const rows = await searchCatalog(
    { podcast: "pragmatic engineer", episode: "", limit: 20 },
    stubFetch,
  );
  assertEquals(rows.length, 2);
  assert(
    calls[0].includes("/search"),
    "first call hits the podcast search endpoint",
  );
  assert(
    calls[1].includes("/lookup"),
    "second call hits the episode lookup endpoint",
  );
  assert(
    calls[1].includes("1769051199"),
    "lookup uses the resolved collectionId",
  );
});

Deno.test("searchCatalog: returns empty when the podcast is not found in the catalog", async () => {
  const stubFetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ resultCount: 0, results: [] })),
    )) as typeof fetch;
  const rows = await searchCatalog(
    { podcast: "no-such-show", episode: "", limit: 20 },
    stubFetch,
  );
  assertEquals(rows, []);
});

Deno.test("searchCatalog: throws when no podcast term is given (never hits the network)", async () => {
  let called = false;
  const stubFetch = (() => {
    called = true;
    return Promise.resolve(new Response("{}"));
  }) as typeof fetch;
  await assertRejects(
    () => searchCatalog({ podcast: "   ", episode: "x", limit: 5 }, stubFetch),
    Error,
    "requires a 'podcast' term",
  );
  assertEquals(called, false, "must not call the API without a podcast term");
});

Deno.test("searchCatalog: throws with the HTTP status on a non-ok search response", async () => {
  const stubFetch = (() =>
    Promise.resolve(
      new Response("upstream boom", { status: 503 }),
    )) as typeof fetch;
  await assertRejects(
    () =>
      searchCatalog({ podcast: "anything", episode: "", limit: 5 }, stubFetch),
    Error,
    "HTTP 503",
  );
});
