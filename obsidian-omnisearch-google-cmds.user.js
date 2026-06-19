"use strict";
// ==UserScript==
// @name         Obsidian Omnisearch in Google — CMDS
// @namespace    https://github.com/johnfkoo951/obsidian-omnisearch-google-cmds
// @downloadURL  https://raw.githubusercontent.com/johnfkoo951/obsidian-omnisearch-google-cmds/main/obsidian-omnisearch-google-cmds.user.js
// @updateURL    https://raw.githubusercontent.com/johnfkoo951/obsidian-omnisearch-google-cmds/main/obsidian-omnisearch-google-cmds.user.js
// @homepageURL  https://github.com/johnfkoo951/obsidian-omnisearch-google-cmds
// @supportURL   https://github.com/johnfkoo951/obsidian-omnisearch-google-cmds/issues
// @version      0.13.3-custom
// @description  Injects Obsidian Omnisearch results into Google — multi-vault via split per-vault settings (port/name/deeplink/color/root, no hardcoded paths), Advanced-URI option for reliable cross-vault open, per-vault card tint, relevance bars, tag/matched-term chips, copy name/rel/abs path, keyboard nav, themes.
// @author       구요한 (CMDSPACE)
// @contributor  Simon Cambier (original "Obsidian Omnisearch in Google" — https://github.com/scambier/userscripts)
// @license      MIT  (this fork; original is unlicensed — see README. Credit retained to the original author.)
// @match        https://google.com/*
// @match        https://www.google.com/*
// @match        http://google.com/*
// @match        http://www.google.com/*
// @icon         https://obsidian.md/favicon.ico
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// @require      https://raw.githubusercontent.com/sizzlemctwizzle/GM_config/master/gm_config.js
// @require      https://gist.githubusercontent.com/scambier/109932d45b7592d3decf24194008be4d/raw/9c97aa67ff9c5d56be34a55ad6c18a314e5eb548/waitForKeyElements.js
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==
/* globals GM_config, jQuery, $, waitForKeyElements */
(function () {
    "use strict";

    const ID = "OmnisearchObsidianResults";
    const sidebarSelector = "#rhs";
    const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"];

    // ---------- persisted live state ----------
    const getVal = (k, d) => Promise.resolve(GM.getValue(k, d));
    const setVal = (k, v) => { try { GM.setValue(k, v); } catch (e) {} };

    const S = {};          // static settings (from GM_config)
    const state = {
        raw: [],           // merged results from all ports
        view: [],          // filtered + sorted + sliced
        topScore: 1,
        selected: -1,
        collapsed: false,
        controlsOpen: false,
        sort: "score",     // score | name | vault
        minRel: 0,         // 0..100 (% of top score)
        type: "all",       // all | md | pdf | img
        refine: "",        // overrides the URL query when set
        expanded: new Set(),
        vaultsSeen: 0,
    };

    // ---------- helpers ----------
    const escapeHtml = (str) =>
        String(str ?? "")
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    // Body-only preview: drop YAML frontmatter noise but KEEP Omnisearch's <mark> match highlight.
    const cleanExcerpt = (raw) => {
        let s = String(raw ?? "").replace(/<br\s*\/?>/gi, " ");
        if (S.cleanFrontmatter) {
            s = s
                .replace(/\b(type|aliases|author|description|date created|date modified|tags|CMDS|index|status|cssclasses|publish|created|modified|up|related|source|source-vault|cover|banner)\s*:/gi, " ")
                .replace(/!?\[\[[^\]]*\]\]/g, " ")                 // wikilinks / embeds
                .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:]+)?\b/g, " ") // ISO dates / timestamps
                .replace(/["'`]/g, " ")                            // stray quotes/backticks
                .replace(/(^|\s)-\s+/g, " ");                      // list markers
        }
        return s.replace(/\s{2,}/g, " ").trim();
    };

    const breadcrumb = (path) =>
        escapeHtml(String(path ?? "").replace(/\.md$/i, "")).split("/").join(' <span class="om-sep">›</span> ');

    const extOf = (p) => String(p ?? "").split(".").pop().toLowerCase();
    const matchType = (p, t) => {
        const e = extOf(p);
        if (t === "md") return e === "md";
        if (t === "pdf") return e === "pdf";
        if (t === "img") return IMG_EXT.includes(e);
        return true;
    };

    const validHex = (h) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(h || "").trim());

    // Vault configs come from the split settings slots (built in loadSettings → S.vaults).
    const parsePorts = () => S.vaults || [];

    // Build the obsidian:// deeplink.
    //   `obsidian://open?file=` resolves by path WITHOUT the .md extension — keeping ".md"
    //   makes it fail to open the note (it just switches vault). Strip .md only; keep .pdf/.png/etc.
    //   Advanced URI (plugin) resolves reliably across multiple open vault windows when enabled.
    function openUrl(item) {
        const v = item._dvault || item.vault || "";
        if (S.useAdvancedUri) {
            // Advanced URI reliably opens files even in background vault windows.
            // filepath wants the real path WITH extension.
            return `obsidian://adv-uri?vault=${encodeURIComponent(v)}&filepath=${encodeURIComponent(item.path)}`;
        }
        // Vanilla open resolves by path WITHOUT .md. (Note: vanilla can still fail to open a
        // note in a *background* vault window — that's an Obsidian limitation; use Advanced URI.)
        const file = String(item.path || "").replace(/\.md$/i, "");
        return `obsidian://open?vault=${encodeURIComponent(v)}&file=${encodeURIComponent(file)}`;
    }

    const hasRest = (item) => S.useLocalRest && item && item._restKey && lrBase(item._restPort);

    // Open directly via Local REST API (POST /open/{path}) — talks to that vault's own server,
    // so it works regardless of which vault window is focused or which plugins it has.
    function openViaRest(item) {
        const base = lrBase(item._restPort);
        const enc = String(item.path || "").split("/").map(encodeURIComponent).join("/");
        GM.xmlHttpRequest({
            method: "POST",
            url: `${base}/open/${enc}`,
            headers: { "Authorization": "Bearer " + item._restKey },
            timeout: S.requestTimeout,
            onload: (r) => {
                if (r.status >= 300) {
                    console.warn("[Omnisearch CMDS] /open", r.status, "→ falling back to deeplink");
                    window.location.href = openUrl(item);
                }
            },
            onerror: () => { window.location.href = openUrl(item); }, // fall back to obsidian://
            ontimeout: () => { window.location.href = openUrl(item); },
        });
    }

    // Preferred opener: Local REST (most reliable for configured vaults) → else obsidian:// deeplink.
    function openItem(item) {
        if (!item) return;
        if (hasRest(item)) openViaRest(item);
        else window.location.href = openUrl(item);
    }

    const hexToRgb = (h) => {
        let s = String(h).replace("#", "").trim();
        if (s.length === 3) s = s.split("").map((c) => c + c).join("");
        const n = parseInt(s, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",");
    };
    function applyCustomColors() {
        const root = document.getElementById(ID);
        if (!root) return;
        if (validHex(S.accentColor)) {
            root.style.setProperty("--accent", S.accentColor.trim());
            root.style.setProperty("--accent-rgb", hexToRgb(S.accentColor.trim()));
        }
        if (validHex(S.titleColor)) root.style.setProperty("--title", S.titleColor.trim());
    }

    // Stable color per vault (used when no explicit #color is set for the port).
    const hashHue = (str) => {
        let h = 0;
        for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        return h % 360;
    };
    const vaultColor = (item) =>
        validHex(item._color) ? item._color : `hsl(${hashHue(item._label || item.vault || "")}, 62%, 58%)`;

    // Absolute filesystem path. The Omnisearch API does NOT return the OS path (only the
    // vault NAME + vault-relative path), so we resolve it one of two ways:
    //   1) explicit per-vault root (vN_root), or
    //   2) a shared parent dir + the vault name (works when vaults sit under one folder
    //      and the vault name == its folder name, which is the usual case).
    const absPath = (item) => {
        const explicit = S.vaultRoots[item._label] || S.vaultRoots[item.vault];
        if (explicit) return explicit.replace(/\/+$/, "") + "/" + item.path;
        if (S.vaultsParentDir && item.vault) {
            return S.vaultsParentDir.replace(/\/+$/, "") + "/" + item.vault + "/" + item.path;
        }
        return null;
    };

    // Best-effort tag extraction from the excerpt (Omnisearch HTTP API has no tags field).
    function extractTags(rawExcerpt) {
        const raw = String(rawExcerpt ?? "").replace(/&#?\w+;/g, " "); // strip HTML entities (&#039; &quot; …)
        const out = [], seen = new Set();
        const add = (t) => {
            t = String(t).trim().replace(/^#/, "").replace(/[,.;:]+$/, "");
            if (!t || t.length < 2 || t.length > 30 || /^\d+$/.test(t)) return;
            if (/[*`~|<>"'()→←↔]/.test(t)) return;           // reject markdown / junk fragments
            const k = t.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k); out.push(t);
        };
        (raw.match(/#[^\s#<>&,;\[\]"'*`…]{2,30}/g) || []).forEach(add);           // inline #hashtags
        (raw.match(/\[([^\[\]]*,[^\[\]]*)\]/g) || []).forEach((seg) =>            // [a, b, c] arrays
            seg.replace(/^\[|\]$/g, "").split(",").forEach(add));
        const tm = raw.match(/\btags\s*:\s*([^\n]{0,120})/i);                     // YAML "tags: a b c" run
        if (tm) tm[1].split(/\b[a-z][\w-]*\s*:/i)[0].split(/[\s,]+/).slice(0, 12).forEach(add);
        return out.slice(0, S.maxTags);
    }

    const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // ---------- Local REST API enrichment (real body + real tags) ----------
    // Strip the YAML frontmatter block from a note's raw markdown, then build a body-only
    // preview centered on the first query term (with <mark> highlight).
    function bodyPreview(content, query) {
        let body = String(content || "").replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""); // drop frontmatter
        body = body.replace(/```[\s\S]*?```/g, " ")           // code fences
                   .replace(/^#{1,6}\s+/gm, "")               // heading markers
                   .replace(/!?\[\[[^\]]*\]\]/g, " ")         // wikilinks/embeds
                   .replace(/[*_`>#-]/g, " ")                 // stray md symbols
                   .replace(/\s+/g, " ").trim();
        const terms = String(query || "").toLowerCase().split(/\s+/).filter((t) => t.length > 1);
        let idx = -1;
        for (const t of terms) { const p = body.toLowerCase().indexOf(t); if (p >= 0) { idx = p; break; } }
        let snip, lead = false, tail;
        if (idx >= 0) { const start = Math.max(0, idx - 60); lead = start > 0; snip = body.slice(start, start + 320); }
        else snip = body.slice(0, 320);
        tail = body.length > (idx >= 0 ? Math.max(0, idx - 60) : 0) + snip.length;
        let html = escapeHtml(snip);
        terms.forEach((t) => { html = html.replace(new RegExp("(" + escapeRegExp(t) + ")", "gi"), "<mark>$1</mark>"); });
        return (lead ? "… " : "") + html + (tail ? " …" : "");
    }

    // Accept a bare port ("27123"), host:port, or a full base URL ("http(s)://host:port[/]").
    function lrBase(port) {
        let p = String(port || "").trim().replace(/\/+$/, "");
        if (!p) return null;
        if (/^https?:\/\//i.test(p)) return p;          // full URL
        if (/^\d+$/.test(p)) return "http://127.0.0.1:" + p; // bare port → HTTP
        if (/^[\w.-]+:\d+$/.test(p)) return "http://" + p;   // host:port
        return null;
    }

    function fetchNote(cfg, path) {
        return new Promise((resolve) => {
            const base = lrBase(cfg.port);
            if (!base) { resolve(null); return; }
            const enc = String(path || "").split("/").map(encodeURIComponent).join("/");
            GM.xmlHttpRequest({
                method: "GET",
                url: `${base}/vault/${enc}`,
                headers: { "Authorization": "Bearer " + cfg.key, "Accept": "application/vnd.olrapi.note+json" },
                timeout: S.requestTimeout,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) {
                        console.warn("[Omnisearch CMDS] Local REST", r.status, base, (r.responseText || "").slice(0, 120));
                        resolve(null); return;
                    }
                    try { resolve(JSON.parse(r.response)); } catch (e) { resolve(null); }
                },
                onerror: (e) => { console.warn("[Omnisearch CMDS] Local REST connection failed →", base, "(HTTPS self-signed? enable the plugin's HTTP server and use that port)"); resolve(null); },
                ontimeout: () => { console.warn("[Omnisearch CMDS] Local REST timeout →", base); resolve(null); },
            });
        });
    }

    // Pull tags from a Local REST note JSON. Order = curated first:
    //   1) frontmatter.tags/tag (the vault's real, curated tags)
    //   2) top-level `tags` (olrapi exposes INLINE #tags here, not frontmatter — noisier)
    //   3) inline #tags extracted from the body (last resort)
    function notesTags(note) {
        const out = [];
        const push = (v) => {
            if (Array.isArray(v)) v.forEach(push);
            else if (typeof v === "string") v.split(/[,\s]+/).forEach((s) => out.push(s));
        };
        const fm = note.frontmatter || note.properties || {};
        push(fm.tags); push(fm.tag);                                  // 1) frontmatter (preferred)
        if (!out.length && Array.isArray(note.tags)) push(note.tags); // 2) inline (olrapi top-level)
        if (!out.length && note.content) extractTags(note.content).forEach((t) => out.push(t)); // 3) body
        const seen = new Set(), res = [];
        for (let t of out) {
            t = String(t).replace(/^#+/, "").replace(/[…\s.,;:]+$/u, "").trim(); // drop trailing ellipsis/punct
            if (!t || /^\d+$/.test(t)) continue;
            const k = t.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k); res.push(t);
        }
        return res;
    }

    let _restShape = false; // log the note shape once, to help diagnose variants
    // After cards render, pull the real note (body + tags) for each visible result and patch it in.
    function enrichResults() {
        if (!S.useLocalRest) return;
        const cards = $(`#${ID} .om-result`);
        const query = baseQuery();
        const cap = Math.min(state.view.length, 30); // avoid hammering on huge nbResults
        for (let i = 0; i < cap; i++) {
            const item = state.view[i];
            if (!item || !item._restPort || !item._restKey) continue;
            const card = cards.eq(i);
            fetchNote({ port: item._restPort, key: item._restKey }, item.path).then((note) => {
                if (!note) return;
                if (!_restShape) { _restShape = true; console.log("[Omnisearch CMDS] Local REST note keys:", Object.keys(note), "| tags:", note.tags, "| frontmatter.tags:", (note.frontmatter || {}).tags); }
                if (note.content) card.find(".om-excerpt").html(bodyPreview(note.content, query));
                if (S.showTags) {
                    const tags = notesTags(note).slice(0, S.maxTags);
                    let box = card.find(".om-tags");
                    const html = tags.map((t) => `<span class="om-tag">${escapeHtml(t)}</span>`).join("");
                    if (tags.length) {
                        if (box.length) box.html(html);
                        else card.find(".om-excerpt").after(`<div class="om-tags">${html}</div>`);
                    } else box.remove();
                }
            });
        }
    }

    const debounce = (fn, ms) => {
        let t;
        return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
    };

    function copyText(text) {
        const done = () => toast("Copied: " + text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
        } else fallbackCopy(text, done);
    }
    function fallbackCopy(text, cb) {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); cb(); } catch (e) {}
        document.body.removeChild(ta);
    }

    let toastTimer;
    function toast(msg) {
        let el = $("#om-toast")[0];
        if (!el) {
            el = document.createElement("div");
            el.id = "om-toast";
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
    }

    // ---------- styles ----------
    const injectStyles = () => {
        const style = document.createElement("style");
        style.textContent = `
            #${ID} {
                --accent:#134538; --accent-rgb:19,69,56; --tint:#E9F0ED;
                --card:#ffffff; --card-hover:#ffffff; --text:#202124;
                --muted:#5f6368; --faint:#9aa0a6; --sel:rgba(19,69,56,0.08);
                --hdr:#44474c; --hdr-rgb:68,71,76; /* header text: neutral gray (toned-down) */
                margin:20px 0; width:100%; min-width:360px; box-sizing:border-box;
                font-family:Roboto, Arial, sans-serif;
            }
            /* ---- Theme presets (light values; dark overrides below) ---- */
            #${ID}.theme-obsidian { --accent:#1B0CAB; --accent-rgb:27,12,171; --tint:#F2F6FF; --sel:rgba(27,12,171,0.08); }
            #${ID}.theme-mono     { --accent:#3c4043; --accent-rgb:60,64,67;  --tint:#f1f3f4; --sel:rgba(60,64,67,0.08); }
            #${ID}.theme-ocean    { --accent:#0369a1; --accent-rgb:3,105,161;  --tint:#e8f1f7; --sel:rgba(3,105,161,0.08); }
            #${ID}.theme-forest   { --accent:#15803d; --accent-rgb:21,128,61;  --tint:#e9f3ec; --sel:rgba(21,128,61,0.08); }
            #${ID}.theme-sunset   { --accent:#c2410c; --accent-rgb:194,65,12;  --tint:#fbeee7; --sel:rgba(194,65,12,0.08); }
            #${ID}.theme-rose     { --accent:#be123c; --accent-rgb:190,18,60;  --tint:#fbe9ed; --sel:rgba(190,18,60,0.08); }
            #${ID}.theme-grape    { --accent:#7c3aed; --accent-rgb:124,58,237; --tint:#f1ebfb; --sel:rgba(124,58,237,0.08); }
            #${ID}.theme-slate    { --accent:#475569; --accent-rgb:71,85,105;  --tint:#eef1f5; --sel:rgba(71,85,105,0.08); }
            @media (prefers-color-scheme: dark) {
                #${ID} {
                    --accent:#E985A2; --accent-rgb:233,133,162; --tint:#2C303D;
                    --card:#353a48; --card-hover:#3d4250; --text:#e8eaed;
                    --muted:#bdc1c6; --faint:#8b9099; --sel:rgba(233,133,162,0.14);
                    --hdr:#cbd0d8; --hdr-rgb:203,208,216; /* toned-down white */
                }
                #${ID}.theme-obsidian { --accent:#b79bff; --accent-rgb:183,155,255; --tint:#2C303D; }
                #${ID}.theme-mono     { --accent:#cfd3d7; --accent-rgb:207,211,215; --tint:#2C303D; }
                #${ID}.theme-ocean    { --accent:#38bdf8; --accent-rgb:56,189,248;  --tint:#2C303D; }
                #${ID}.theme-forest   { --accent:#4ade80; --accent-rgb:74,222,128;  --tint:#2C303D; }
                #${ID}.theme-sunset   { --accent:#fb923c; --accent-rgb:251,146,60;  --tint:#2C303D; }
                #${ID}.theme-rose     { --accent:#fb7185; --accent-rgb:251,113,133; --tint:#2C303D; }
                #${ID}.theme-grape    { --accent:#c084fc; --accent-rgb:192,132,252; --tint:#2C303D; }
                #${ID}.theme-slate    { --accent:#94a3b8; --accent-rgb:148,163,184; --tint:#2C303D; }
            }

            /* Header — neutral toned-down text/icons; only the logo mark keeps the accent color */
            #${ID} .om-header {
                background:var(--tint); color:var(--hdr);
                padding:12px 16px; border-radius:16px 16px 0 0;
                display:flex; align-items:center; gap:8px;
            }
            #${ID} .om-h-title { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:600; color:var(--hdr); }
            #${ID} .om-header svg { width:18px; height:18px; }
            #${ID} .om-h-title svg .purple { fill:var(--accent); }
            #${ID} .om-count {
                font-size:12px; font-weight:600; background:rgba(var(--hdr-rgb),0.14);
                color:var(--hdr); padding:1px 8px; border-radius:999px;
            }
            #${ID} .om-h-actions { margin-left:auto; display:flex; align-items:center; gap:4px; }
            #${ID} .om-icon-btn {
                background:transparent; border:none; cursor:pointer; color:var(--hdr);
                opacity:0.55; padding:4px; border-radius:6px; font-size:13px; line-height:1;
                display:inline-flex; align-items:center; transition:opacity .15s, background .15s;
            }
            #${ID} .om-icon-btn:hover { opacity:1; background:rgba(var(--hdr-rgb),0.12); }
            #${ID} .om-icon-btn.active { opacity:1; background:rgba(var(--hdr-rgb),0.18); }

            /* Body */
            #${ID} .om-body {
                background:var(--tint); border-radius:0 0 16px 16px;
                padding:8px; box-shadow:0 4px 14px rgba(0,0,0,0.07);
            }
            #${ID}.collapsed .om-body { display:none; }
            #${ID}.collapsed .om-header { border-radius:16px; }

            /* Controls */
            #${ID} .om-controls { display:none; flex-direction:column; gap:8px; padding:4px 4px 10px; }
            #${ID} .om-controls.open { display:flex; }
            #${ID} .om-refine {
                width:100%; box-sizing:border-box; border:1px solid rgba(var(--accent-rgb),0.25);
                background:var(--card); color:var(--text); border-radius:8px;
                padding:7px 10px; font-size:13px; outline:none;
            }
            #${ID} .om-refine:focus { border-color:var(--accent); }
            #${ID} .om-ctl-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            #${ID} .om-seg { display:inline-flex; border:1px solid rgba(var(--accent-rgb),0.25); border-radius:8px; overflow:hidden; }
            #${ID} .om-seg button {
                background:var(--card); color:var(--muted); border:none; cursor:pointer;
                padding:5px 9px; font-size:12px; line-height:1;
            }
            #${ID} .om-seg button.active { background:var(--accent); color:#fff; }
            @media (prefers-color-scheme: dark) { #${ID} .om-seg button.active { color:#1B1B1B; } }
            #${ID} .om-slider { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--muted); }
            #${ID} .om-slider input[type=range] { width:96px; accent-color:var(--accent); }

            /* List + cards */
            #${ID} .om-list { display:flex; flex-direction:column; gap:8px; }
            #${ID} .om-result {
                position:relative; border-radius:10px; padding:12px 14px;
                border:1px solid transparent; border-left:3px solid var(--vc, transparent);
                background:color-mix(in srgb, var(--card) 88%, var(--vc, var(--card)) 12%);
                transition:transform .16s ease, box-shadow .16s ease, background .16s ease, border-color .16s;
            }
            #${ID} .om-result:hover {
                transform:translateY(-1px); box-shadow:0 4px 14px rgba(var(--accent-rgb),0.14);
                background:color-mix(in srgb, var(--card-hover) 82%, var(--vc, var(--card-hover)) 18%);
            }
            #${ID} .om-result.selected { border-color:var(--vc, var(--accent)); background:color-mix(in srgb, var(--vc, var(--accent)) 10%, transparent); }

            /* ---- Skins (card style). Default = Clean. ---- */
            /* Clean: solid card, keep vault-colored left border + subtle shadow (no murky tint) */
            #${ID}.skin-clean .om-result { background:var(--card); }
            #${ID}.skin-clean .om-result:hover { background:var(--card-hover); }
            /* Solid: solid card, no left border (vault color only on dot/badge) */
            #${ID}.skin-solid .om-result { background:var(--card); border-left-color:transparent; }
            #${ID}.skin-solid .om-result:hover { background:var(--card-hover); }
            /* Flat: borderless rows split by a divider, transparent body, no shadow */
            #${ID}.skin-flat .om-body { background:transparent; box-shadow:none; padding:2px 0; }
            #${ID}.skin-flat .om-header { background:transparent; border-bottom:1px solid rgba(var(--accent-rgb),0.25); border-radius:0; }
            #${ID}.skin-flat .om-content { gap:0; }
            #${ID}.skin-flat .om-result {
                background:transparent; border:none; border-left:none; border-radius:0; box-shadow:none;
                border-bottom:1px solid rgba(var(--accent-rgb),0.12); padding:11px 6px;
            }
            #${ID}.skin-flat .om-result:hover { background:color-mix(in srgb, var(--vc, var(--accent)) 8%, transparent); box-shadow:none; transform:none; }

            #${ID} .om-link { text-decoration:none; color:inherit; display:block; }

            /* --cardc = this card's accent (vault color if set, else title/accent). Drives card accents. */
            #${ID} .om-result { --cardc: var(--vc, var(--title, var(--accent))); }
            #${ID} .om-title {
                display:flex; align-items:center; gap:8px; min-width:0; color:var(--cardc);
                font-size:14px; font-weight:600; line-height:1.35; margin:0 0 5px;
            }
            /* Vault color scope. Accent (default): title/text stays readable, color only on accents.
               Full: title + highlight also take the vault color (bolder, more saturated). */
            #${ID}.vscope-accent .om-title { color:var(--title, var(--text)); } /* honors Note title color; else neutral */
            #${ID}.vscope-accent .om-excerpt mark { background:color-mix(in srgb, var(--text) 16%, transparent); }
            #${ID} .om-title-text { min-width:0; flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            #${ID} .om-title::before {
                content:""; flex:0 0 auto; width:7px; height:7px; border-radius:50%;
                background:var(--cardc); opacity:0.9;
            }
            #${ID} .om-link:hover .om-title-text { text-decoration:underline; }
            #${ID} .om-badge {
                flex:0 0 auto; font-size:10px; font-weight:700; letter-spacing:.02em;
                color:var(--cardc); border:1px solid var(--cardc);
                background:color-mix(in srgb, var(--cardc) 14%, transparent); padding:1px 7px; border-radius:999px; max-width:45%;
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            }

            #${ID} .om-score { display:flex; align-items:center; gap:6px; margin:0 0 6px; }
            #${ID} .om-bar { flex:1; height:4px; border-radius:999px; background:color-mix(in srgb, var(--cardc) 18%, transparent); overflow:hidden; }
            #${ID} .om-bar > i { display:block; height:100%; background:var(--cardc); border-radius:999px; }
            #${ID} .om-pct { font-size:10px; color:var(--faint); min-width:30px; text-align:right; }

            #${ID} .om-excerpt {
                color:var(--muted); font-size:12.5px; line-height:1.5; margin-bottom:7px;
                display:-webkit-box; -webkit-box-orient:vertical; overflow:hidden; cursor:text;
            }
            #${ID} .om-excerpt.expanded { -webkit-line-clamp:unset; display:block; }
            #${ID} .om-excerpt mark { background:color-mix(in srgb, var(--cardc) 30%, transparent); color:inherit; padding:0 1px; border-radius:2px; }

            #${ID} .om-path { color:var(--faint); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            #${ID} .om-path .om-sep { opacity:0.5; padding:0 2px; }

            #${ID} .om-terms { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 6px; }
            #${ID} .om-term {
                font-size:10px; color:var(--cardc); border:1px solid color-mix(in srgb, var(--cardc) 40%, transparent);
                padding:0 6px; border-radius:4px; line-height:1.6;
            }
            #${ID} .om-tags { display:flex; flex-wrap:wrap; gap:4px; margin:0 0 6px; }
            #${ID} .om-tag {
                font-size:10px; color:var(--cardc); background:color-mix(in srgb, var(--cardc) 13%, transparent);
                padding:1px 7px; border-radius:999px;
            }
            #${ID} .om-tag::before { content:"#"; opacity:0.5; }

            #${ID} .om-actions {
                position:absolute; top:8px; right:8px; display:flex; gap:3px;
                opacity:0; transition:opacity .15s;
            }
            #${ID} .om-result:hover .om-actions, #${ID} .om-result.selected .om-actions { opacity:1; }
            #${ID} .om-act {
                background:var(--tint); border:1px solid rgba(var(--accent-rgb),0.2); color:var(--accent);
                border-radius:6px; font-size:10px; padding:2px 6px; cursor:pointer; line-height:1.4;
            }
            #${ID} .om-act:hover { background:var(--accent); color:#fff; }
            @media (prefers-color-scheme: dark) { #${ID} .om-act:hover { color:#1B1B1B; } }

            /* States */
            #${ID} .om-loading { display:block; text-align:center; color:var(--muted); padding:22px 12px; font-size:13px; }
            #${ID} .om-error { color:#d93025; padding:16px; text-align:center; font-size:13px; line-height:1.6; }
            #${ID} .om-error a { color:var(--accent); text-decoration:none; }
            #${ID} .om-error a:hover { text-decoration:underline; }

            /* Toast */
            #om-toast {
                position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(12px);
                background:#202124; color:#fff; padding:8px 14px; border-radius:8px; font-size:13px;
                font-family:Roboto, Arial, sans-serif; box-shadow:0 4px 16px rgba(0,0,0,0.3);
                opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; z-index:99999;
                max-width:60vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
            }
            #om-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }

            @media (max-width:1200px) { #${ID} .om-header { padding:10px 14px; } }
        `;
        document.head.appendChild(style);
    };

    // ---------- config ----------
    // @ts-ignore
    const CONFIG_CSS = `
        body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0 0 64px; color:#1b1b1b; }
        #ObsidianOmnisearchGoogle_header { font-size: 17px; padding: 14px 14px 10px; position: sticky; top: 0; background:#fff; z-index: 2; border-bottom:1px solid #eee; }
        .section_header_holder { margin: 14px 10px 2px; }
        .section_header {
            background: #eef3f1; color: #134538; border: 1px solid #d4e2dc;
            font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
            text-align: left; padding: 4px 9px; border-radius: 6px;
        }
        .section_desc { font-size: 11px; color:#888; text-align:left; padding: 3px 4px 0; }
        .config_var { margin: 5px 10px; }
        .field_label { font-weight: 600; cursor: help; }
        input[type=text], input[type=number], select { padding: 3px 6px; border:1px solid #ccc; border-radius: 5px; }
        #ObsidianOmnisearchGoogle_buttons_holder {
            position: fixed; left: 0; right: 0; bottom: 0; background: #fff;
            border-top: 1px solid #ddd; box-shadow: 0 -2px 10px rgba(0,0,0,.12);
            padding: 9px 14px; text-align: right; z-index: 3;
        }
        #ObsidianOmnisearchGoogle_buttons_holder button { font-size: 13px; padding: 5px 16px; margin-left: 8px; cursor: pointer; }
        #ObsidianOmnisearchGoogle_resetLink { margin-right: auto; font-size: 12px; }
    `;

    const gmc = new GM_config({
        id: "ObsidianOmnisearchGoogle",
        title: "Omnisearch in Google — Configuration",
        css: CONFIG_CSS,
        fields: {
            // ----- Vault slots (leave Port blank to disable a slot). No paths hardcoded — fill your own. -----
            v1_port:  { section: ["Vault 1", "볼트마다 한 칸. Port를 비우면 그 슬롯은 사용 안 함."], label: "Port", type: "text", default: "51361", title: "이 볼트의 Omnisearch HTTP 포트. 비우면 슬롯 비활성." },
            v1_name:  { label: "Display name (badge)", type: "text", default: "Main", title: "결과 카드 배지에 표시할 볼트 이름 (예: Main, Wiki)." },
            v1_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "", title: "deeplink에 쓸 Obsidian 등록 볼트명. 비우면 Omnisearch가 준 값 사용." },
            v1_color: { label: "Color hex (blank = auto)", type: "text", default: "#E39AAB", title: "이 볼트의 배지/카드 색 (#RRGGBB). 비우면 이름 해시로 자동." },
            v1_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "", title: "abs 경로 복사용 절대경로 루트. 보통은 아래 '공통 부모 폴더' 하나면 충분." },
            v1_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "", title: "이 볼트 Local REST API(HTTP) 포트. body+태그 정확 표시용. General의 'Use Local REST API' 켜야 동작." },
            v1_lrKey:  { label: "Local REST API key", type: "text", default: "", title: "이 볼트 Local REST API 키(Bearer). 플러그인 설정에서 복사." },

            v2_port:  { section: ["Vault 2"], label: "Port", type: "text", default: "51362" },
            v2_name:  { label: "Display name (badge)", type: "text", default: "Wiki" },
            v2_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "" },
            v2_color: { label: "Color hex (blank = auto)", type: "text", default: "#86C2A6" },
            v2_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "" },
            v2_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "" },
            v2_lrKey:  { label: "Local REST API key", type: "text", default: "" },

            v3_port:  { section: ["Vault 3"], label: "Port", type: "text", default: "" },
            v3_name:  { label: "Display name (badge)", type: "text", default: "" },
            v3_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "" },
            v3_color: { label: "Color hex (blank = auto)", type: "text", default: "" },
            v3_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "" },
            v3_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "" },
            v3_lrKey:  { label: "Local REST API key", type: "text", default: "" },

            v4_port:  { section: ["Vault 4"], label: "Port", type: "text", default: "" },
            v4_name:  { label: "Display name (badge)", type: "text", default: "" },
            v4_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "" },
            v4_color: { label: "Color hex (blank = auto)", type: "text", default: "" },
            v4_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "" },
            v4_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "" },
            v4_lrKey:  { label: "Local REST API key", type: "text", default: "" },

            v5_port:  { section: ["Vault 5"], label: "Port", type: "text", default: "" },
            v5_name:  { label: "Display name (badge)", type: "text", default: "" },
            v5_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "" },
            v5_color: { label: "Color hex (blank = auto)", type: "text", default: "" },
            v5_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "" },
            v5_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "" },
            v5_lrKey:  { label: "Local REST API key", type: "text", default: "" },

            v6_port:  { section: ["Vault 6"], label: "Port", type: "text", default: "" },
            v6_name:  { label: "Display name (badge)", type: "text", default: "" },
            v6_vault: { label: "Obsidian vault name for deeplink (blank = auto-detect)", type: "text", default: "" },
            v6_color: { label: "Color hex (blank = auto)", type: "text", default: "" },
            v6_root:  { label: "Filesystem root for 'copy abs path' (blank = off)", type: "text", default: "" },
            v6_lrPort: { label: "Local REST API port (blank = off)", type: "text", default: "" },
            v6_lrKey:  { label: "Local REST API key", type: "text", default: "" },
            nbResults: { section: ["General settings", "공통 설정. 라벨에 마우스를 올리면 한국어 설명이 나옵니다."], label: "Results to display", type: "int", default: 5, title: "필터·정렬 후 보여줄 결과 개수." },
            excerptLines: { label: "Excerpt lines (click to expand)", type: "int", default: 3, title: "본문 미리보기 줄 수. 카드의 미리보기를 클릭하면 펼쳐짐." },
            showScore: { label: "Show relevance bar", type: "checkbox", default: true, title: "관련도(BM25) 막대와 % 표시." },
            showPath: { label: "Show path breadcrumb", type: "checkbox", default: true, title: "노트 경로를 브레드크럼으로 표시." },
            showVaultBadge: { label: "Vault badge", type: "select", options: ["auto", "always", "never"], default: "auto", title: "볼트 배지 표시: auto=2개 이상일 때 / always / never." },
            showTags: { label: "Show tags in footer", type: "checkbox", default: true, title: "카드 하단에 노트 태그 칩 표시(미리보기에서 best-effort 추출)." },
            maxTags: { label: "Max tags per card", type: "int", default: 5, title: "카드당 표시할 태그 최대 개수." },
            showMatchedTerms: { label: "Show matched query terms (noisy — usually off)", type: "checkbox", default: false, title: "매칭된 검색어 조각 표시. 한국어 조사 변형(rag를/rag가)이 섞여 지저분 — 보통 끔. 태그를 원하면 위의 'Show tags'를 쓰세요." },
            cleanFrontmatter: { label: "Strip frontmatter from preview", type: "checkbox", default: true, title: "미리보기에서 YAML(태그·작성자·날짜·wikilink 등) 제거하고 본문 위주로." },
            exactMatch: { label: "Exact match (wrap query in quotes)", type: "checkbox", default: false, title: "검색어를 따옴표로 묶어 정확 매칭." },
            excludeFolders: { label: "Exclude paths containing (comma-separated)", type: "text", default: "", title: "경로에 이 문자열이 포함된 결과 제외(콤마로 여러 개)." },
            theme: { label: "Accent theme", type: "select", options: ["Ocean", "CMDS", "Obsidian", "Mono", "Forest", "Sunset", "Rose", "Grape", "Slate"], default: "Ocean", title: "기본 색 테마(헤더·단일볼트·fallback). Ocean=블루, CMDS=그린/핑크, Obsidian=퍼플, Mono=중립, Forest=그린, Sunset=오렌지, Rose=레드핑크, Grape=보라, Slate=청회색. 라이트/다크 자동." },
            skin: { label: "Card style", type: "select", options: ["Clean", "Tinted", "Solid", "Flat"], default: "Clean", title: "카드 스타일. Clean=솔리드+볼트색 좌측보더(추천), Tinted=볼트색 은은한 틴트(예전), Solid=틴트·보더 없음, Flat=구분선만(가장 가벼움)." },
            vaultColorScope: { label: "Vault color scope", type: "select", options: ["Accent", "Full"], default: "Accent", title: "볼트색 적용 범위. Accent=포인트(닷·배지·보더·바·태그)만 색, 제목은 읽기 좋은 중립색(추천). Full=제목·하이라이트까지 볼트색(진하고 모노톤)." },
            titleColor: { label: "Note title color (hex)", type: "text", default: "#94E2D5", title: "노트 제목 글자색(#RRGGBB). Accent 스코프=모든 제목에 적용(비우면 중립), Full 스코프=볼트색 우선." },
            accentColor: { label: "Accent override (hex, blank = theme)", type: "text", default: "", title: "포인트 색 전체 덮어쓰기(#RRGGBB). 비우면 테마 사용." },
            position: { label: "Sidebar position", type: "select", options: ["Bottom", "Top"], default: "Bottom", title: "결과 위젯을 구글 사이드바 위/아래 어디에 둘지." },
            vaultsParentDir: { label: "Common parent folder of your vaults", type: "text", default: "", title: "볼트들의 공통 상위 폴더. 설정하면 abs 경로 = 부모/볼트명/상대경로 로 자동 조립." },
            useLocalRest: { label: "Use Local REST API for body + tags", type: "checkbox", default: false, title: "각 볼트의 Local REST API(HTTP)로 노트를 직접 읽어 frontmatter 제거한 본문 + 실제 태그 표시. 슬롯에 포트/키 입력 + 플러그인 설치 필요." },
            useAdvancedUri: { label: "Use Advanced URI for opening", type: "checkbox", default: false, title: "Advanced URI 플러그인으로 열기. 백그라운드 볼트의 노트도 안정적으로 열림(권장)." },
            keyboardNav: { label: "Keyboard navigation (j/k/Enter/y)", type: "checkbox", default: true, title: "결과 위에서 j/k·↑↓ 이동, Enter 열기, y 위키링크 복사." },
            showControlsDefault: { label: "Open live controls by default", type: "checkbox", default: false, title: "검색 시 라이브 필터 패널을 기본으로 펼침." },
            requestTimeout: { label: "Per-port timeout (ms)", type: "int", default: 5000, title: "각 포트(볼트) 요청 대기 시간(ms). 초과 시 그 볼트는 건너뜀." },
        },
        events: {
            save: () => location.reload(),
            init: () => {},
            // GM_config's per-field `title` isn't reliably rendered as a hover tooltip,
            // so inject the Korean tooltips onto each field row when the panel opens.
            open: (doc) => {
                const slot = {
                    port: "이 볼트의 Omnisearch HTTP 포트. 비우면 슬롯 비활성.",
                    name: "결과 카드 배지에 표시할 볼트 이름 (예: Main, Wiki).",
                    vault: "deeplink에 쓸 Obsidian 등록 볼트명. 비우면 Omnisearch가 준 값 사용.",
                    color: "이 볼트의 배지/카드 색 (#RRGGBB). 비우면 이름 해시로 자동.",
                    root: "abs 경로 복사용 절대경로 루트. 보통은 General의 '공통 부모 폴더' 하나면 충분.",
                    lrPort: "이 볼트 Local REST API(HTTP) 포트. 본문+태그 정확 표시용. General의 'Use Local REST API' 켜야 동작.",
                    lrKey: "이 볼트 Local REST API 키(Bearer). 플러그인 설정에서 복사.",
                };
                const gen = {
                    nbResults: "필터·정렬 후 보여줄 결과 개수.",
                    excerptLines: "본문 미리보기 줄 수. 미리보기를 클릭하면 펼쳐짐.",
                    showScore: "관련도(BM25) 막대와 % 표시.",
                    showPath: "노트 경로를 브레드크럼으로 표시.",
                    showVaultBadge: "볼트 배지: auto(2개 이상일 때) / always / never.",
                    showTags: "카드 하단에 노트 태그 칩 표시(미리보기에서 best-effort 추출).",
                    maxTags: "카드당 표시할 태그 최대 개수.",
                    showMatchedTerms: "매칭 검색어 조각 표시. 조사 변형(rag를/rag**)이 섞여 지저분 — 보통 끔. 태그는 'Show tags'를 쓰세요.",
                    cleanFrontmatter: "미리보기에서 YAML(태그·작성자·날짜·wikilink 등) 제거하고 본문 위주로.",
                    exactMatch: "검색어를 따옴표로 묶어 정확 매칭.",
                    excludeFolders: "경로에 이 문자열이 포함된 결과 제외(콤마로 여러 개).",
                    theme: "기본 색 테마(헤더·단일볼트·fallback). CMDS/Obsidian/Mono/Ocean/Forest/Sunset/Rose/Grape/Slate. 라이트/다크 자동 전환.",
                    skin: "카드 스타일. Clean=솔리드+좌측보더(추천), Tinted=볼트색 틴트(예전), Solid=틴트·보더 없음, Flat=구분선만.",
                    vaultColorScope: "볼트색 적용 범위. Accent=포인트만 색·제목은 중립(추천), Full=제목·하이라이트까지 볼트색(진함).",
                    titleColor: "노트 제목 글자색 (#RRGGBB).",
                    accentColor: "포인트 색 전체 덮어쓰기 (#RRGGBB). 비우면 테마 사용.",
                    position: "결과 위젯을 구글 사이드바 위/아래 어디에 둘지.",
                    vaultsParentDir: "볼트들의 공통 상위 폴더. 설정하면 abs 경로 = 부모/볼트명/상대경로 로 자동 조립.",
                    useLocalRest: "각 볼트 Local REST API(HTTP)로 노트를 직접 읽어 본문+실제 태그 표시. 슬롯에 포트/키 입력 + 플러그인 필요.",
                    useAdvancedUri: "Advanced URI 플러그인으로 열기. 백그라운드 볼트의 노트도 안정적으로 열림(권장).",
                    keyboardNav: "결과 위에서 j/k·↑↓ 이동, Enter 열기, y 위키링크 복사.",
                    showControlsDefault: "검색 시 라이브 필터 패널을 기본으로 펼침.",
                    requestTimeout: "각 포트(볼트) 요청 대기 시간(ms). 초과 시 그 볼트는 건너뜀.",
                };
                const setTip = (key, text) => {
                    const el = doc.getElementById("ObsidianOmnisearchGoogle_" + key + "_var");
                    if (el) { el.title = text; el.style.cursor = "help"; }
                };
                for (let i = 1; i <= 6; i++) for (const f in slot) setTip("v" + i + "_" + f, slot[f]);
                for (const k in gen) setTip(k, gen[k]);
            },
        },
    });

    const onInit = (config) =>
        new Promise((resolve) => {
            const tick = () => setTimeout(() => (config.isInit ? resolve() : tick()), 0);
            tick();
        });

    function loadSettings() {
        // Build vault configs from the split slot fields (no hardcoded paths — all user-supplied).
        S.vaults = [];
        S.vaultRoots = {};
        for (let i = 1; i <= 6; i++) {
            const port = String(gmc.get("v" + i + "_port") || "").trim();
            if (!/^\d+$/.test(port)) continue;
            const label = String(gmc.get("v" + i + "_name") || "").trim();
            const dvault = String(gmc.get("v" + i + "_vault") || "").trim();
            const color = String(gmc.get("v" + i + "_color") || "").trim();
            const root = String(gmc.get("v" + i + "_root") || "").trim();
            const lrPort = String(gmc.get("v" + i + "_lrPort") || "").trim();
            const lrKey = String(gmc.get("v" + i + "_lrKey") || "").trim();
            S.vaults.push({ port, label, color, dvault, lrPort, lrKey });
            if (root) {
                if (label) S.vaultRoots[label] = root;
                if (dvault) S.vaultRoots[dvault] = root;
            }
        }
        S.nbResults = Math.max(1, parseInt(gmc.get("nbResults"), 10) || 5);
        S.excerptLines = Math.max(1, parseInt(gmc.get("excerptLines"), 10) || 3);
        S.showScore = !!gmc.get("showScore");
        S.showPath = !!gmc.get("showPath");
        S.showVaultBadge = gmc.get("showVaultBadge");
        S.showTags = !!gmc.get("showTags");
        S.maxTags = Math.max(1, parseInt(gmc.get("maxTags"), 10) || 5);
        S.showMatchedTerms = !!gmc.get("showMatchedTerms");
        S.titleColor = gmc.get("titleColor");
        S.accentColor = gmc.get("accentColor");
        S.cleanFrontmatter = !!gmc.get("cleanFrontmatter");
        S.exactMatch = !!gmc.get("exactMatch");
        S.excludeFolders = String(gmc.get("excludeFolders") || "")
            .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        S.theme = gmc.get("theme");
        S.skin = gmc.get("skin");
        S.vaultColorScope = gmc.get("vaultColorScope");
        S.position = gmc.get("position");
        S.vaultsParentDir = String(gmc.get("vaultsParentDir") || "").trim();
        S.useLocalRest = !!gmc.get("useLocalRest");
        S.useAdvancedUri = !!gmc.get("useAdvancedUri");
        S.keyboardNav = !!gmc.get("keyboardNav");
        S.showControlsDefault = !!gmc.get("showControlsDefault");
        S.requestTimeout = Math.max(500, parseInt(gmc.get("requestTimeout"), 10) || 5000);
    }

    const logo = `<svg height="1em" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 256 256">
<path class="purple" d="M94.82 149.44c6.53-1.94 17.13-4.9 29.26-5.71a102.97 102.97 0 0 1-7.64-48.84c1.63-16.51 7.54-30.38 13.25-42.1l3.47-7.14 4.48-9.18c2.35-5 4.08-9.38 4.9-13.56.81-4.07.81-7.64-.2-11.11-1.03-3.47-3.07-7.14-7.15-11.21a17.02 17.02 0 0 0-15.8 3.77l-52.81 47.5a17.12 17.12 0 0 0-5.5 10.2l-4.5 30.18a149.26 149.26 0 0 1 38.24 57.2ZM54.45 106l-1.02 3.06-27.94 62.2a17.33 17.33 0 0 0 3.27 18.96l43.94 45.16a88.7 88.7 0 0 0 8.97-88.5A139.47 139.47 0 0 0 54.45 106Z"/><path class="purple" d="m82.9 240.79 2.34.2c8.26.2 22.33 1.02 33.64 3.06 9.28 1.73 27.73 6.83 42.82 11.21 11.52 3.47 23.45-5.8 25.08-17.73 1.23-8.67 3.57-18.46 7.75-27.53a94.81 94.81 0 0 0-25.9-40.99 56.48 56.48 0 0 0-29.56-13.35 96.55 96.55 0 0 0-40.99 4.79 98.89 98.89 0 0 1-15.29 80.34h.1Z"/><path class="purple" d="M201.87 197.76a574.87 574.87 0 0 0 19.78-31.6 8.67 8.67 0 0 0-.61-9.48 185.58 185.58 0 0 1-21.82-35.9c-5.91-14.16-6.73-36.08-6.83-46.69 0-4.07-1.22-8.05-3.77-11.21l-34.16-43.33c0 1.94-.4 3.87-.81 5.81a76.42 76.42 0 0 1-5.71 15.9l-4.7 9.8-3.36 6.72a111.95 111.95 0 0 0-12.03 38.23 93.9 93.9 0 0 0 8.67 47.92 67.9 67.9 0 0 1 39.56 16.52 99.4 99.4 0 0 1 25.8 37.31Z"/></svg>`;

    // ---------- networking ----------
    function baseQuery() {
        if (state.refine.trim()) return state.refine.trim();
        const q = new URLSearchParams(window.location.search).get("q") || "";
        return q;
    }
    function effectiveQuery() {
        let q = baseQuery();
        if (S.exactMatch && q && !/^".*"$/.test(q)) q = `"${q}"`;
        return q;
    }

    function fetchPort(port, query) {
        return new Promise((resolve) => {
            GM.xmlHttpRequest({
                method: "GET",
                url: `http://localhost:${encodeURIComponent(port)}/search?q=${encodeURIComponent(query)}`,
                headers: { "Content-Type": "application/json" },
                timeout: S.requestTimeout,
                onload: (res) => {
                    try {
                        const d = JSON.parse(res.response);
                        resolve(Array.isArray(d) ? d : []);
                    } catch (e) { resolve([]); }
                },
                onerror: () => resolve(null),   // null = port unreachable (vault closed)
                ontimeout: () => resolve(null),
            });
        });
    }

    function runSearch() {
        const query = effectiveQuery();
        if (!query) return;
        showLoading();
        const ports = parsePorts();
        Promise.all(ports.map((p) => fetchPort(p.port, query))).then((responses) => {
            if (responses.every((r) => r === null)) {
                showError(
                    "No Omnisearch server reachable on port(s) " + escapeHtml(ports.map((p) => p.port).join(", ")) + ".<br />" +
                    "Open the vault(s) in Obsidian with the Omnisearch HTTP server enabled.<br />" +
                    '<a href="obsidian://open">Open Obsidian</a>'
                );
                return;
            }
            // merge + dedupe by vault|path, tagging each item with its port's display label
            const seen = new Set();
            const merged = [];
            responses.forEach((arr, i) => {
                if (arr === null) return;
                const cfg = ports[i];
                if (arr[0]) console.log(`[Omnisearch CMDS] port ${cfg.port} → vault "${arr[0].vault}" (deeplink uses "${cfg.dvault || arr[0].vault}")`);
                for (const it of arr) {
                    const key = (it.vault || "") + "|" + (it.path || "");
                    if (seen.has(key)) continue;
                    seen.add(key);
                    it._label = cfg.label;     // display name (may be "")
                    it._color = cfg.color;     // per-vault color (may be "")
                    it._dvault = cfg.dvault;   // deeplink vault override (may be "")
                    it._restPort = cfg.lrPort; // Local REST API port (may be "")
                    it._restKey = cfg.lrKey;   // Local REST API key (may be "")
                    merged.push(it);
                }
            });
            state.raw = merged;
            state.vaultsSeen = new Set(merged.map((r) => r._label || r.vault)).size;
            applyPipeline();
            renderResults();
        });
    }

    // ---------- pipeline ----------
    function applyPipeline() {
        let v = state.raw.slice();
        if (S.excludeFolders.length) {
            v = v.filter((r) => !S.excludeFolders.some((f) => String(r.path || "").toLowerCase().includes(f)));
        }
        if (state.type !== "all") v = v.filter((r) => matchType(r.path, state.type));

        state.topScore = Math.max(1, ...state.raw.map((r) => Number(r.score) || 0));
        if (state.minRel > 0) {
            const cut = state.topScore * (state.minRel / 100);
            v = v.filter((r) => (Number(r.score) || 0) >= cut);
        }

        if (state.sort === "name") {
            v.sort((a, b) => String(a.basename).localeCompare(String(b.basename)));
        } else if (state.sort === "vault") {
            v.sort((a, b) => String(a.vault).localeCompare(String(b.vault)) || (b.score - a.score));
        } else {
            v.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
        }
        state.view = v.slice(0, S.nbResults);
        state.selected = -1;
    }

    // ---------- rendering ----------
    function $body() { return $(`#${ID} .om-body`); }

    function buildShell() {
        const showBadgePref = S.showVaultBadge;
        const container = $(`
            <div id="${ID}" class="theme-${S.theme.toLowerCase()} skin-${(S.skin || "Clean").toLowerCase()} vscope-${(S.vaultColorScope || "Accent").toLowerCase()}">
                <div class="om-header">
                    <span class="om-h-title">${logo}<span>Omnisearch by CMDS</span></span>
                    <span class="om-count" style="display:none">0</span>
                    <span class="om-h-actions">
                        <button class="om-icon-btn om-toggle-controls" title="Filters">⚙</button>
                        <button class="om-icon-btn om-refresh" title="Refresh">⟳</button>
                        <button class="om-icon-btn om-collapse" title="Collapse">▾</button>
                        <button class="om-icon-btn om-settings" title="Settings">⋯</button>
                    </span>
                </div>
                <div class="om-body">
                    <div class="om-controls">
                        <input class="om-refine" type="text" placeholder="Refine within Obsidian…" />
                        <div class="om-ctl-row">
                            <span class="om-seg om-sort">
                                <button data-v="score" class="active">Relevance</button>
                                <button data-v="name">A–Z</button>
                                <button data-v="vault">Vault</button>
                            </span>
                        </div>
                        <div class="om-ctl-row">
                            <span class="om-seg om-type">
                                <button data-v="all" class="active">All</button>
                                <button data-v="md">md</button>
                                <button data-v="pdf">pdf</button>
                                <button data-v="img">img</button>
                            </span>
                            <label class="om-slider">min rel
                                <input type="range" min="0" max="100" step="1" value="0" class="om-minrel" />
                                <span class="om-minrel-val">0%</span>
                            </label>
                        </div>
                    </div>
                    <div class="om-list"></div>
                </div>
            </div>
        `);

        if (S.position === "Top") $(sidebarSelector).prepend(container);
        else $(sidebarSelector).append(container);

        // restore state
        if (state.collapsed) $(`#${ID}`).addClass("collapsed");
        if (state.controlsOpen || S.showControlsDefault) {
            $(`#${ID} .om-controls`).addClass("open");
            $(`#${ID} .om-toggle-controls`).addClass("active");
            state.controlsOpen = true;
        }
        $(`#${ID} .om-sort button[data-v="${state.sort}"]`).addClass("active").siblings().removeClass("active");
        $(`#${ID} .om-type button[data-v="${state.type}"]`).addClass("active").siblings().removeClass("active");
        $(`#${ID} .om-minrel`).val(state.minRel);
        $(`#${ID} .om-minrel-val`).text(state.minRel + "%");
        $(`#${ID} .om-refine`).val(state.refine);

        bindShellEvents();
    }

    function bindShellEvents() {
        $(document).on("click", `#${ID} .om-settings`, (e) => { e.preventDefault(); gmc.open(); });

        $(document).on("click", `#${ID} .om-toggle-controls`, function () {
            state.controlsOpen = !state.controlsOpen;
            $(`#${ID} .om-controls`).toggleClass("open", state.controlsOpen);
            $(this).toggleClass("active", state.controlsOpen);
        });

        $(document).on("click", `#${ID} .om-refresh`, () => runSearch());

        $(document).on("click", `#${ID} .om-collapse`, function () {
            state.collapsed = !state.collapsed;
            $(`#${ID}`).toggleClass("collapsed", state.collapsed);
            $(this).text(state.collapsed ? "▸" : "▾");
            setVal("om_collapsed", state.collapsed);
        });

        $(document).on("click", `#${ID} .om-sort button`, function () {
            state.sort = $(this).data("v");
            $(this).addClass("active").siblings().removeClass("active");
            setVal("om_sort", state.sort);
            applyPipeline(); renderResults();
        });

        $(document).on("click", `#${ID} .om-type button`, function () {
            state.type = $(this).data("v");
            $(this).addClass("active").siblings().removeClass("active");
            setVal("om_type", state.type);
            applyPipeline(); renderResults();
        });

        $(document).on("input", `#${ID} .om-minrel`, function () {
            state.minRel = parseInt(this.value, 10) || 0;
            $(`#${ID} .om-minrel-val`).text(state.minRel + "%");
            setVal("om_minRel", state.minRel);
            applyPipeline(); renderResults();
        });

        const onRefine = debounce(() => {
            state.refine = $(`#${ID} .om-refine`).val();
            runSearch();
        }, 280);
        $(document).on("input", `#${ID} .om-refine`, onRefine);

        // open the note: Local REST (reliable) → else obsidian:// deeplink. Allow modified/middle clicks.
        $(document).on("click", `#${ID} .om-link`, function (e) {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            openItem(state.view[$(this).closest(".om-result").index()]);
        });

        // expand excerpt on click (don't trigger the open handler)
        $(document).on("click", `#${ID} .om-excerpt`, function (e) {
            e.preventDefault(); e.stopPropagation();
            $(this).toggleClass("expanded");
        });

        // per-result copy actions
        $(document).on("click", `#${ID} .om-act`, function (e) {
            e.preventDefault(); e.stopPropagation();
            const card = $(this).closest(".om-result");
            const item = state.view[card.index()];
            if (!item) return;
            const a = $(this).data("a");
            if (a === "name") copyText(item.basename);
            else if (a === "rel") copyText(item.path);
            else if (a === "abs") {
                const abs = absPath(item);
                if (abs) copyText(abs);
                else toast("No vault root set for \"" + (item._label || item.vault) + "\" (Settings → vaultRoots)");
            }
        });
    }

    function showLoading() {
        const list = $(`#${ID} .om-list`);
        if (!list.find(".om-loading")[0]) {
            list.html(`<span class="om-loading">Searching Obsidian…</span>`);
        }
    }
    function showError(html) {
        $(`#${ID} .om-list`).html(`<div class="om-error">${html}</div>`);
        setCount(null);
    }
    function setCount(n) {
        const el = $(`#${ID} .om-count`);
        if (n === null || n === undefined) el.hide();
        else el.text(String(n)).show();
    }

    function renderResults() {
        const list = $(`#${ID} .om-list`);
        list.empty();
        setCount(state.view.length);

        if (state.view.length === 0) {
            list.html(`<span class="om-loading">No results in Obsidian</span>`);
            return;
        }

        const multiVault = state.vaultsSeen > 1;
        const showBadge = S.showVaultBadge === "always" || (S.showVaultBadge === "auto" && multiVault);

        state.view.forEach((item, i) => {
            const url = openUrl(item);
            const pct = Math.round(((Number(item.score) || 0) / state.topScore) * 100);
            const vaultName = item._label || item.vault;
            const vc = vaultColor(item);
            const colorize = showBadge || validHex(item._color);
            const badge = showBadge ? `<span class="om-badge">${escapeHtml(vaultName)}</span>` : "";
            const scoreHtml = S.showScore
                ? `<div class="om-score"><span class="om-bar"><i style="width:${pct}%"></i></span><span class="om-pct">${pct}%</span></div>`
                : "";

            let termsHtml = "";
            if (S.showMatchedTerms && Array.isArray(item.foundWords) && item.foundWords.length) {
                termsHtml = `<div class="om-terms">` +
                    item.foundWords.slice(0, 8).map((w) => `<span class="om-term">${escapeHtml(w)}</span>`).join("") +
                    `</div>`;
            }
            let tagsHtml = "";
            if (S.showTags) {
                const tags = extractTags(item.excerpt);
                if (tags.length) {
                    tagsHtml = `<div class="om-tags">` +
                        tags.map((t) => `<span class="om-tag">${escapeHtml(t)}</span>`).join("") +
                        `</div>`;
                }
            }
            const pathHtml = S.showPath ? `<div class="om-path">${breadcrumb(item.path)}</div>` : "";
            const vcStyle = colorize ? ` style="--vc:${escapeHtml(vc)}"` : "";
            const card = $(`
                <div class="om-result"${vcStyle}>
                    <div class="om-actions">
                        <button class="om-act" data-a="name" title="Copy note name">name</button>
                        <button class="om-act" data-a="rel" title="Copy vault-relative path">rel</button>
                        <button class="om-act" data-a="abs" title="Copy absolute filesystem path">abs</button>
                    </div>
                    <a class="om-link" href="${escapeHtml(url)}">
                        <h3 class="om-title"><span class="om-title-text">${escapeHtml(item.basename)}</span>${badge}</h3>
                        ${scoreHtml}
                        <div class="om-excerpt" style="-webkit-line-clamp:${S.excerptLines}">${cleanExcerpt(item.excerpt)}</div>
                        ${termsHtml}
                        ${tagsHtml}
                        ${pathHtml}
                    </a>
                </div>
            `);
            list.append(card);
        });

        enrichResults(); // Local REST API: swap in real body + tags (no-op unless enabled)
    }

    // ---------- keyboard ----------
    function isTyping(e) {
        const t = e.target;
        return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
    }
    function setSelected(i) {
        const cards = $(`#${ID} .om-result`);
        if (!cards.length) return;
        state.selected = Math.max(0, Math.min(cards.length - 1, i));
        cards.removeClass("selected");
        const el = cards.eq(state.selected).addClass("selected")[0];
        if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    function bindKeyboard() {
        if (!S.keyboardNav) return;
        document.addEventListener("keydown", (e) => {
            if (isTyping(e) || state.collapsed) return;
            if (!state.view.length) return;
            if (e.key === "j" || e.key === "ArrowDown") {
                e.preventDefault(); setSelected(state.selected < 0 ? 0 : state.selected + 1);
            } else if (e.key === "k" || e.key === "ArrowUp") {
                e.preventDefault(); setSelected(state.selected < 0 ? 0 : state.selected - 1);
            } else if (e.key === "Enter" && state.selected >= 0) {
                openItem(state.view[state.selected]);
            } else if (e.key === "y" && state.selected >= 0) {
                const item = state.view[state.selected];
                if (item) copyText(`[[${item.basename}]]`);
            } else if (e.key === "Escape" && state.selected >= 0) {
                state.selected = -1; $(`#${ID} .om-result`).removeClass("selected");
            }
        });
    }

    // ---------- boot ----------
    console.log("Loading Omnisearch injector CMDS v0.13.3");

    onInit(gmc).then(async () => {
        loadSettings();
        state.collapsed = await getVal("om_collapsed", false);
        state.sort = await getVal("om_sort", "score");
        state.minRel = await getVal("om_minRel", 0);
        state.type = await getVal("om_type", "all");

        injectStyles();
        if (!$(sidebarSelector)[0]) {
            $("#rcnt").append('<div id="rhs" style="min-width: 400px; flex-shrink: 0;"></div>');
        }
        buildShell();
        applyCustomColors();
        bindKeyboard();
        runSearch();

        console.log("Loaded Omnisearch injector CMDS v0.13.3");

        // keep widget pinned to chosen edge if Google injects more cards
        waitForKeyElements(sidebarSelector, () => {
            const w = $(`#${ID}`);
            if (S.position === "Top") { if (w.prev().length > 0) w.prependTo(sidebarSelector); }
            else { if (w.next().length > 0) w.appendTo(sidebarSelector); }
        });
    });
})();
