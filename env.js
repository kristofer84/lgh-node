import { readFileSync } from 'fs';

//Minimal .env loader. process.loadEnvFile() would do this, but it needs Node
//>= 20.12 and this app runs on Node 18 in production -- see docs.
//
//Quoting matters. This parser only treats ' #' (space then hash) as the start
//of a trailing comment, so an unquoted 'abc#def' survives here -- but common
//dotenv implementations DO cut at a bare '#'. Always quote a value containing
//'#' (the cookie secret does) so it stays correct whichever loader reads it.
export function loadEnv(file = './.env') {
	let content;
	try {
		content = readFileSync(file, 'utf8');
	} catch {
		console.log(`WARN: no ${file} found; copy .env.example to .env`);
		return;
	}

	for (const rawLine of content.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) continue;

		const eq = line.indexOf('=');
		if (eq === -1) continue;

		const key = line.slice(0, eq).trim();
		if (!key) continue;

		let value = line.slice(eq + 1).trim();

		const quote = value[0];
		if (quote === '"' || quote === "'") {
			const end = value.lastIndexOf(quote);
			//Quoted: take it verbatim, '#' and all
			value = end > 0 ? value.slice(1, end) : value.slice(1);
		}
		else {
			//Unquoted: strip a trailing comment
			const hash = value.indexOf(' #');
			if (hash !== -1) value = value.slice(0, hash).trim();
		}

		//Real environment variables win over the file
		if (process.env[key] === undefined) process.env[key] = value;
	}
}
