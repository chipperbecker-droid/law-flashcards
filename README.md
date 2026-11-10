# Issue Spotter

Exam-prep site for Administrative Law, Professional Responsibility, and Business Associations, built around how issue-spotter exams are graded: spot the issue from the facts, state the rule with its elements, apply, and cover the exceptions.
It's a plain static site (no build step) hosted on GitHub Pages.

## Studying

- Each class opens on its **attack outline**: topics in course order, each issue with the facts that trigger it, the rule, numbered elements, exceptions and limits, the authorities, and an exam tip. Tick **Hide rules until tapped** to self-test, or **Print** for a paper copy. **Study only this topic** scopes every mode below to that topic.
- **Drill rules:** you see the issue and its triggering facts; say the rule and elements out loud, reveal, and grade yourself Blank / Shaky / Solid. Weak issues come first next time. Keys: Space reveal, 1–3 grade.
- **Spot issues:** you see only the facts and pick which issue they raise from four choices, then the rule appears. Missed issues are marked shaky in the outline.
- **Flashcards:** the original decks. Tap to flip, swipe right (**Know it**) or left (**Still learning**), undo with the arrow. The back of each card links to the rule it belongs to. Keys: Space flip, → know it, ← still learning, Z undo.
- **Quiz:** 10 multiple-choice questions over the cards, weighted toward ones you haven't mastered. **Review missed** replays the cards you marked Still learning.
- Progress is saved in your browser (per device), so your phone and laptop track separately.

## Issue maps

Each class has an issue map at `decks/<class>.issues.json`: `topics[]`, each with `name`, optional `part`, `tags` (the card tags that belong to the topic), and `issues[]`. An issue has `id`, `name`, `trigger`, `rule`, `elements[]`, `exceptions[]`, `authorities[]`, and `tip`. Edit the JSON to change a rule or add an issue; cards are linked to issues automatically by their topic tag and the case names they mention.

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
- Tags are space-separated. A tag starting with `Part` becomes a Part filter; `Case`, `Doctrine`, `Test`, `Statute`, `Rule`, `List`, `Hypo`, `Why`, `Compare` become card-type filters; everything else is a Topic. Use `_` for spaces (`Conflicts_of_interest`). Anki tags like `BA::Agency` show as `Agency`.
- An Anki export (**File → Export → Notes in Plain Text**, with "Include HTML" and "Include tags" checked) works as-is.

To add a whole new class, add an entry to `decks/decks.json` and its CSV.

## Running locally

```sh
python3 -m http.server
# open http://localhost:8000
```
