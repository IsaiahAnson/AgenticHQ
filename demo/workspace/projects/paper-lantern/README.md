# paper-lantern

A small static site generator for blogs. Markdown in, plain HTML out, one theme folder per look. No client-side JavaScript unless a theme asks for it.

- Themes: [docs/themes.md](docs/themes.md)
- 0.9 plan: [docs/release-0.9.md](docs/release-0.9.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- Docs site content: [content/posts/hello-lantern.md](content/posts/hello-lantern.md)

## Use it

```
npm install
npx lantern build            # writes site/
npx lantern serve            # preview on http://localhost:4000
npx lantern new post "Title"
npm test
```

Jordan keeps the docs in shape. Theme reviews go through `/design-critique`; see the [theme review notes](../../notes/meetings/2026-10-14-paper-lantern-theme-review.md).
