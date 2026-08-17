import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";

import {
  createPinnedLookup,
  LinkPreviewService,
  parseDesktopLinkPreviewInput,
  parseLinkPreviewMetadata,
  requestPinnedResource,
  toSafeImageDataUrl,
  type RequestResource,
} from "../src/linkPreview.js";

test("pinned lookup returns the validated address in scalar and all-address modes", async () => {
  const lookup = createPinnedLookup({ address: "93.184.216.34", family: 4 });
  const scalar = await new Promise<unknown>((resolve, reject) => {
    lookup("example.com", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  const all = await new Promise<unknown>((resolve, reject) => {
    lookup("example.com", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

  assert.deepEqual(scalar, { address: "93.184.216.34", family: 4 });
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
});

test("link preview input accepts only unique credential-free http URLs", () => {
  assert.deepEqual(
    parseDesktopLinkPreviewInput({ urls: ["https://example.com"] }),
    { urls: ["https://example.com/"] },
  );
  assert.throws(
    () => parseDesktopLinkPreviewInput({ urls: ["https://example.com"], extra: true }),
    /does not support 'extra'/u,
  );
  assert.throws(
    () => parseDesktopLinkPreviewInput({ urls: ["https://user:secret@example.com"] }),
    /credential-free/u,
  );
  assert.throws(
    () => parseDesktopLinkPreviewInput({ urls: ["https://example.com", "https://example.com/"] }),
    /must be unique/u,
  );
});

test("Open Graph metadata wins over Twitter and HTML fallbacks", () => {
  const metadata = parseLinkPreviewMetadata(`
    <html><head>
      <title>HTML title</title>
      <meta name="twitter:title" content="Twitter title">
      <meta property="og:title" content="Open Graph title">
      <meta name="description" content="HTML description">
      <meta property="og:description" content="Open Graph description">
      <meta property="og:site_name" content="Example News">
      <meta property="og:image" content="/media/story.jpg">
      <link rel="canonical alternate" href="/stories/canonical">
    </head></html>
  `, new URL("https://news.example/stories/source"));

  assert.deepEqual(metadata, {
    title: "Open Graph title",
    description: "Open Graph description",
    siteName: "Example News",
    canonicalUrl: new URL("https://news.example/stories/canonical"),
    imageUrl: new URL("https://news.example/media/story.jpg"),
  });
});

test("metadata parsing falls back to normalized HTML title and rejects missing titles", () => {
  assert.deepEqual(
    parseLinkPreviewMetadata(
      "<title>  A title with   space </title><meta name='description' content='  Useful   copy  '>",
      new URL("https://example.com"),
    ),
    { title: "A title with space", description: "Useful copy" },
  );
  assert.equal(
    parseLinkPreviewMetadata("<meta property='og:description' content='No title'>", new URL("https://example.com")),
    undefined,
  );
});

test("preview fetch pins validated public addresses and revalidates redirects and images", async () => {
  const jpeg = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 3,
      background: "#336699",
    },
  }).jpeg().toBuffer();
  const requests: Array<Parameters<RequestResource>[0]> = [];
  const request: RequestResource = async (input) => {
    requests.push(input);
    if (input.url.hostname === "start.example") {
      return {
        status: 302,
        headers: { location: "https://news.example/story" },
        body: Buffer.alloc(0),
      };
    }
    if (input.url.hostname === "images.example") {
      return {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        body: jpeg,
      };
    }
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from(`
        <meta property="og:title" content="Pinned story">
        <meta property="og:image" content="https://images.example/story.jpg">
      `),
    };
  };
  const addresses = new Map([
    ["start.example", "93.184.216.34"],
    ["news.example", "1.1.1.1"],
    ["images.example", "8.8.8.8"],
  ]);
  const service = new LinkPreviewService({
    resolve: async (hostname) => [{
      address: addresses.get(hostname) ?? "9.9.9.9",
      family: 4,
    }],
    request,
  });

  const [result] = await service.getPreviews({ urls: ["https://start.example/story"] });
  assert.equal(result?.status, "available");
  assert.equal(result?.status === "available" ? result.finalUrl : undefined, "https://news.example/story");
  assert.match(result?.status === "available" ? result.imageDataUrl ?? "" : "", /^data:image\/webp;base64,/u);
  assert.deepEqual(
    requests.map((entry) => [entry.url.hostname, entry.pinned.address]),
    [
      ["start.example", "93.184.216.34"],
      ["news.example", "1.1.1.1"],
      ["images.example", "8.8.8.8"],
    ],
  );
  for (const entry of requests) {
    assert.equal(entry.headers.authorization, undefined);
    assert.equal(entry.headers.cookie, undefined);
    assert.equal(entry.headers.referer, undefined);
  }
  assert.equal(
    requests.find((entry) => entry.url.hostname === "images.example")
      ?.headers.accept,
    "image/webp,image/png,image/jpeg;q=0.9",
  );
});

test("preview image normalization decodes static raster input and rejects malformed or unsafe images", async () => {
  const jpeg = await sharp({
    create: {
      width: 1_200,
      height: 800,
      channels: 3,
      background: "#884422",
    },
  }).jpeg().toBuffer();
  const normalized = await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/jpeg" },
    body: jpeg,
    finalUrl: new URL("https://images.example/story.jpg"),
  });
  assert.match(normalized ?? "", /^data:image\/webp;base64,/u);
  const normalizedMetadata = await sharp(
    Buffer.from(normalized?.split(",", 2)[1] ?? "", "base64"),
  ).metadata();
  assert.equal(normalizedMetadata.format, "webp");
  assert.equal(normalizedMetadata.width, 540);
  assert.equal(normalizedMetadata.height, 360);

  assert.equal(await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
    finalUrl: new URL("https://images.example/truncated.jpg"),
  }), undefined);
  assert.equal(await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/png" },
    body: jpeg,
    finalUrl: new URL("https://images.example/mismatch.png"),
  }), undefined);

  const tooWide = await sharp({
    create: {
      width: 8_193,
      height: 1,
      channels: 3,
      background: "#000000",
    },
  }).png().toBuffer();
  assert.equal(await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/png" },
    body: tooWide,
    finalUrl: new URL("https://images.example/wide.png"),
  }), undefined);

  const tooManyPixels = await sharp({
    create: {
      width: 5_000,
      height: 5_000,
      channels: 3,
      background: "#000000",
    },
  }).png().toBuffer();
  assert.equal(await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/png" },
    body: tooManyPixels,
    finalUrl: new URL("https://images.example/large.png"),
  }), undefined);

  const frameOne = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#ff0000" },
  }).png().toBuffer();
  const frameTwo = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#00ff00" },
  }).png().toBuffer();
  const animatedWebp = await sharp([frameOne, frameTwo], {
    join: { animated: true } as never,
  }).webp({ delay: [100, 100], loop: 0 }).toBuffer();
  assert.equal(await toSafeImageDataUrl({
    status: 200,
    headers: { "content-type": "image/webp" },
    body: animatedWebp,
    finalUrl: new URL("https://images.example/animated.webp"),
  }), undefined);
});

