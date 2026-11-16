# Country Profile Pictures

## What it is

A desktop app (Windows, macOS, Linux), a local web page and a command line that
download every stored profile picture matching a set of filters from the WP Data
API, for one country or all of them, with a CSV of every field.

## Who uses it

1. Researchers and analysts building a picture set for one country.
2. Marketing teams who want the pictures and business details of a segment.
3. Developers who want a working example of walking the search API with a cursor.

They start a download that can run for hours, leave, and come back to export.

## What it promises

- **Fewest requests.** About one search request per 500 numbers; the pictures
  themselves come from the public image server.
- **Nothing twice.** A picture already on disk is skipped; identical pictures are
  stored once and linked.
- **Stop and continue.** A run picks up exactly where it stopped, and a finished
  run fetches only what is new.
- **The key is a secret.** Stored encrypted by the system, sent only to the API.
- **A non-developer can finish the job.**

## What it refuses

- No filter by ethnicity, and no age range that ends below 18.
- Demo mode shows drawn pictures only: never a person, never the grey
  "no photo" silhouette.
- No WhatsApp logo; the app says it is not affiliated with WhatsApp or Meta.

## Brand

A sibling of [WhatsApp Number Checker](https://github.com/eduair94/whatsapp-scraping-tool)
and it looks like one: the same design system, The Register (see DESIGN.md).
Light and dark follow the system.
