import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
};

const PI_PACKAGES = [
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
] as const;

describe("package metadata cutover baselines", () => {
	it("pins Cursor SDK exactly and validates against pi 0.79.4", () => {
		expect(packageJson.dependencies["@cursor/sdk"]).toBe("1.0.18");
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.devDependencies[packageName]).toBe("0.79.4");
		}
	});

	it("keeps @earendil-works peer dependency ranges unpinned per pi package guidance", () => {
		for (const packageName of PI_PACKAGES) {
			expect(packageJson.peerDependencies[packageName]).toBe("*");
		}
	});
});