test("pinned transport cancels an endless oversized response instead of waiting for EOF", async () => {
  let responseClosed = false;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    const interval = setInterval(() => {
      response.write(Buffer.alloc(1_024, 0x61));
    }, 5);
    response.once("close", () => {
      responseClosed = true;
      clearInterval(interval);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const startedAt = Date.now();
  try {
    await assert.rejects(
      requestPinnedResource({
        url: new URL(`http://preview.test:${address.port}/endless`),
        pinned: { address: "127.0.0.1", family: 4 },
        headers: { accept: "text/html" },
        maxBytes: 1_500,
        timeoutMs: 2_000,
      }),
      /oversized/u,
    );
    assert.ok(Date.now() - startedAt < 1_500);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(responseClosed, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("preview fetch blocks any non-public resolution before requesting content", async () => {
  let requests = 0;
  const service = new LinkPreviewService({
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    request: async () => {
      requests += 1;
      throw new Error("must not run");
    },
  });
  const [result] = await service.getPreviews({ urls: ["https://example.com/"] });
  assert.deepEqual(result, {
    status: "unavailable",
    requestedUrl: "https://example.com/",
    reason: "blocked",
  });
  assert.equal(requests, 0);
});

test("preview fetch settles when DNS resolution exceeds the request deadline", async () => {
  const service = new LinkPreviewService({
    resolve: async () => await new Promise(() => undefined),
    request: async () => {
      throw new Error("must not run");
    },
  });

  const [result] = await service.getPreviews({ urls: ["https://example.com/"] });
  assert.deepEqual(result, {
    status: "unavailable",
    requestedUrl: "https://example.com/",
    reason: "timeout",
  });
});

test("preview fetch recomputes the total budget after DNS resolution", async () => {
  let now = 0;
  let requestTimeout: number | undefined;
  const service = new LinkPreviewService({
    now: () => now,
    resolve: async () => {
      now = 7_000;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    request: async (input) => {
      requestTimeout = input.timeoutMs;
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>Within budget</title>"),
      };
    },
  });

  const [result] = await service.getPreviews({ urls: ["https://example.com/"] });
  assert.equal(result?.status, "available");
  assert.equal(requestTimeout, 1_000);
});

test("image normalization cannot extend the total preview deadline", async () => {
  let now = 0;
  let normalizationStarted = false;
  const service = new LinkPreviewService({
    now: () => now,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (input) => {
      if (input.url.hostname === "images.example") {
        now = 7_990;
        return {
          status: 200,
          headers: { "content-type": "image/jpeg" },
          body: Buffer.from("image"),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(`
          <meta property="og:title" content="Deadline bounded">
          <meta property="og:image" content="https://images.example/story.jpg">
        `),
      };
    },
    normalizeImage: async () => {
      normalizationStarted = true;
      return await new Promise<string>(() => undefined);
    },
  });

  const startedAt = Date.now();
  const [result] = await service.getPreviews({
    urls: ["https://example.com/story"],
  });

  assert.equal(normalizationStarted, true);
  assert.equal(result?.status, "available");
  assert.equal(
    result?.status === "available" ? result.imageDataUrl : undefined,
    undefined,
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("preview service deduplicates concurrent and cached requests", async () => {
  let requests = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new LinkPreviewService({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => {
      requests += 1;
      await gate;
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>One result</title>"),
      };
    },
  });
  const first = service.getPreviews({ urls: ["https://example.com/"] });
  const second = service.getPreviews({ urls: ["https://example.com/"] });
  release?.();
  await Promise.all([first, second]);
  await service.getPreviews({ urls: ["https://example.com/"] });
  assert.equal(requests, 1);
});

test("preview cache expires success and failure entries from the current clock", async () => {
  let now = 1_800_000_000_000;
  const requests = new Map<string, number>();
  const service = new LinkPreviewService({
    now: () => now,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (input) => {
      requests.set(input.url.href, (requests.get(input.url.href) ?? 0) + 1);
      if (input.url.hostname === "failure.example") {
        throw new Error("network failure");
      }
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>Cached result</title>"),
      };
    },
  });

  const successfulUrl = "https://success.example/";
  await service.getPreviews({ urls: [successfulUrl] });
  now += 24 * 60 * 60 * 1_000 - 1;
  await service.getPreviews({ urls: [successfulUrl] });
  assert.equal(requests.get(successfulUrl), 1);
  now += 2;
  await service.getPreviews({ urls: [successfulUrl] });
  assert.equal(requests.get(successfulUrl), 2);

  const failedUrl = "https://failure.example/";
  await service.getPreviews({ urls: [failedUrl] });
  now += 15 * 60 * 1_000 - 1;
  await service.getPreviews({ urls: [failedUrl] });
  assert.equal(requests.get(failedUrl), 1);
  now += 2;
  await service.getPreviews({ urls: [failedUrl] });
  assert.equal(requests.get(failedUrl), 2);
});

test("preview service releases concurrency and in-flight state after failures", async () => {
  let now = 0;
  let active = 0;
  let maximumActive = 0;
  let requests = 0;
  let shouldFail = true;
  const service = new LinkPreviewService({
    now: () => now,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async () => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      if (shouldFail) throw new Error("network failure");
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from("<title>Recovered</title>"),
      };
    },
  });

  const failed = await service.getPreviews({
    urls: [1, 2, 3, 4].map((index) => `https://failure-${index}.example/`),
  });
  assert.ok(failed.every((result) => result.status === "unavailable"));
  assert.equal(maximumActive, 4);

  await service.getPreviews({ urls: ["https://retry.example/"] });
  shouldFail = false;
  now = 15 * 60 * 1_000 + 1;
  const [recovered] = await service.getPreviews({
    urls: ["https://retry.example/"],
  });
  assert.equal(recovered?.status, "available");
  assert.equal(requests, 6);
});
