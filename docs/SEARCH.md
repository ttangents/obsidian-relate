# Searching with Relate

Relate's search understands your relationships. Ask for a project's notes, everything connected to a client last month, or every person who lives anywhere in a region, and it finds them. This page shows every phrase it knows.

Open search with the "Search notes" command, or with the search button in the relationship browser.

## Plain words

Type words, and Relate searches note titles and text. Plain word search works in any language.

Words also mix with every phrase below. `notes of Q3 Plan about pricing` finds the plan's notes that mention pricing. Outside a phrase, Relate skips small words such as "about", "the" and "of", so you can write the way you talk.

## Relationship phrases

Each of these finds the notes on the other side of a relationship. All three spellings mean the same thing:

- `children of Atlas`
- `Atlas's children`
- `children: Atlas`

Use the name of either side of a relationship. If your relationship is `project` ↔ `notes`, then `notes of Q3 Plan` lists the plan's notes, and `project of Pricing research` names the project the note belongs to.

| Phrase | What it finds |
|---|---|
| `all children of Atlas` | Follows chains, where the relationship allows it: children, their children, and so on |
| `connected to Acme` | Notes linked to Acme through any relationship |
| `without project` | Notes with no link at all in the `project` property |

## Narrow it down

| Phrase | What it keeps |
|---|---|
| `in Research/Notes` | Notes in that folder and its subfolders |
| `#draft` | Notes with that tag, or a tag nested under it |

## Dates

Relate reads the date you choose in its settings: date modified, date created, or a date property of your own.

| Phrase | Means |
|---|---|
| `today`, `yesterday` | Just that day |
| `this week`, `this month`, `this year` | From the start of the current week, month or year until now |
| `last week`, `last month`, `last year` | The whole previous calendar week, month or year |
| `past week`, `past month`, `past year` | The last 7, 30 or 365 days |
| `last 10 days`, `last 3 weeks` | That many days or weeks back from now |
| `in 2026-09` | September 2026 |
| `since 2026-01-01` | From that date on |
| `before 2026-06` | Up to the start of June 2026 |

## Put phrases together

Phrases combine and nest, so you can say quite a lot in one line:

- `notes of Q3 Plan last month` finds the plan's notes changed last month.
- `connected to Acme in Meetings #followup` finds Acme's meeting notes that still need a follow-up.
- `without project in Research/Notes` finds research notes that belong to no project yet.
- `residents of all places of Gondor` finds everyone whose home lies anywhere in Gondor, however many places deep.

## See how Relate reads your search

As you type, each phrase Relate understands turns into a small label, a chip, under the search box. Click a chip to switch it to another relationship, to follow or stop following chains, or to remove it.

When a result sits more than one link away from the note you named, Relate shows the chain under it, such as `Boromir → home: Minas Tirith → region: Gondor`. Each note in the chain is a link you can click.

## Link the results

Press Shift and Enter to link the results to a note. Uncheck any you want to leave out, choose the relationship and the note, and Relate links them all in one batch with one Undo. Search then opens again, so you can see the change.

For example, search `without project in Research/Notes`, link the results to a project, and watch them drop out of the list.

## Search by meaning

Turn on search by meaning in Relate's settings, or with "Turn on search by meaning", and the same box also finds notes about what you describe, even when they use different words. Those results say "similar in meaning". The [Relate guide](GUIDE.md#search-by-meaning) explains how it works and what it downloads.

## Good to know

- Relationship and date phrases are English only for now. Plain words work in any language.
- Search by meaning works best in English, the language the built-in model learned. A model on your own server can cover other languages.
- You can open a search from a link: `obsidian://relate?search=children%20of%20Atlas`.
