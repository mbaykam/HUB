import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCT_MANIFESTS } from "../scripts/forge/set-version.mjs";
import {
  validateDiscordBotToken,
} from "../packages/im-discord/src/index.ts";
import {
  sanitizeBotAgent,
} from "../packages/im-weixin/src/network.ts";
import {
  MINKE_WEB_SEARCH_DEFAULT_USER_AGENT,
} from "../packages/harness-overlay/src/web-search/provider.ts";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);


function readManifest(relativePath) {
  return JSON.parse(
    readFileSync(resolve(projectRoot, relativePath), "utf8"),
  );
}

test("all product manifests declare the same release as the application", () => {
  const version = readManifest("package.json").version;
  for (const relativePath of PRODUCT_MANIFESTS) {
    assert.equal(
      readManifest(relativePath).version,
      version,
      `${relativePath} must match the product release`,
    );
  }
});

test("default network identities expose the product version", async () => {
  const version = readManifest("package.json").version;
  assert.equal(sanitizeBotAgent(undefined), `HUB/${version}`);
  assert.equal(
    MINKE_WEB_SEARCH_DEFAULT_USER_AGENT,
    `HUB/${version} (+https://github.com/mbaykam/HUB)`,
  );

  let discordUserAgent;
  await validateDiscordBotToken({
    fetch: async (_input, init) => {
      discordUserAgent = new Headers(init?.headers).get(
        "user-agent",
      );
      return new Response(JSON.stringify({
        avatar: null,
        bot: true,
        discriminator: "0",
        global_name: "HUB Bot",
        id: "100000000000000001",
        username: "minke",
      }), {
        headers: { "content-type": "application/json" },
      });
    },
    token: "release-version-test-token",
  });
  assert.equal(
    discordUserAgent,
    `DiscordBot (https://github.com/mbaykam/HUB, ${version})`,
  );
});
