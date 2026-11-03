# Themes

A theme is a folder under `themes/` with:

| File | Purpose |
|---|---|
| `theme.json` | Name, colors, fonts, which partials exist |
| `layout.html` | The page frame |
| `post.html` | One post |
| `index.html` | The post list |
| `tag.html` | Posts for one tag |
| `partials/*.html` | Header, footer, anything shared |
| `style.css` | The only stylesheet |

Templates use `{{ name }}` for values and `{{#each posts}}` for lists. Nothing else.

## Shipped themes

- **plain**: the default, black on white.
- **margin**: wide margins and sidenotes.
- **dusk** (new in 0.9): dark, for long reading. See the [theme review](../../../notes/meetings/2026-10-14-paper-lantern-theme-review.md).

Ideas for a public gallery: [notes/ideas/theme-gallery.md](../../../notes/ideas/theme-gallery.md).
