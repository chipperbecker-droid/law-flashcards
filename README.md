# Law Flashcards

Flashcard study site for Administrative Law, Professional Responsibility, and Business Associations.
It's a plain static site (no build step) hosted on GitHub Pages.

## Studying

- Pick a class on the home page. Use the dropdown on the class page to narrow to one topic, part or card type.
- **Flashcards:** tap a card to flip it. Swipe right (or tap **Know it**) if you knew it, swipe left (or **Still learning**) if not. Undo with the round arrow. On a computer: Space flips, → know it, ← still learning, Z undo.
- **Quiz:** 10 multiple-choice questions, weighted toward cards you haven't mastered.
- **Review missed:** flashcards for only the cards you marked Still learning.
- Progress is saved in your browser (per device), so your phone and laptop track separately.

## Adding a deck

Decks live in `decks/`. Professional Responsibility and Business Associations are already set up, so you only need to upload the file:

| Class | File name |
| --- | --- |
| Administrative Law | `decks/admin-law.csv` |
| Professional Responsibility | `decks/professional-responsibility.csv` |
| Business Associations | `decks/business-associations.csv` |

On GitHub: open the `decks` folder → **Add file → Upload files** → drop the CSV (renamed to match) → **Commit changes**. The site updates within a minute or two.

### CSV format

Three columns, no header needed: `front, back, tags`. A header row like `Front,Back,Topic,Type` also works (Part, Topic, Type and Tags columns are recognized).

- The back can contain HTML (`<strong>`, `<em>`, `<ul><li>`…).
- Tags are space-separated. A tag starting with `Part` becomes a Part filter; `Case`, `Doctrine`, `Test`, `Statute`, `Rule` become Type filters; everything else is a Topic. Use `_` for spaces (`Conflicts_of_interest`).
- An Anki export (**File → Export → Notes in Plain Text**, with "Include HTML" and "Include tags" checked) works as-is.

To add a whole new class, add an entry to `decks/decks.json` and its CSV.

## Running locally

```sh
python3 -m http.server
# open http://localhost:8000
```
