<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=RooVeterinaryInc.roo-cline"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
</p>

# Roo Code (Community Fork)

> Your AI-Powered Dev Team, Right in Your Editor

> **📢 Community Fork Notice:** This is a community-maintained fork of [Roo Code](https://github.com/RooCodeInc/Roo-Code) (v3.54.0), which was archived by Roo Code, Inc. This fork is maintained by [ec-jt](https://github.com/ec-jt) and the community to keep the project alive and actively developed.

<details>
  <summary>🌐 Available languages</summary>

- [English](README.md)
- [Català](locales/ca/README.md)
- [Deutsch](locales/de/README.md)
- [Español](locales/es/README.md)
- [Français](locales/fr/README.md)
- [हिंदी](locales/hi/README.md)
- [Bahasa Indonesia](locales/id/README.md)
- [Italiano](locales/it/README.md)
- [日本語](locales/ja/README.md)
- [한국어](locales/ko/README.md)
- [Nederlands](locales/nl/README.md)
- [Polski](locales/pl/README.md)
- [Português (BR)](locales/pt-BR/README.md)
- [Русский](locales/ru/README.md)
- [Türkçe](locales/tr/README.md)
- [Tiếng Việt](locales/vi/README.md)
- [简体中文](locales/zh-CN/README.md)
- [繁體中文](locales/zh-TW/README.md)
- ...
      </details>

---

## What Can Roo Code Do For YOU?

- Generate Code from natural language descriptions and specs
- Adapt with Modes: Code, Architect, Ask, Debug, and Custom Modes
- Refactor & Debug existing code
- Write & Update documentation
- Answer Questions about your codebase
- Automate repetitive tasks
- Utilize MCP Servers

## Modes

Roo Code adapts to how you work:

- Code Mode: everyday coding, edits, and file ops
- Architect Mode: plan systems, specs, and migrations
- Ask Mode: fast answers, explanations, and docs
- Debug Mode: trace issues, add logs, isolate root causes
- Custom Modes: build specialized modes for your team or workflow

Learn more: [Using Modes](https://roocodeinc.github.io/Roo-Code/basic-usage/using-modes) • [Custom Modes](https://roocodeinc.github.io/Roo-Code/advanced-usage/custom-modes)

## Resources

- **[Documentation](https://roocodeinc.github.io/Roo-Code/):** The official guide to installing, configuring, and mastering Roo Code.
- **[GitHub Issues](https://github.com/ec-jt/Roo-Code/issues):** Report bugs and track development.

---

## Releasing

Prerelease builds use the `cordis-preview` tag series.

1. Bump `version` in [`src/package.json`](src/package.json) and add `releases/v<version>-cordis-preview.<n>.md`.
2. Install dependencies once with `pnpm install --frozen-lockfile`.
3. Build and package with `pnpm vsix`. This builds `@roo-code/types`, the WebView UI and the extension bundle, then writes `bin/roo-cline-<version>.vsix`.
4. Write the checksum sidecar with the bare asset filename: `sha256sum bin/roo-cline-<version>.vsix | sed 's#  bin/#  #' > bin/roo-cline-<version>.vsix.sha256`. Verify it from inside `bin/` with `sha256sum -c roo-cline-<version>.vsix.sha256`. The updater compares the sidecar name with the VSIX asset name, so a `bin/` prefix breaks it.
5. Run the gates: `pnpm lint`, then `cd src && ../node_modules/.bin/tsc --noEmit`. Confirm the VSIX passes `unzip -t`, carries the expected manifest version, contains both worker bundles, and has no `.env` file.
6. Commit only the release files: `src/package.json`, the release notes and the `bin/` artifacts.
7. Tag and push together: `git tag -a v<version>-cordis-preview.<n> -m "Roo Code <version> - Cordis preview <n>"`, then `git push --atomic origin <branch> refs/tags/v<version>-cordis-preview.<n>`. Never force push.
8. Create the GitHub prerelease with `draft=false`, `prerelease=true` and `make_latest=false`. Upload the VSIX, its sidecar and the companion zip, then verify the server digest and size and confirm the published sidecar text still names the bare VSIX filename.
9. Optionally install and compare bytes: `code-server --install-extension ./bin/roo-cline-<version>.vsix --force`. Installation alone does not activate the new version; the editor must reload first.

Read the token from the git credential store or `GH_TOKEN` and never print it. A release must not list, migrate or delete existing task storage.

---

## License

[Apache 2.0 © 2026 Roo Code, Inc.](./LICENSE)
