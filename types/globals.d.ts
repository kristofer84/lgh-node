// Ambient declarations for things that exist at runtime but that tsc cannot see.
// Type checking only -- nothing here is loaded by the app.

// jQuery and socket.io are loaded by <script> tags in dashboard.html, so they
// are globals with no import to follow. `any` on purpose: @types/jquery is a
// large dependency for the handful of calls home.js makes, and every one of
// them is a selector, .click(), .is(':checked') or .html().
declare const $: any;
declare const io: any;

interface Number {
	// home.js defines this on the prototype itself (line ~91). A prototype
	// extension is invisible to tsc, so it has to be declared.
	pad(size?: number): string;
}

interface Date {
	// Removed from TypeScript's DOM lib as deprecated, but still implemented by
	// every browser -- and web/scripts/home.js uses it to build a cookie expiry.
	toGMTString(): string;
}
