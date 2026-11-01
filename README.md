# Watchbill Organizer

A static web page that builds fair 602 watchbills, keeps at least 12 hours of rest between watches, and prints one letter-landscape page per duty day.

- **Nothing leaves the device.** The roster, preferences, leads and history are saved in the browser, encrypted with the save code (Argon2id, then AES-GCM). The code itself is never stored, so the saved data can't be read without it. Losing the code means losing the data.
- **Backups.** Phone browsers can clear site data (iPhone Safari after about 7 days unused unless the page is on the Home Screen). Use Backup → Download now and then. The backup file is encrypted the same way.
- **No real data in this repo.** Tests and examples use made-up names.

## Run

```bash
npm install
npm test        # scheduler + encryption tests
npm run dev     # local dev server
npm run build   # static site in dist/ (works from any folder or host)
```

`dist/` can go on any static host (GitHub Pages, Cloudflare Pages, Netlify). The built page ships with a strict Content-Security-Policy: own files only, no third-party scripts, no network calls.

## Layout

- `src/scheduler.ts`: pure scheduling core (slot math, hard rules, generation, local search, violation checks). No DOM.
- `src/crypto.ts`, `src/storage.ts`: key derivation, encryption, IndexedDB store, backup files.
- `src/bill.ts`: printed page. `design-reference.html` is the static mockup it follows.
- `src/main.ts`: the screens.

## Rules

Slot = 4 × day + block. A person's watches are at least 3 slots apart (12 h). A 2-slot gap (6 h) only happens through an explicit double watch. Supers stand the whole duty day and are kept off regular watches that day and off the 2400-0600 just before it. When a watch can't be filled without breaking a rule, the app still fills it, marks it with "!" on the bill, and lists it under Warnings.
