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

//Prompt installation of PWA
window.addEventListener('beforeinstallprompt', (e) => {
	e.preventDefault();

	const el = document.getElementById('install');
	el.classList.remove('removed');
	el.addEventListener("click", async () => {
		//Show prompt, needs to be triggered by user action
		const res = await e.prompt();
		console.log(res)
		if (res.outcome === 'accepted') {
			el.classList.add('removed');
		}
	});
})
