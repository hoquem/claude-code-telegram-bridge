"""Render captured terminal output as an SVG, in the colours the wizard uses."""
import html, re, sys

src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(src).read().rstrip("\n").split("\n")

# Cosmetic only: the capture ran under an isolated temp HOME.
lines = [re.sub(r"/var/folders/\S+?/wizard-e2e-\w+", "/Users/you", l) for l in lines]
lines = [l.replace("test_bot", "your_bot").replace("(Test Bot)", "(Your Assistant)") for l in lines]
lines = [l for l in lines if "Reading answers from stdin" not in l]

FG, BG = "#c9d1d9", "#0d1117"
GREEN, YELLOW, BLUE, DIM, WHITE = "#3fb950", "#d29922", "#58a6ff", "#6e7681", "#f0f6fc"
CH, PAD, TOP = 17.5, 26, 44
CW = 8.42

def spans(line):
    """Colour a line the way the wizard does on a real terminal."""
    if re.match(r"^\[\d/6\]", line):
        return [(line, WHITE, "bold")]
    if re.match(r"^\s*✓", line):
        i = line.index("✓")
        return [(line[:i], FG, ""), ("✓", GREEN, "bold"), (line[i+1:], FG, "")]
    if re.match(r"^\s*!", line):
        i = line.index("!")
        return [(line[:i], FG, ""), ("!", YELLOW, "bold"), (line[i+1:], FG, "")]
    if line.strip().startswith("Claude Code Telegram Bridge"):
        return [(line, WHITE, "bold")]
    if line.strip() in ("Ready.",):
        return [(line, GREEN, "bold")]
    if re.search(r"\[(Y/n|y/N)\]:|:\s*$|token:|name:|directory|Timezone", line):
        return [(line, BLUE, "")]
    if line.startswith("  ") and not line.startswith("    "):
        return [(line, FG, "")]
    return [(line, DIM, "")]

W = 920
H = TOP + PAD * 2 + CH * len(lines)
out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{int(H)}" viewBox="0 0 {W} {int(H)}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12.5">']
out.append(f'<rect width="{W}" height="{int(H)}" rx="10" fill="{BG}"/>')
out.append(f'<rect width="{W}" height="{TOP}" rx="10" fill="#161b22"/><rect y="{TOP-10}" width="{W}" height="10" fill="#161b22"/>')
for i, c in enumerate(("#ff5f57", "#febc2e", "#28c840")):
    out.append(f'<circle cx="{22+i*20}" cy="22" r="6" fill="{c}"/>')
out.append(f'<text x="{W/2}" y="26" fill="{DIM}" text-anchor="middle" font-size="12">{html.escape(title)}</text>')

y = TOP + PAD
for line in lines:
    x = PAD
    for text, colour, weight in spans(line):
        if text:
            w = ' font-weight="bold"' if weight else ""
            out.append(f'<text x="{x:.1f}" y="{y:.1f}" fill="{colour}"{w} xml:space="preserve">{html.escape(text)}</text>')
            x += len(text) * CW
    y += CH
out.append("</svg>")
open(dst, "w").write("\n".join(out))
print(f"{dst}: {len(lines)} lines, {W}x{int(H)}")
