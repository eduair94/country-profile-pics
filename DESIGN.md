# Design: The Register

Country Profile Pictures shares its design system with its sibling,
WhatsApp Number Checker. The full system is recorded there
([DESIGN.md](https://github.com/eduair94/whatsapp-scraping-tool/blob/master/DESIGN.md));
this page records how it lands here. The source of truth is `public/style.css`.

## The idea

A download is a roll call: every number ends with one result, and each result
has one drawn mark. Ink on a pale register tint, white sheets, and one thin red
margin rule down a list. Tick green and margin red are the only strong
colours; pencil grey carries everything secondary.

## Tokens

| Role | Light | Dark |
| --- | --- | --- |
| Ground (page) | `#eef5f1` | `#0f1826` |
| Sheet (panels, fields) | `#ffffff` | `#162235` |
| Wash (hover, selected tag) | `#f3f8f5` | `#1c2b42` |
| Ruling (borders, dividers) | `#d5e0da` | `#27374e` |
| Ink (text, primary button) | `#16233b` | `#e6edf3` |
| Soft ink (secondary text) | `#536070` | `#a3b3c5` |
| Pencil (field borders, quiet marks) | `#7a8794` | `#8193a8` |
| Tick green | `#1f8a5b` | `#4cc38a` |
| Margin red, failures | `#d64545` | `#f07070` |
| Link, focus | `#2a4884`, `#3b5b92` | `#9dbaf0`, `#86a8e7` |

Type is Figtree Variable only, bundled in `public/fonts` (no request leaves the
app for a font), with tabular figures: 1.625rem for the run's country, the one
headline of the page; 1.5rem figures; 1.0625rem section titles; 0.9375rem for
the app's name and the run's message; 0.875rem body; 0.8125rem small; 0.75rem
labels. Weights 400 to 700; no uppercase, no monospace, no letter-spacing on
labels. Dates read "16 Nov 2026" and times use the 24-hour clock.

Radii: 6px for controls, pictures and tags; 8px for sheets; 4px inside the
segmented control; 2px for the progress line. No shadows: sheets sit on the
ground by tone and a 1px ruling border.

## Parts

- **Marks.** Six signs drawn on a 16-unit grid with one round 2px stroke, as
  symbols in `index.html`: a tick (new picture, a finished run), a ticked ring
  (already saved), two linked rings (identical, linked), a cross (no longer
  public, remove a category), a bang (failed) and an open ring (a run that can
  go on). A mark always sits next to its words; only the tick and the bang
  take colour, and only once their count has a first result.
- **Run head.** The country's code in a ruled tab, its name as the headline,
  and Stop, Export CSV, Export ZIP and Open folder at the top right, all
  outlined: the form's Download pictures is the only ink-filled button. In a
  narrow panel the actions follow the totals. In demo mode a ruled "Demo data"
  label (label size, 4px corners) sits beside the name.
- **Totals.** The five results in one line, each figure led by its mark with
  its label under it; they wrap to three, then two, columns in a narrow panel.
  A 4px ink progress line follows while the run goes; when it ends the line
  becomes a bar of shares, one part per result in the totals' order (tick
  green, ink, pencil, pale pencil, red). Then what the run cost (requests used,
  requests left, size) as one line of plain facts.
- **Contact sheet.** The newest pictures as rounded squares on a white sheet,
  each with its number in download order and the masked phone number. Three
  across on phones. Previews are blurred until the person unticks the box.
- **Earlier runs.** A list on a sheet with a 2.75rem mark gutter and the red
  margin rule: a tick for a complete run, an open ring for one to continue.
  Each row carries the same bar of shares, then its state, date and cost.
- **One column.** Below 55rem the run sits under the form, so one register row
  above the form (mark, country, state) links to it.
- **Activity.** A sheet with the time in a margin column before the red rule.
- **Disclosures.** One drawn chevron (1.6px stroke) that turns when open.
- **Country tab.** The run's two-letter code in a ruled box beside its name.
- **Messages.** A tick or a bang and a sentence. Never a tinted box.
- **Controls.** Ink-filled primary button, ink-outlined secondary, a red
  outline for Stop, each with a pressed tone; fields with a pencil border that
  turns register blue on focus; the segmented control shows its choice in ink.

## Motion

A picture fades in once, in 200ms, when it is saved. Before the total is known,
the progress line breathes in place. Hover changes colour in 150ms, and a
chevron turns in 150ms. Nothing else moves, and all of it stops under reduced
motion.

## Do and don't

- Do give every result a mark and words together.
- Do keep pictures as rounded squares, never circles.
- Don't use pills, badges or coloured cards for results or counts.
- Don't add a second strong colour, a gradient, a shadow or an icon font.
- Don't draw a person, or the grey "no photo" silhouette, in demo mode.
