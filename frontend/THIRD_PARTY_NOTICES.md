# Third-Party Notices

Meoi includes the following optional, locally served character-tracing components.
The production build emits the complete applicable license texts under
`third-party-licenses/`.

## Hanzi Writer

- Package: `hanzi-writer@3.7.3`
- Copyright: David Chanin and contributors
- License: MIT
- Source: <https://github.com/chanind/hanzi-writer>

## Hanzi Writer Chinese Data

- Package: `hanzi-writer-data@2.0.1`
- Data source: Make Me a Hanzi and Arphic Technology fonts
- License: Arphic Public License
- Source: <https://github.com/chanind/hanzi-writer-data>

## Hanzi Writer Japanese Data

- Package: `@k1low/hanzi-writer-data-jp@0.8.0`
- Data sources: animCJK, Make Me a Hanzi, subAnimJ, animNumber, Klee One, and Unihan
- Licenses: Arphic Public License, LGPL v3 or later, SIL Open Font License 1.1,
  and the Unicode data license
- Source: <https://github.com/k1LoW/hanzi-writer-data-jp>

The Japanese package is pinned to the exact version and npm integrity recorded in
`package-lock.json`. Character data is packaged with the application and is not
loaded from a third-party CDN at runtime.
