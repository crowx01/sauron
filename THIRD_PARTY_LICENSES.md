# Third-party licenses

This repository redistributes source code from the following third-party projects.
Their original licenses are preserved and copied below verbatim.

## review-skills (skills/debate-review, skills/babysit-pr)

- Upstream: https://github.com/amElnagdy/review-skills
- Author: Ahmed Mohammed (amElnagdy)
- License: MIT
- Notice:

```
MIT License

Copyright (c) 2026 Ahmed Mohammed (amElnagdy)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```

## Referenced, not redistributed

No code from these projects is vendored into this repository; `setup.sh` and the README
only point at them, and you install them yourself.

- **caveman** — https://github.com/JuliusBrussee/caveman — the `caveman` skill that the
  generated hooks auto-load. Dual-licensed: its `skills/` tree is MIT, while the Engine
  directories (`engine/`, `proxy/`, `rewriter/`, `browse/`, `mcp/`, `shrink/`, the cavemem
  Go core and `shared/platform/`) are Business Source License 1.1, with a Change Date of
  2030-06-21 and Apache-2.0 as the change license. BSL-1.1 permits self-hosted use for
  your own first-party traffic but not offering the functionality to third parties as a
  hosted, managed or embedded service. Only the MIT `skills/caveman` directory is needed
  here.
- **Pentesting-Agent-new** — https://github.com/Darxbloo/Pentesting-Agent-new — the offensive-security knowledge base supplying
  `pentesting-agent`, `validator`, `pentest-learn`, `pentest-debrief`, `agents/pentester.md` and
  40 vulnerability-category skills that the generated hook auto-loads. **It currently carries no
  LICENSE file**, so third parties have no grant to use it; if it is to be a documented
  prerequisite for sauron, it needs one. Its own `SOURCES.md` records its upstream provenance
  (crowx01/Pentesting-Skills, h0tak88r/Sec-88, and a review of disclosed HackerOne reports).
- **pal-mcp-server** (formerly zen-mcp-server) — https://github.com/BeehiveInnovations/zen-mcp-server
  — the MCP server that serves the PAL tools. Apache-2.0.
