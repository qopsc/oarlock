# Oarlock brand kit

Version 1.0, October 2026. Built from the approved 4B logo with the thicker octagonal O, diagonal oar, flat lower tip and subtly rounded corners.

Start with `brand-overview.png` and `guide/Oarlock-Brand-Guide.pdf`. All logo SVGs contain editable paths and shapes. Wordmarks are outlined, so the exported logos do not require an installed font or a network request.

## Files

| Folder | Contents |
| --- | --- |
| `logo/` | Symbol, wordmark, horizontal and stacked lockups in navy, silver, black and white. Each has SVG and transparent PNG exports. |
| `app/` | Desktop tiles, a light tile, a full-bleed mobile source and sizes from 16 to 1024 px. |
| `app/platforms/` | Tauri-generated macOS ICNS, Windows ICO and Store assets, Linux PNGs, iOS icons and Android adaptive, round and monochrome assets. |
| `web/` | SVG, PNG and ICO favicons, Apple touch icon, 192/512 px icons and a sample web app manifest. |
| `social/` | 1200 x 630 social card and 1280 x 640 repository card, each in SVG and PNG. |
| `tokens/` | Color and typography tokens in CSS and JSON. These do not load fonts. |
| `guide/` | Eight-page PDF guide plus editable outlined SVG pages and high-resolution page exports. |
| `source/` | Canonical mark and wordmark SVGs, geometry, export scripts and font license. |
| `reference/` | The approved image used to reconstruct the production artwork. |

## Logo use

Use silver or white on navy, and navy or black on light backgrounds. Keep at least one oar-shaft width of clear space around the visible artwork. The horizontal lockups already include padding.

Use the standalone mark at 24 px or larger and the horizontal lockup at 140 px or larger. A 16 px rendition is supplied specifically for favicons. Preserve the original aspect ratio, diagonal angle, ring gaps, terminal-shaped blade cutout and flat oar endpoint. Keep the symbol and wordmark the same color. Do not add outlines, gradients, shadows or glow.

The vector is a geometric reconstruction of the approved image. The consistent production wordmark uses Satoshi Black, selected to match the approved geometric lettering. The earlier image-generated mockup did not identify a specific font.

## Color

| Color | Hex | Role |
| --- | --- | --- |
| Navy | `#15222F` | Primary brand surface and light-background artwork |
| Silver | `#E9EEF3` | Primary artwork and text on navy |
| Steel | `#C9D6E2` | Supporting copy and secondary elements on dark surfaces |
| Night | `#0B141D` | Deeper backgrounds |
| White | `#FFFFFF` | Light surfaces and one-color reverse artwork |

Do not use Steel for body text on white. Brand color tokens are an identity palette, not a replacement for the terminal's configurable themes or semantic UI colors.

## Typography

- Wordmark: the supplied Satoshi Black outlines. Use these assets rather than retyping the logo.
- Brand headlines: Satoshi Black or Bold; supporting brand copy: Satoshi Regular or Medium.
- Product UI and long reading: the existing Inter family.
- Terminal output and code: the existing JetBrains Mono family.

Obtain Satoshi directly from [Fontshare](https://www.fontshare.com/fonts/satoshi). Font binaries are not redistributed in this kit. `source/Satoshi-license.txt` is the unmodified license included with the official download; Satoshi remains subject to that license, separately from the project's code license. The outlined logo artwork is ready to use without downloading the font.

## Positioning and language

Primary brand line: **Your agents. Your machines. Your direction.**

Current product descriptor: **An open-source, AI-native terminal for developers.**

Long-term vision: **A self-hosted workbench for running coding agents in sandboxes on machines you own, accessible from desktop, mobile and command-line clients.**

The identity ties the directional oar to an open workspace boundary and a terminal-shaped cutout. Its nautical idea is a stable pivot for movement and control. Do not position Oarlock primarily as a security or password-management product.

Write in concrete, capable, approachable language. Focus on direct control, tool choice, ownership and useful work. Describe remote sandboxes, cross-machine coordination and mobile clients as future vision until those capabilities are available. Mention specific agent support only when it is implemented and verified.

## Integration handoff

For the current desktop app, the prepared replacements map as follows:

| Existing destination | Brand-kit source |
| --- | --- |
| `public/logo.png` | `app/icon-512.png` |
| `oarlock-icon.svg` | `app/icon.svg` |
| `oarlock-icon.png` | `app/icon-1024.png` |
| `src-tauri/icons/` desktop files | Matching files in `app/platforms/` |

Use the `web/` files for a website. The sample manifest assumes the icons and manifest are served from the site root; change its URLs and scope to match the deployment. The guide's browser and mobile examples are brand applications, not claims of released clients.

## Rebuild

The SVG masters are sufficient for ordinary editing and export. The scripts provide a repeatable complete export using Bun, the project's existing `harfbuzzjs` development dependency, a separately available Sharp module, and ReportLab for the PDF. They introduce no app dependency.

1. Download Satoshi from its official Fontshare page. Place the official static `Satoshi-Black.ttf`, `Satoshi-Bold.ttf`, `Satoshi-Medium.ttf`, `Satoshi-Regular.ttf` and `FFL.txt` in a local folder.
2. Run `bun branding/source/build.mjs <font-folder> <absolute-sharp-module-entry>`. An optional final path supplies a replacement approved reference image.
3. Run `python3 branding/source/build-guide.py` with ReportLab available.
4. Run `bun run tauri icon branding/app/icon-manifest.json --output branding/app/platforms`.
5. Run `bun branding/source/finalize-icons.mjs <absolute-sharp-module-entry>` to remove the iOS alpha channel after platform generation.
6. Run `magick branding/web/favicon-16.png branding/web/favicon-32.png branding/web/favicon-48.png branding/web/favicon.ico`.

All typography on the guide pages and social cards is outlined. Keep font binaries local and consult their license before redistribution or modification.
