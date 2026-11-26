# RootCause Diagnostics — Design System (A-DES-5)

## Logo
- **Files:** `apps/web/public/brand/rootcause-wordmark.svg` (full wordmark, 960:440) and `rootcause-badge.svg` (square badge). Both are vector with text converted to outlines, so they need no fonts and stay sharp at any size.
- **Use:** wordmark on standalone pages (sign-in, sign-up); badge plus the product name in the app shell; badge as the favicon and app icon (`src/app/icon.svg`, `favicon.ico`, `apple-icon.png`). Components: `src/components/brand/Logo.tsx`.
- Both carry their own dark artwork, so they work in Night Cab and Daylight Glare without a variant.

## Visual Language (Autel MaxiSys Ultra-Inspired Industrial UI)
- **Palette (Night Cab / Workshop Dark Default):** Background `#0C0F14`, Panel `#151A22`, Raised Surface `#1D2430`, Border `#2A3342`, Autel Accent Red `#E0242F`, Diagnostic Blue `#2B7FFF`, Healthy `#10B981`, Caution `#F59E0B`.
- **Daylight Glare Mode:** High-luminance `#E6ECF3` / `#FFFFFF` surfaces with WCAG AA contrast for outdoor Australian fleet yards.
- **Typography:** Inter (UI labels) + JetBrains Mono (VINs, CAN IDs, DTCs, PIDs, battery voltage).

## Compliance Matrix (`docs/PLAN.md`)
- **A-DES-1 (Vehicle-Session Flow):** Connect (Pair) → Identify (AutoVIN) → Auto-Scan Topology → Session Overview (DTCs, Tamper Audit, Mark Actual Fix) → Live Data / CAN Studio / AI Copilot.
- **A-DES-3 (SafetyConfirmModal):** Names Action, Target ECU, and Consequence; displays live Tier A (`speed == 0 km/h <= 2s`) and Tier B (`RPM == 0`, `battery >= 12.5 V`) checks; enforces a **1.5 s hold-to-confirm** gesture.
- **A-DES-4 (AI Copilot):** Displays `HIGH`, `MEDIUM`, or `LOW` confidence bands with grounded Neo4j node IDs and resolved case IDs (no raw percentages).
- **A-DES-6 (Workshop Baseline):** Minimum `44px` (`48dp` on Android) touch targets, dark mode default, severity communicated via icon + text + color, full keyboard navigation.
- **A-DES-7 (CAN Studio):** Supports both 11-bit standard and 29-bit extended CAN frame IDs.
- **Rule 6 & Rule 7:** Unsupported checks report `INFO: not supported` (never Pass). SafetyMode uses `SILENT` or `ACTIVE_CONFIRMED` exclusively.
