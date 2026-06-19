# Obsidian Omnisearch in Google — CMDS

A Tampermonkey/Violentmonkey **userscript** that injects your [Obsidian](https://obsidian.md) [Omnisearch](https://github.com/scambier/obsidian-omnisearch) results into the Google search sidebar — now with **multi-vault** support, relevance bars, real body previews + tags via Local REST API, per-vault colors, themes, and keyboard navigation.

> **Credit / attribution**: This is a fork of **Simon Cambier's** original *"Inject Omnisearch results into your search engine"* userscript ([scambier/userscripts](https://github.com/scambier/userscripts), part of the [Omnisearch](https://github.com/scambier/obsidian-omnisearch) project). All credit for the original idea and base implementation goes to the original author. This fork (by 구요한 / CMDSPACE) heavily extends it.

## Install
1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey) in your browser.
2. Click the raw script to install:
   **[`obsidian-omnisearch-google-cmds.user.js`](https://raw.githubusercontent.com/johnfkoo951/obsidian-omnisearch-google-cmds/main/obsidian-omnisearch-google-cmds.user.js)**
3. In Obsidian, install **Omnisearch** and enable its HTTP server (Settings → Omnisearch → "HTTP server").
4. Search on Google → results appear in the right sidebar.

## Features
- **Multi-vault** fan-out — query several open vaults at once (one Omnisearch HTTP port per vault), merged and sorted by relevance, with per-vault badges/colors.
- **Relevance bars** (normalized BM25 score) + min-relevance filter, sort, type filters, in-widget refine.
- **Body preview + real tags** via the optional [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin (strips frontmatter, shows actual note body + tags).
- **Reliable open** — opens notes via Local REST `POST /open` (works across background vault windows); falls back to `obsidian://` deeplink (with Advanced URI option).
- **Themes** (9), **card skins** (Clean/Tinted/Solid/Flat), per-vault color scope, keyboard nav (`j/k/Enter/y`), copy note name / relative / absolute path.

## Configuration
Open Tampermonkey → this script → **Settings**. Each vault is a slot (Port / display name / deeplink vault name / color / filesystem root / Local REST port + key). General settings cover results count, themes, skin, vault-color scope, etc. Hover any label for a Korean tooltip.

See the in-repo script header and the [project notes](https://github.com/johnfkoo951/obsidian-omnisearch-google-cmds) for details.

## License
This fork is released under the **MIT License** (see `LICENSE`).
The original userscript by Simon Cambier carries **no explicit license**; this fork retains author attribution and links back to the source out of respect for the original work. If the original author objects to redistribution, please open an issue.
