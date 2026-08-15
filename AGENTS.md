# Agent instructions

## Reference context

Always treat these local clones as read-only product context (do not push them):

- `.context/midnightx402` — https://github.com/dhru7777/midnightx402
- `.context/ACP-demo` — https://github.com/dhru7777/ACP-demo

See `.cursor/rules/reference-repos.mdc`.

When committing to this repository, AI models **must** add a git trailer naming themselves:

```
Model: <your product name>
```

Use the name you identify as (for example `Cursor Grok 4.6`), on its own line in the commit body. See the README for the full convention. The SVG at `assets/model-pie.svg` is generated from these trailers.
