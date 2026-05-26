import { scrubSensitiveText } from "./cursor-sensitive-text.mjs";

export function createScriptFail(prefix) {
	return (message, secrets = []) => {
		const secret = Array.isArray(secrets) ? secrets[0] : secrets;
		const scrubbed = scrubSensitiveText(message, secret);
		console.error(`${prefix}: ${scrubbed}`);
		process.exit(1);
	};
}
