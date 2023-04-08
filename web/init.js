async function init() {
	const res = await fetch('/refresh-key');
	if (res.status === 401) {
		console.log('Redirecting to login')
		window.location.href = '/login'
	}
	else {
		console.log('Key refreshed')
	}
}

init();
