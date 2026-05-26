import { scrubSensitiveText } from "./cursor-sensitive-text.mjs";

export function createScriptFail(prefix) {
	return (message, secrets = []) => {
		const secretList = Array.isArray(secrets) ? secrets : [secrets];
		let scrubbed = message;
		for (const secret of secretList) {
			if (secret) scrubbed = scrubSensitiveText(scrubbed, secret);
		}
		console.error(`${prefix}: ${scrubbed}`);
		process.exit(1);
	};
}
