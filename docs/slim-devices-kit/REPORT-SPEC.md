# Report specification: `device-setup-report.html`

Write one self-contained HTML file in the project root. It must meet all of these:

- no external stylesheets, fonts, scripts or images;
- no network requests;
- readable when opened from disk, and printable;
- light and dark mode, through `prefers-color-scheme`;
- readable at phone width: wide tables scroll inside their own container;
- every value from the project or host HTML-escaped;
- no secret values: see AGENT.md §0.3.

A tiny inline script is allowed only for a "copy" button on code blocks. A report without any script is preferred.

## Sections, in this order

| # | id | Title | Content |
|---|---|---|---|
| 1 | `summary` | Summary | Project name, date, host OS. **Verdict** sentence (`CHECKS.md` §Verdict). Tiles: count per severity, estimated devices per host, platforms in scope. Top 5 findings by severity. A short paragraph saying what was and was not checked. |
| 2 | `project` | Project understanding | Framework/language, platforms, where capabilities are defined (`file:line`), how devices are selected, how the app is installed, reset strategy, parallelism, what CI runs. 6–10 lines. |
| 3 | `answers` | Answers | Table: question, answer, source (answered / inferred: evidence / default). |
| 4 | `good` | What is already good | Bullets for checks that clearly passed, with evidence. |
| 5 | `host` | Host and tools | Tiles: CPUs, RAM, free disk, acceleration. Table: tool, version, location (or "not installed"). Table: Appium drivers (name, version, global/project, required Appium/Node, satisfied?). |
| 6 | `android` | Android (when in scope) | SDK path and versions. AVD table: name, API, tag, ABI, RAM, cores, GPU, Quick Boot, named snapshots, cold forced, disk. Running devices table: serial, OS/API, model, animations, enabled/disabled packages, GMS, Appium helpers, free memory. Installed system images (collapsible `<details>`). |
| 7 | `ios` | iOS and WebDriverAgent (when in scope) | Xcode version/path, runtimes, simulator counts (total/booted/unavailable), booted simulators with service counts, WDA source version, prebuilt WDA builds with dates and staleness. If not macOS: a note saying what to re-run where. |
| 8 | `prewarm` | Pre-warm and warm-up analysis | Narrative per platform. **Today:** what happens from "no device" to "first test command", stage by stage, with times if measured or "not measured". **Target:** the same stages after P1–P2. A stage table: stage, today, target, lever, finding id. |
| 9 | `caps` | Capabilities | Table: capability, value (redacted when credential-like), where (`file:line`), assessment (ok / change / review). Only keys from `knowledge/capabilities.md`, plus `platformName`/`automationName`/`app`. |
| 10 | `deps` | Dependencies and offline readiness | The sourcing table from `knowledge/dependencies-offline.md` §2, filled in with OK/Gap/Unknown. Then: mobile-relevant packages with version specs, repository-URL dependencies, runtime GitHub fetches, remote-script-to-shell, lockfiles present, registry config files present (names only). |
| 11 | `ci` | CI and scripts | CI files, runner OS, whether device tests run in CI, caching, device boot/prepare commands found (`file:line`). |
| 12 | `findings` | Findings | One card per finding, sorted high, medium, low, info, then by phase. Card: severity badge, title, `area · ID · phase`, **Evidence**, **Do** (project-specific), **Risk**. |
| 13 | `plan` | Action plan | One card per phase P0–P5: goal, numbered items (finding id, change, file, command/config, verify, rollback), **Done when**. P0 always lists the baseline measurements. Phases with nothing triggered say so in one line. |
| 14 | `solutions` | Tailored solutions | Cards: title, why (1–2 lines), code block with the project's real names, paths, worker count and framework syntax. At least: Android warm snapshot (if Android), WDA build and reuse (if iOS), golden simulator and clones (if iOS), capabilities in the project's syntax, CI cache (if CI runs devices), offline sourcing. |
| 15 | `risks` | Risks | The applicable rows of `knowledge/risks.md` §1, each with a line on why it applies here. |
| 16 | `appendix` | Appendix | Read-only commands run (list, no outputs); things not checked and why; kit version/date; how to re-run. |

A sticky or top navigation links to every section id.

## Style tokens and base CSS (copy as is, then add only what you need)

