# License resources

HUB's source license is [Apache-2.0](../../LICENSE); attribution is in
[NOTICE](../../NOTICE).

The DeepSeek Harness MIT license and generated third-party notice are preserved
verbatim. Relative links inside that upstream notice refer to its source tree,
not this copied resource directory. At HUB's pinned runtime revision:

- [Upstream MIT license](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/LICENSE)
- [npm dependency lock](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/pnpm-lock.yaml)
- [Python SDK lock](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/python/sdk/uv.lock)
- [Vendored component provenance](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/vendor/README.md)
- [node-pty patch](https://github.com/deepseek-ai/deepseek-harness/blob/db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5/patches/node-pty@1.2.0-beta.15.patch)

Optional speech models and external runtimes are downloaded/configured
separately and retain their own license/model-card terms.

`SIL-OFL-1.1.txt` is the verbatim official SIL Open Font License 1.1 text,
downloaded from https://openfontlicense.org/documents/OFL.txt. Its example
copyright header is retained as published; the installed UI build separately
preserves the actual copyright/license/reserved-name records embedded in the
pinned KaTeX fonts and verifies staged font bytes against those originals.
The retained resource SHA-256 is
`1d361a8f8e8ce6e68457dcd93fb56e162e6baa3bbb7e7573a290d44399f6b57e`.

Knowledge lexical candidate filtering adapts Graphify's trigram index into
TypeScript. See [Graphify attribution and changes](graphify-NOTICE),
[Apache-2.0 license](graphify-LICENSE), and the preserved historical
[MIT license](graphify-LICENSE-MIT). No Graphify CLI, provider configuration,
or Python runtime is bundled by this adaptation.
