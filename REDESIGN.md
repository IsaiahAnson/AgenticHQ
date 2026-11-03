# REDESIGN.md - make it look like yours

This OS has been reskinned end to end more than once without touching a single feature. Same bones, very different skin. The current skin is **Agentic HQ** (navy glass, 2026-11-01): the homepage in `os.html` is the visual reference, and the Second Brain follows it.

## The current skin

The Second Brain reads the shared tokens in `assets/hq-tokens.css`: navy `#060d22`, ink `#d5ddff`, bright `#eef1ff`, dim `#7d88b3`, faint `#717aa7`, violet `#a37cff`, blue `#7fa6ff`, cyan `#7ff0ff`, amber `#ffae42`, red `#ff5a4a`, green `#4fd58a`, glass `rgba(8,11,28,.64)`. Glass surfaces, fine blue borders, and the Segoe UI / Cascadia Mono stacks complete it. Violet is the accent (selection, the active tab); cyan marks "now" and focus; amber is for warnings only.

## Where the look lives

1. **The homepage tokens:** the AGENTIC HQ SKIN block, last in `os.html`'s `<style>` (`--hq-*`, the same values as `assets/hq-tokens.css`). Change them there and in `assets/hq-tokens.css` together.
2. **The homepage's JS THEME block,** just above `const ICS` in `os.html`. Canvas drawings (clock hands, sprites, the ring) cannot read CSS variables, so they take their colours here:
   ```js
   const THEME = { accent:'#a37cff', cream:'#d5ddff', mute:'#717aa7', warm:'#7d88b3' };
   ```
   Keep it in step with the CSS tokens.
3. **The Second Brain's skin:** the shell is `copy.css` and `index.html`; the Brain is the `skin` object in `brain/index.html` (`themes.dark.css` holds the panel colours) plus `brain/minimal.css`, `brain/port.css`, `brain/_core.css`, and the canvas colours in `brain/_core.js`, `brain/port.js` and `brain/timeline-layout.js`. The Routines, Skills and Applications tabs are `views/views.css`, `views/usage-board.css`, `views/views.js`, `views/usage-board.js`, `views/calendar-board.js` and `views/hex-bg.js`. `assets/hex-cursor.css` carries the matching cursor set.
4. **Orb colours are data, not theme:** `config/departments.json` and the `layerColors` / `deptColors` lines in `brain/index.html` colour the departments and layers (the gold Routines layer included), and `refresh/brain.mjs` parses those lines for the homepage orb. Don't restyle them in a reskin; after changing them on purpose, press the refresh icon so the homepage orb's centre matches.
5. **Stragglers:** a few inline SVG strings and canvas fallbacks keep fixed colours. After a reskin, search the files for the old accent's hex value.
6. **Fonts:** Outfit and Doto ship as local files in `assets/` (`@font-face` at the top of `os.html` and `copy.css`); the Second Brain's skin uses the system stacks `--hq-font` and `--hq-mono`. Swap the files and the names to change the personality faster than any colour.

## The redesign prompt (paste to your agent)

> Redesign my Agentic OS into a completely new visual direction while changing ZERO functionality. The homepage is os.html; the Second Brain's look is assets/hq-tokens.css, copy.css, the skin in brain/index.html and the views/ CSS files.
>
> First, quietly consider three candidate directions that have nothing in common with the current look or with each other: different palette temperature, different type personality, different texture (flat, glass, paper, terminal). Pick the strongest, then commit fully.
>
> Rules: work through the tokens and the THEME block first, then the Second Brain's skin, then the fonts, then any stragglers. Do not touch layout logic, APIs, widget behaviour, ids, storage keys or the orb's department and layer colours. Every widget must stay readable at its current size; check the contrast of muted text especially. When done, open the OS headless, check the console for errors, screenshot the homepage and every Second Brain tab, and look at the screenshots before you say it is done. Then tell me the direction you chose in one line.

Ask for "three options as screenshots first" if you want to pick the direction yourself.

## Principles that survived our reskins

- **Direction beats decoration.** One committed direction (terminal, editorial, botanical, brutalist, navy glass) reads at once; a palette swap alone reads as the same OS in a different shirt.
- **The accent is a budget.** One accent colour, spent on the few things that matter (the next routine, the running skill, the selected thing). Spend it everywhere and the board gets noisy.
- **Muted text carries the design.** Most of the OS is labels. If the dim text fails contrast on the background, everything feels broken however pretty the accent is.
- **Type first, then colour.** The display font sets the personality; colours season it.
- **Keep the bones.** The layout grid, widget chrome, ring and brain took many rounds to feel right. Reskin, do not re-architect, and you keep getting upstream improvements.
