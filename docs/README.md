# Documentation assets

`setup-wizard.png` is a real run of `npm run init`, captured by
`capture-wizard-shot.mjs` against the same fake Telegram the end-to-end test
uses, and typeset by `render-terminal.py`. It is genuine output rather than a
mockup, so it cannot drift from what the wizard actually prints.

The only post-processing is cosmetic: the temporary HOME the capture runs
under is rewritten to `/Users/you`, and the answers are echoed into the
transcript where an interactive terminal would show them but a pipe does not.

To regenerate after changing the wizard:

```bash
node docs/capture-wizard-shot.mjs          # writes /tmp/wizard-real.txt
python3 docs/render-terminal.py /tmp/wizard-real.txt docs/setup-wizard.svg "npm run init"
rsvg-convert -w 1840 docs/setup-wizard.svg -o docs/setup-wizard.png
```
