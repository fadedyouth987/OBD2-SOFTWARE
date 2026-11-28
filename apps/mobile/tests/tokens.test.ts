import { readFileSync } from "node:fs";
import { join } from "node:path";
import { color, CSS_VAR } from "../src/ui/tokens";

// The app's own screens use the web's design tokens. This fails if either side
// changes a colour without the other.
describe("design tokens match the web", () => {
  const css = readFileSync(join(__dirname, "../../web/src/app/globals.css"), "utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const [key, cssVar] of Object.entries(CSS_VAR)) {
    it(`${key} is ${cssVar}`, () => {
      const m = root.match(new RegExp(`${cssVar}:\\s*(#[0-9a-fA-F]{6})`));
      expect(m?.[1]?.toLowerCase()).toBe(color[key as keyof typeof color]);
    });
  }
});
