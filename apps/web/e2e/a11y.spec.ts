// A-DES-6: no axe violations (WCAG 2 A/AA) in night and daylight modes, and 44 px touch targets.
import { readFileSync } from "node:fs";
import { expect, test, useStandIns } from "./fixtures";

const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const PAGES = ["/signin", "/home", "/jobs", "/jobs/j1", "/jobs/j1/copilot", "/jobs/j1/closeout", "/devices", "/workshop/billing", "/workshop/licences"];

for (const theme of ["night", "daylight"] as const) {
  for (const path of PAGES) {
    test(`${theme} ${path}: no axe violations, 44 px targets`, async ({ page, context }) => {
      await useStandIns(context, { theme, signedIn: path !== "/signin" });
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () => {
        const w = window as unknown as { axe: { run: (ctx: Document, o: object) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } };
        const r = await w.axe.run(document, { runOnly: ["wcag2a", "wcag2aa"] });
        return r.violations.map((v) => `${v.id} (${v.nodes.length})`);
      });
      expect(violations).toEqual([]);

      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("button, a[href], select, summary, [role=button]")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height || el.closest(".sr-only") || el.classList.contains("sr-only")) return false;
            const style = getComputedStyle(el);
            // Links inside running text are exempt (WCAG 2.5.8 inline exception).
            if (el.tagName === "A" && style.display === "inline" && el.closest("p,li,td,dd")) return false;
            return r.height < 44 || r.width < 44;
          })
          .map((el) => `${el.tagName.toLowerCase()} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`),
      );
      expect(small).toEqual([]);
    });
  }
}
