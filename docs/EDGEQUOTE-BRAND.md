# EdgeQuote artwork and launcher

The shared mark is an emerald E with a quotation stroke on navy. Keep the mark's
proportions and its clear space; do not stretch it. The wordmark SVG remains
editable. Main colors: navy `#0b1120`, emerald `#34d399`, pale green `#a7f3d0`.

## Files

- `public/edgequote-logo.svg`: horizontal wordmark.
- `public/edgequote-dock.svg`: editable app icon.
- `public/edgequote-dock.icns`: macOS application icon.
- `public/edgequote-dock-{size}.png`: 16, 32, 64, 128, 192, 256, 512 and 1024 px.
- `public/apple-touch-icon.png`: opaque 180 px Apple touch icon.
- `public/icon-maskable.svg`: full-bleed icon with inset artwork for masking.

The web manifest includes 192 and 512 px PNG alternatives. The browser title,
install prompt and main interface use EdgeQuote. Business logos supplied by
operators remain their own branding.

## macOS launcher

For a packaged launcher, set its icon resource to `edgequote-dock.icns` using
the packager's icon setting and rebuild the app. For an existing launcher app,
open the 1024 px PNG in Preview, select all and copy. In Finder select the
launcher, choose Get Info, select the small icon at the top and paste. Remove
and re-add the launcher to the Dock if macOS keeps displaying the cached icon.

## Fonts and help

DM Sans and Syne are included under `src/app/fonts` with their SIL Open Font
Licenses. `next/font/local` loads them without a build-time Google Fonts request.

Standard page headers link to the existing Help Center using contextual article
anchors. Help content remains in `src/lib/help/content.ts`; add or update advice
there so search and contextual links share one source.
