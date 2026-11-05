# Fast Label printing

Browser extension for printing labels (ZPL) on Zebra printers – filled automatically from I-Doit (and soon Netbox) or manually.

## 📥 Download

### Firefox
- **Stable:** [Download from GitHub Pages](https://jszeibert.github.io/fast-label-printing/)
- **Latest:** [Download from GitHub Releases](https://github.com/jszeibert/fast-label-printing/releases/latest)

### Chrome/Edge
- **Latest:** [Download ZIP from GitHub Releases](https://github.com/jszeibert/fast-label-printing/releases/latest)

## 🚀 Installation

### Firefox
1. Download the `.xpi` file
2. Open Firefox → `about:addons`
3. Click gear icon → "Install Add-on From File..."
4. Select the downloaded `.xpi` file

### Chrome/Edge
1. Download and extract the `.zip` file
2. Open Chrome → `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" → select extracted folder

## ✨ Features

- **Printers**: any number of Zebra printers (URL, resolution, print method, darkness, speed)
- **Label types**: physical labels (size, shape, media, sensing, offsets) – `^PW`/`^LL` are generated
- **Templates**: ZPL with `{{field}}` placeholders; fields become inputs in the popup
- **Label jobs**: template + printer + optional website trigger + extraction rules
- **Manual jobs**: jobs without website are always selectable in the popup
- **Manual text**: entries are saved per manual label and remain until cleared with the popup's clear button
- **Import / Export** of the whole configuration as JSON
- Settings from v2 are migrated automatically

## 🔧 Configuration

Everything is configured in the options page (tabs *Drucker*, *Labeltypen*, *Templates*, *Labeldrucke*, *Import / Export*).

### Extraction rules

A label job extracts field values from the current page. Rules are evaluated top to bottom:

```json
{
  "url":   { "from": "const", "value": "https://idoit.example.com" },
  "id":    { "from": "urlParam", "name": "objID" },
  "type":  { "from": "title", "split": " > ", "index": 1,
             "post": [{ "op": "replace", "search": "Development", "replace": "Dev" }] },
  "name":  { "from": "title", "split": " > ", "index": 2 },
  "line1": { "from": "field", "field": "name", "post": [{ "op": "line", "maxChars": 11, "line": 1 }] }
}
```

Sources: `const`, `urlParam`, `urlRegex`, `title`, `field`, `template` (e.g. `"{{url}}/?objID={{id}}"`),
and – evaluated inside the page with the user's logged-in session – `css` (`selector`, `attr`) and
`api` (`url` with `{{field}}` placeholders, JSON `path`, e.g. Netbox `/api/dcim/devices/{{id}}/` → `role.name`).
Post ops: `trim`, `upper`, `lower`, `replace`, `line`.
A job only triggers on its website (URL prefix); *URL contains* / *regex* narrow it down further.

### Default configuration

- Label jobs: *I-Doit Inventarlabel*, *Netbox Inventarlabel* (both use the template *Inventarlabel (QR)*),
  *Inventarlabel (manuell)*, *Textlabel 75×50 mm (manuell)*
- Label types: inventory label 24×14 mm, Dymo S0722540 57×32 mm, Dymo 14681 round Ø57 mm
- A default label job (tab *Allgemein*) is preselected when no job matches the current page

## 📖 Usage

1. Open a page (e.g. an I-Doit object) and click the extension icon
2. Pick a label job (matching jobs first, then manual ones) – fields are pre-filled
3. Adjust fields, printer and copies, then click "Drucken"

## 🔄 Updates

- **Firefox**: Automatic updates via GitHub Pages
- **Chrome**: Manual updates from GitHub Releases

## 🛠️ Development

### Local Development
```bash
git clone https://github.com/jszeibert/fast-label-printing.git
```

**Firefox:**
1. Open `about:debugging`
2. "Load Temporary Add-on" → select `src/manifest.json`

**Chrome:**
1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. "Load unpacked" → select `src/` folder

### Tests
```bash
node --test
```

### Release Process
1. Update version in `src/manifest.json`
2. Commit and push to main branch
3. GitHub Actions automatically builds and releases

## 📁 Project Structure

```
├── src/
│   ├── manifest.json       # Extension manifest (Firefox + Chrome compatible)
│   ├── popup/             # Extension popup UI
│   ├── options/           # Settings page
│   ├── lib/               # Data model, ZPL compiler, extraction (pure, unit-tested)
│   └── icons/             # Extension icons
├── test/                  # node:test unit tests
└── .github/workflows/     # Automated builds
```

## 🔑 Permissions

- **Storage**: Save extension settings
- **Active Tab / Scripting**: Read the current page (URL, title, `css`/`api` extraction rules)
- **Host Permissions**: Send ZPL to the printers

## 📄 License

MIT