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

Knowledge lexical candidate filtering adapts Graphify's trigram index into
TypeScript. See [Graphify attribution and changes](graphify-NOTICE),
[Apache-2.0 license](graphify-LICENSE), and the preserved historical
[MIT license](graphify-LICENSE-MIT). No Graphify CLI, provider configuration,
or Python runtime is bundled by this adaptation.
