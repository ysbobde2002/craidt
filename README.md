# craidt

## Cursor model tracker

Commits made through Cursor are counted by **model**, using a `Model:` trailer in the commit message. The chart below is regenerated from git history on every push to `main`.

![Commits by Cursor model](assets/model-tracker.svg)

Each mosaic square is one commit, colored by model. Gray / **Unattributed** commits have no `Model:` trailer (including human-authored ones).

### Required: name the model on every AI commit

Any AI model committing to this repo — including Cursor agents — **must** mention its name. Put it in the commit **body** as a git trailer, after a blank line:

```
Short summary of the change.

Optional body explaining why.

Model: Cursor Grok 4.6
```

Use your actual product name, not a generic label like "AI" or "Cursor Agent". Examples:

| Model | Trailer |
| --- | --- |
| Grok | `Model: Cursor Grok 4.6` |
| Claude | `Model: Claude 4 Sonnet` |
| GPT | `Model: GPT-5` |
| Composer | `Model: Composer` |
| Gemini | `Model: Gemini 2.5 Pro` |

Do not impersonate another model. Human commits may omit the trailer; they appear as **Unattributed**.

From a shell, the trailer looks like this:

```bash
git commit -m "$(cat <<'EOF'
Add the feature.

Model: Cursor Grok 4.6
EOF
)"
```

### Regenerating locally

```bash
node scripts/generate-model-tracker.mjs
```

That writes `assets/model-tracker.svg`. GitHub Actions runs the same command on push so the README chart stays current.