```css
:root{--bg:#fbfaf8;--fg:#1d1d1b;--muted:#6b6862;--card:#ffffff;--line:#e4e1db;--accent:#2f5d8a;
--high:#b3261e;--medium:#9a5b00;--low:#2e6b3a;--info:#4a5568;--code:#f3f1ec}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe8;--muted:#a5a29b;--card:#1f1f1d;--line:#33322f;
--accent:#8ab4e0;--high:#f28b82;--medium:#f0b45c;--low:#86c99a;--info:#b8c0cc;--code:#262624;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:28px;margin:0 0 4px}
h2{font-size:20px;margin:40px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:20px 0 8px}
.muted{color:var(--muted)}
nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:16px 0 0;font-size:14px}
nav a{color:var(--accent);text-decoration:none}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.tile b{display:block;font-size:24px}
.sev{display:inline-block;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;
padding:1px 8px;border-radius:99px;border:1px solid currentColor}
.sev.high{color:var(--high)}.sev.medium{color:var(--medium)}.sev.low{color:var(--low)}.sev.info{color:var(--info)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted)} tr:last-child td{border-bottom:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.card h3{margin:0 0 6px}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;white-space:pre}
details summary{cursor:pointer;color:var(--accent)}
@media print{nav{display:none}.card{break-inside:avoid}h2{break-after:avoid}}
```

Severity is shown by the badge text as well as its colour. Never rely on colour alone.

## Skeleton

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device setup analysis: PROJECT</title><style>/* base CSS above */</style></head>
<body><main>
<h1>Device setup analysis: PROJECT</h1>
<p class="muted">Generated DATE on HOST-OS. Read-only analysis; nothing was changed. No network calls were made.</p>
<nav><a href="#summary">Summary</a> <a href="#project">Project</a> … <a href="#appendix">Appendix</a></nav>

<h2 id="summary">Summary</h2>
<div class="card"><h3>Verdict</h3><p>VERDICT SENTENCE</p></div>
<div class="grid">
  <div class="tile"><span class="sev high">high</span><b>2</b>findings</div>
  <div class="tile"><span class="sev medium">medium</span><b>3</b>findings</div>
  <div class="tile"><span class="sev low">low</span><b>4</b>findings</div>
  <div class="tile"><span class="sev info">info</span><b>1</b>findings</div>
  <div class="tile"><span class="muted">Est. devices / host</span><b>4</b>RAM allows 5, CPU 4 (confirm in P0)</div>
</div>

<h2 id="findings">Findings (10)</h2>
<div class="card">
  <h3><span class="sev high">high</span> Sessions do not reuse a prebuilt WebDriverAgent</h3>
  <p class="muted">wda · CAP-WDA · phase P1</p>
  <p><b>Evidence:</b> <code>config/capabilities.ts:71</code> builds iOS capabilities with none of usePrebuiltWDA / …</p>
  <p><b>Do:</b> add <code>'appium:usePrebuiltWDA': true</code> and <code>'appium:derivedDataPath'</code> …</p>
  <p><b>Risk:</b> Low: configuration only, reversible.</p>
</div>

<h2 id="plan">Action plan</h2>
<div class="card"><h3>P0 · Baseline and unblock</h3>
  <ol><li>…</li></ol><p><b>Done when:</b> …</p></div>

<h2 id="solutions">Tailored solutions</h2>
<div class="card"><h3>Android: warm snapshot for Pixel_6_API_34</h3><p>Why …</p><pre>commands with real names</pre></div>
</main></body></html>
```

## Quality bar

Before handing the report over, check each point:

- [ ] **Project-specific:** every "Do" and every code block uses the project's real file paths, AVD names, runtimes, ports and framework syntax where known. Placeholders appear only where the value is unknown, marked `<like-this>`.
- [ ] **Facts traced:** every number or fact cites its source (command, `file:line`, or answer).
- [ ] **Honest about gaps:** unverified items say "not checked" with the reason (wrong OS, tool missing, user declined a measurement).
- [ ] **Lean:** no raw command output pasted, beyond short extracted values.
- [ ] **Offline links only:** the file contains no `http(s)://` except as plain text naming a blocked URL inside a finding, or loopback addresses (`127.0.0.1`) in config snippets.
