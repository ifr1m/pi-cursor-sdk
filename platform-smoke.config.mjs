// Platform smoke configuration for pi-cursor-sdk.
// Reusable across pi extensions: change package name, model IDs, scenarios, and card matrix only.

export default {
	packageName: "pi-cursor-sdk",
	cursorModel: "cursor/composer-2-5",
	artifactRoot: ".artifacts/platform-smoke",
	requiredTargets: ["macos", "ubuntu", "windows-native"],
	requiredSuites: [
		"platform-build",
		"cursor-native-visual-matrix",
		"cursor-bridge-visual-matrix",
		"cursor-abort-cleanup",
	],
	requiredCrabbox: {
		install: "brew install crabbox",
		version: "0.24.0",
	},
	ubuntuContainerImage: "cimg/node:24.16",
	nodeValidationMajor: 24,
};
