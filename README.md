# Law Flashcards

Flashcard study site for Administrative Law, Professional Responsibility, and Business Associations.
It's a plain static site (no build step) hosted on GitHub Pages.

## Studying

- Pick a class, optionally filter by Part, Type (Case, Doctrine, Test, Statute) or Topic, then hit **Study**.
- Flip a card with a tap or **Space**. Mark it **Got it** (`2` / →) or **Again** (`1` / ←). "Again" cards come back a few cards later in the same session.
- "Not yet known" studies everything you haven't marked Got it; "Still learning" studies only cards you've missed.
- **Browse & search** lists every card with a search box.
- Progress is saved in your browser (per device), so it'll be separate on your phone and laptop.

## Adding a deck

Decks live in `decks/`. Professional Responsibility and Business Associations are already set up, so you only need to upload the file:

| Class | File name |
| --- | --- |
| Administrative Law | `decks/admin-law.csv` |
| Professional Responsibility | `decks/professional-responsibility.csv` |
| Business Associations | `decks/business-associations.csv` |

On GitHub: open the `decks` folder → **Add file → Upload files** → drop the CSV (renamed to match) → **Commit changes**. The site updates within a minute or two.

### CSV format

Three columns, no header needed: `front, back, tags`.

- The back can contain HTML (`<strong>`, `<em>`, `<ul><li>`…).
- Tags are space-separated. A tag starting with `Part` becomes a Part filter; `Case`, `Doctrine`, `Test`, `Statute`, `Rule` become Type filters; everything else is a Topic. Use `_` for spaces (`Conflicts_of_interest`).
- An Anki export (**File → Export → Notes in Plain Text**, with "Include HTML" and "Include tags" checked) works as-is.

To add a whole new class, add an entry to `decks/decks.json` and its CSV.

## Running locally

```sh
python3 -m http.server
# open http://localhost:8000
```
